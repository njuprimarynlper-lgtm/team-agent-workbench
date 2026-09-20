import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { ensureEgressCertificate } from '../src/admin/egress-certificate';
import { EgressClientProxy, EgressRelay, providerForHost } from '../src/core/egress';
import { decodeEgressInvite, encodeEgressInvite } from '../src/core/egress-config';
import type { AdminEgressConfig } from '../src/shared/egress';

function listen(server: net.Server) { return new Promise<number>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)); }); }
function close(server: net.Server) { return new Promise<void>(resolve => server.close(() => resolve())); }
function readUntil(socket: net.Socket, marker: string, timeout = 10000) {
  return new Promise<Buffer>((resolve, reject) => {
    let buffer = Buffer.alloc(0); const timer = setTimeout(() => done(new Error('read timeout')), timeout);
    const done = (error?: Error) => { clearTimeout(timer); socket.off('data', data); socket.off('error', done); error ? reject(error) : resolve(buffer); };
    const data = (chunk: Buffer | string) => { buffer = Buffer.concat([buffer, Buffer.from(chunk)]); if (buffer.includes(marker)) done(); };
    socket.on('data', data); socket.once('error', done);
  });
}

test('network exit invite parsing and provider allowlist are strict', () => {
  const invite = { version: 1 as const, host: 'admin.internal', port: 18443, fingerprint: 'AB'.repeat(32), accessCode: 'x'.repeat(24) };
  assert.deepEqual(decodeEgressInvite(encodeEgressInvite(invite)), invite);
  assert.equal(providerForHost('chatgpt.com'), 'codex'); assert.equal(providerForHost('api.openai.com'), 'codex');
  assert.equal(providerForHost('api2.cursor.sh'), 'cursor'); assert.equal(providerForHost('cursor.sh.evil.test'), undefined); assert.equal(providerForHost('example.com'), undefined);
  assert.throws(() => decodeEgressInvite('bad'), /接入码/);
});

