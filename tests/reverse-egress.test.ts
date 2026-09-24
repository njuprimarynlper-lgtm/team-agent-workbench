import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { Client } from 'ssh2';
import { forwardEgress } from '../src/core/ssh-egress';
import { ReverseEgressTunnel } from '../src/admin/reverse-egress';
import { ReverseEgressController } from '../src/admin/reverse-egress-controller';
import { EgressClientProxy } from '../src/core/egress';
import { decodeEgressInvite, encodeEgressInvite, userEgressSettingsSchema } from '../src/core/egress-config';
import { SharedFiles } from '../src/core/shared-files';
import { testTlsIdentity } from './fixtures/tls-identity';
import { reverseSshFixture } from './fixtures/reverse-ssh';

async function until(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function gateway() {
  const identity = testTlsIdentity(), sockets = new Set<net.Socket>();
  const server = tls.createServer(identity, socket => {
    let pending = '', accepted = false;
    socket.on('data', value => {
      if (accepted) { socket.write(value); return; }
      pending += value.toString(); if (!pending.includes('\n')) return;
      const request = JSON.parse(pending.split('\n')[0]);
      if (request.accessCode !== 'fixture-access-code-12345') { socket.end('{"ok":false,"error":"接入码无效"}\n'); return; }
      if (request.kind === 'ping') socket.end('{"ok":true}\n');
      else { accepted = true; socket.write('{"ok":true}\n'); }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { identity, port: (server.address() as net.AddressInfo).port, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('production reverse tunnel carries TLS and model bytes, reconnects on the same port and closes its listeners', { timeout: 15000 }, async () => {
  const shared = await reverseSshFixture(), admin = await gateway(), tunnel = new ReverseEgressTunnel(() => 30);
  const memberSsh = new Client(); memberSsh.on('error', () => {});
  const options = { ...shared.profile, password: 'test-password', remotePort: 0, localHost: '127.0.0.1', localPort: admin.port };
  let proxy: EgressClientProxy | undefined, member: net.Socket | undefined;
  try {
    await tunnel.start(options); const port = tunnel.snapshot().remotePort!;
    await new Promise<void>((resolve, reject) => { memberSsh.once('ready', resolve); memberSsh.once('error', reject); memberSsh.connect({ host: shared.profile.host, port: shared.profile.port, username: 'alice', password: 'test-password' }); });
    const route = { host: shared.profile.host, port: shared.profile.port, fingerprint: shared.profile.fingerprint, relayPort: port };
    proxy = new EgressClientProxy({ enabled: true, viaSharedServer: true, sharedServer: route, host: 'unreachable.invalid', port: 18443, certificateFingerprint: admin.identity.fingerprint, accessCode: 'fixture-access-code-12345', username: 'alice' }, (host, requestedPort, signal, expected) => {
      assert.equal(host, '127.0.0.1'); assert.equal(requestedPort, port); assert.deepEqual(expected, route); return forwardEgress(memberSsh, host, requestedPort, signal);
    });
    await proxy.start(); await proxy.probe(); assert.equal(proxy.status().available, true);
    member = net.connect(Number(new URL(proxy.environment().HTTPS_PROXY!).port), '127.0.0.1'); await once(member, 'connect');
    member.write('CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n'); assert.match(String((await once(member, 'data'))[0]), /200/);
    member.write('model roundtrip bytes'); assert.equal(String((await once(member, 'data'))[0]), 'model roundtrip bytes');
    assert(tunnel.snapshot().bytesUp > 0); assert(tunnel.snapshot().bytesDown > 0);
    const closed = once(member, 'close'); shared.disconnectAdmin(); await closed;
    await until(() => tunnel.snapshot().state === 'connected' && tunnel.snapshot().reconnects > 0);
    assert.equal(tunnel.snapshot().remotePort, port); await proxy.probe();
    tunnel.stop(); await until(() => shared.listeners.size === 0); assert.equal(tunnel.snapshot().activeConnections, 0);
    const logins = shared.state.logins; await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(shared.state.logins, logins);
  } finally { member?.destroy(); memberSsh.end(); await proxy?.stop(); tunnel.stop(); await shared.close(); await admin.close(); }
});

test('identity and authentication failures stop retrying; unsafe remote binds are closed', { timeout: 10000 }, async () => {
  const shared = await reverseSshFixture(), tunnel = new ReverseEgressTunnel(() => 10);
  const options = { ...shared.profile, password: 'test-password', remotePort: 0, localHost: '127.0.0.1', localPort: 1 };
  try {
    await assert.rejects(tunnel.start({ ...options, fingerprint: 'SHA256:' + 'A'.repeat(43) }), /身份/);
    assert.equal(tunnel.snapshot().state, 'error'); await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(tunnel.snapshot().reconnects, 0);
    await assert.rejects(tunnel.start({ ...options, password: 'wrong-password' })); assert.equal(tunnel.snapshot().state, 'error');
    shared.state.unsafeBind = true; await assert.rejects(tunnel.start(options), /回环地址/);
    assert.equal(tunnel.snapshot().state, 'error'); await until(() => shared.listeners.size === 0);
  } finally { tunnel.stop(); await shared.close(); }
});

test('stop cancels setup and two admins own separate internal listeners', { timeout: 10000 }, async () => {
  const shared = await reverseSshFixture(), first = new ReverseEgressTunnel(() => 10), second = new ReverseEgressTunnel(() => 10);
  const options = { ...shared.profile, password: 'test-password', remotePort: 0, localHost: '127.0.0.1', localPort: 1 };
  try {
    shared.state.pauseVerify = true;
    const cancelled = assert.rejects(first.start(options), /取消/); await until(() => shared.listeners.size === 1); first.stop(); await cancelled; await until(() => shared.listeners.size === 0);
    shared.state.pauseVerify = false; await first.start(options); await second.start(options);
    assert.notEqual(first.snapshot().remotePort, second.snapshot().remotePort);
    first.stop(); await until(() => shared.listeners.size === 1); assert.equal(second.snapshot().state, 'connected');
  } finally { first.stop(); second.stop(); await shared.close(); }
});

test('reverse settings persist only route metadata, resume after login and isolate server identities', { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-reverse-')), file = path.join(root, 'reverse.json');
  const shared = await reverseSshFixture(), controller = new ReverseEgressController(file, () => {}, new ReverseEgressTunnel(() => 30));
  try {
    await controller.init(); await controller.setGateway(true, '0.0.0.0', 18443); await controller.login(shared.profile, 'test-password');
    let allowed = 0; await controller.enable(async port => { allowed = port; });
    assert.equal(controller.route().relayPort, allowed);
    assert.doesNotMatch(await fs.readFile(file, 'utf8'), /test-password|password|root/);
    controller.disconnect(); assert.equal(controller.snapshot().state, 'waiting-login');
    await until(() => shared.listeners.size === 0); await controller.login(shared.profile, 'test-password'); assert.equal(controller.route().relayPort, allowed);
    controller.select({ ...shared.profile, fingerprint: 'SHA256:' + 'B'.repeat(43) }); assert.equal(controller.snapshot().enabled, false);
    controller.select(shared.profile); assert.equal(controller.snapshot().enabled, true); assert.equal(controller.snapshot().state, 'waiting-login');
    await controller.disable(); assert.equal(controller.snapshot().enabled, false);
  } finally { controller.disconnect(); await shared.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('reverse invites are versioned, preserve server identity and reject the wrong logged-in server', async () => {
  const sharedServer = { host: 'shared.internal', port: 2202, fingerprint: 'SHA256:' + 'A'.repeat(43), relayPort: 30123 };
  const invite = { version: 2 as const, host: 'admin.internal', port: 18443, fingerprint: 'AB'.repeat(32), accessCode: 'test-access-code-12345678', sharedServer };
  assert.match(encodeEgressInvite(invite), /^TAE2\./); assert.deepEqual(decodeEgressInvite(encodeEgressInvite(invite)), invite);
  assert.throws(() => decodeEgressInvite(encodeEgressInvite(invite).replace('TAE2.', 'TAE1.')), /无效/);
  assert.deepEqual(userEgressSettingsSchema.parse({ enabled: true, viaSharedServer: true, host: invite.host, port: invite.port, certificateFingerprint: invite.fingerprint, sharedServer }).sharedServer, sharedServer);
  const remote = new SharedFiles(() => {});
  (remote as any).backend.profile = { host: 'another.internal', port: 2202, fingerprint: sharedServer.fingerprint };
  assert.throws(() => remote.openEgressTunnel('127.0.0.1', sharedServer.relayPort, new AbortController().signal, sharedServer), /不匹配/);
});