test('optional user proxy tunnels allowlisted CLI traffic, rejects other hosts and pins the admin certificate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-egress-'));
  const upstreamSockets = new Set<net.Socket>();
  const upstream = net.createServer(socket => {
    upstreamSockets.add(socket); socket.once('close', () => upstreamSockets.delete(socket));
    let buffer = Buffer.alloc(0), connected = false;
    socket.on('data', chunk => {
      if (connected) { socket.write(chunk); return; }
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]); const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      const request = buffer.subarray(0, end).toString('latin1');
      assert.match(request, /^CONNECT chatgpt\.com:443 HTTP\/1\.1/); assert.match(request, /Proxy-Authorization: Basic dXBzdHJlYW0tcHJveHk6c2VjcmV0/); connected = true; socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = buffer.subarray(end + 4); if (rest.length) socket.write(rest);
    });
  });
  const blocker = net.createServer(), upstreamPort = await listen(upstream), relayPort = await listen(blocker); await close(blocker);
  const certificate = await ensureEgressCertificate(path.join(root, 'tls'));
  const config: AdminEgressConfig = { enabled: true, listenHost: '127.0.0.1', listenPort: relayPort, publicHost: '127.0.0.1', upstreamMode: 'http', upstreamHost: '127.0.0.1', upstreamPort, upstreamUsername: 'upstream-proxy', codex: true, cursor: true };
  const relay = new EgressRelay(config, { accessCode: 'test-access-code-that-is-long', upstreamPassword: 'secret' }, certificate);
  const client = new EgressClientProxy({ enabled: true, host: '127.0.0.1', port: relayPort, certificateFingerprint: certificate.fingerprint, accessCode: 'test-access-code-that-is-long', username: 'alice' });
  try {
    await relay.start(); await client.start(); await client.probe();
    assert.equal(client.status().available, true); const env = client.environment(); assert.match(env.HTTPS_PROXY || '', /^http:\/\/127\.0\.0\.1:\d+$/); assert.equal(env.NODE_USE_ENV_PROXY, '1');
    const localPort = Number(new URL(env.HTTPS_PROXY!).port), socket = net.connect(localPort, '127.0.0.1'); await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.write('CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n'); assert.match((await readUntil(socket, '\r\n\r\n')).toString(), /200 Connection Established/);
    socket.write('relay-roundtrip'); assert.equal((await readUntil(socket, 'relay-roundtrip')).subarray(-15).toString(), 'relay-roundtrip'); socket.destroy();
    const denied = net.connect(localPort, '127.0.0.1'); await new Promise<void>((resolve, reject) => { denied.once('connect', resolve); denied.once('error', reject); }); denied.write('CONNECT example.com:443 HTTP/1.1\r\n\r\n'); assert.match((await readUntil(denied, '\r\n\r\n')).toString(), /502 Bad Gateway/); denied.destroy();
    const wrong = new EgressClientProxy({ enabled: true, host: '127.0.0.1', port: relayPort, certificateFingerprint: '00'.repeat(32), accessCode: 'test-access-code-that-is-long', username: 'alice' });
    await wrong.start(); await assert.rejects(wrong.probe(), /身份不匹配/); await wrong.stop();
    const deniedCode = new EgressClientProxy({ enabled: true, host: '127.0.0.1', port: relayPort, certificateFingerprint: certificate.fingerprint, accessCode: 'wrong-access-code-that-is-long', username: 'alice' });
    await deniedCode.start(); await assert.rejects(deniedCode.probe(), /接入码无效/); await deniedCode.stop();
    assert(relay.snapshot().events.some(event => event.username === 'alice' && event.provider === 'codex'));
    await client.configure(undefined); assert.deepEqual(client.environment(), {}); assert.equal(client.status().detail, '使用本机网络直连');
  } finally { await client.stop(); await relay.stop(); for (const socket of upstreamSockets) socket.destroy(); await close(upstream); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('SOCKS5 upstream authentication carries an allowlisted tunnel', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-egress-socks-'));
  const sockets = new Set<net.Socket>();
  const socks = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    let stage = 'greeting', buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (true) {
        if (stage === 'greeting') {
          if (buffer.length < 4) return; assert.deepEqual([...buffer.subarray(0, 4)], [5, 2, 0, 2]); buffer = buffer.subarray(4); socket.write(Buffer.from([5, 2])); stage = 'auth';
        } else if (stage === 'auth') {
          if (buffer.length < 2) return; const userLength = buffer[1], passwordOffset = 2 + userLength; if (buffer.length < passwordOffset + 1) return; const passwordLength = buffer[passwordOffset]; if (buffer.length < passwordOffset + 1 + passwordLength) return;
          assert.equal(buffer.subarray(2, passwordOffset).toString(), 'proxy-user'); assert.equal(buffer.subarray(passwordOffset + 1, passwordOffset + 1 + passwordLength).toString(), 'proxy-password');
          buffer = buffer.subarray(passwordOffset + 1 + passwordLength); socket.write(Buffer.from([1, 0])); stage = 'connect';
        } else if (stage === 'connect') {
          if (buffer.length < 5) return; assert.deepEqual([...buffer.subarray(0, 4)], [5, 1, 0, 3]); const hostLength = buffer[4], total = 5 + hostLength + 2; if (buffer.length < total) return;
          assert.equal(buffer.subarray(5, 5 + hostLength).toString(), 'chatgpt.com'); assert.equal(buffer.readUInt16BE(5 + hostLength), 443); buffer = buffer.subarray(total); socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); stage = 'echo';
        } else {
          if (buffer.length) { socket.write(buffer); buffer = Buffer.alloc(0); } return;
        }
      }
    });
  });
  const blocker = net.createServer(), socksPort = await listen(socks), relayPort = await listen(blocker); await close(blocker);
  const certificate = await ensureEgressCertificate(path.join(root, 'tls'));
  const config: AdminEgressConfig = { enabled: true, listenHost: '127.0.0.1', listenPort: relayPort, publicHost: '127.0.0.1', upstreamMode: 'socks5', upstreamHost: '127.0.0.1', upstreamPort: socksPort, upstreamUsername: 'proxy-user', codex: true, cursor: true };
  const relay = new EgressRelay(config, { accessCode: 'test-access-code-that-is-long', upstreamPassword: 'proxy-password' }, certificate);
  const client = new EgressClientProxy({ enabled: true, host: '127.0.0.1', port: relayPort, certificateFingerprint: certificate.fingerprint, accessCode: 'test-access-code-that-is-long', username: 'bob' });
  try {
    await relay.start(); await client.start(); const localPort = Number(new URL(client.environment().HTTPS_PROXY!).port);
    const socket = net.connect(localPort, '127.0.0.1'); await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.write('CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n'); assert.match((await readUntil(socket, '\r\n\r\n')).toString(), /200 Connection Established/);
    socket.write('socks-roundtrip'); assert.equal((await readUntil(socket, 'socks-roundtrip')).subarray(-15).toString(), 'socks-roundtrip'); socket.destroy();
  } finally { await client.stop(); await relay.stop(); for (const socket of sockets) socket.destroy(); await close(socks); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
