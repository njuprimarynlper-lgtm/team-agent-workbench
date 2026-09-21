import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import net from 'node:net';
import { EgressClientProxy } from '../src/core/egress';

class MemorySocket extends Duplex {
  writes: Buffer[] = [];
  _read() {}
  _write(value: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) { this.writes.push(Buffer.from(value)); done(); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const reset = () => Object.assign(new Error('fixture connection reset'), { code: 'ECONNRESET' });
const request = { url: 'chatgpt.com:443' };

test('failed probes replace an earlier available state and obsolete probes cannot restore an old configuration', async () => {
  const proxy = new EgressClientProxy({ enabled: true, host: 'localhost', port: 1, certificateFingerprint: 'fixture', accessCode: 'fixture', username: 'alice' });
  try {
    (proxy as any).connectRelay = async () => new MemorySocket();
    await proxy.probe(); assert.equal(proxy.status().available, true);
    (proxy as any).connectRelay = async () => { throw new Error('fixture unreachable'); };
    await assert.rejects(proxy.probe(), /unreachable/); assert.equal(proxy.status().available, false); assert.equal(proxy.status().detail, '连接失败');
    let resolve!: (socket: MemorySocket) => void;
    (proxy as any).connectRelay = () => new Promise(done => { resolve = done; });
    const pending = proxy.probe(), rejected = assert.rejects(pending, /已改变/);
    await proxy.configure(undefined); resolve(new MemorySocket()); await rejected;
    assert.equal(proxy.status().enabled, false); assert.equal(proxy.status().available, undefined); assert.equal(proxy.status().detail, '使用本机网络直连');
  } finally { await proxy.stop(); }
});

test('client reset during handshake cancels the pending request without an unhandled error', async () => {
  const proxy = new EgressClientProxy(), client = new MemorySocket();
  let aborted = false;
  (proxy as any).connectRelay = (_request: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled fixture')); }, { once: true });
  });
  const pending = (proxy as any).connectRequest(request, client, Buffer.alloc(0));
  client.destroy(reset());
  await pending; await tick();
  assert.equal(aborted, true); assert.equal(client.destroyed, true);
  assert.equal(client.writes.length, 0); assert.equal((proxy as any).connections.size, 0);
  assert.equal(proxy.status().available, false); assert.match(proxy.status().detail, /重置/);
});

for (const side of ['client', 'relay'] as const) {
  test(`${side} reset after CONNECT closes both sockets and does not append an HTTP error to the tunnel`, async () => {
    const proxy = new EgressClientProxy(), client = new MemorySocket(), relay = new MemorySocket();
    (proxy as any).connectRelay = async () => relay;
    await (proxy as any).connectRequest(request, client, Buffer.from('first-tunnel-bytes'));
    assert.match(Buffer.concat(client.writes).toString(), /200 Connection Established/);
    assert.equal(Buffer.concat(relay.writes).toString(), 'first-tunnel-bytes');
    (side === 'client' ? client : relay).destroy(reset());
    await tick(); await tick();
    assert.equal(client.destroyed, true); assert.equal(relay.destroyed, true);
    assert.equal((proxy as any).connections.size, 0);
    assert.doesNotMatch(Buffer.concat(client.writes).toString(), /502/);
    assert.equal(proxy.status().available, false);
  });
  test(`${side} close after CONNECT releases its counterpart`, async () => {
    const proxy = new EgressClientProxy(), client = new MemorySocket(), relay = new MemorySocket();
    (proxy as any).connectRelay = async () => relay;
    await (proxy as any).connectRequest(request, client, Buffer.alloc(0));
    (side === 'client' ? client : relay).destroy();
    await tick(); await tick();
    assert.equal(client.destroyed, true); assert.equal(relay.destroyed, true);
    assert.equal((proxy as any).connections.size, 0);
  });
}

test('a late handshake result is destroyed after the client has already closed', async () => {
  const proxy = new EgressClientProxy(), client = new MemorySocket(), relay = new MemorySocket();
  let ready!: (value: MemorySocket) => void;
  (proxy as any).connectRelay = () => new Promise(resolve => { ready = resolve; });
  const pending = (proxy as any).connectRequest(request, client, Buffer.alloc(0));
  client.destroy(); await tick(); ready(relay); await pending; await tick();
  assert.equal(relay.destroyed, true); assert.equal(client.writes.length, 0);
  assert.notEqual(proxy.status().available, true); assert.equal((proxy as any).connections.size, 0);
});

test('a rejected handshake sends one 502 and releases the client', async () => {
  const proxy = new EgressClientProxy(), client = new MemorySocket();
  (proxy as any).connectRelay = async () => { throw new Error('fixture rejection'); };
  await (proxy as any).connectRequest(request, client, Buffer.alloc(0)); await tick();
  assert.match(Buffer.concat(client.writes).toString(), /^HTTP\/1\.1 502 Bad Gateway/);
  assert.equal(client.writes.length, 1); assert.equal(client.destroyed, true);
  assert.equal((proxy as any).connections.size, 0);
});

test('stop closes active tunnels before waiting for the local HTTP server', { timeout: 2000 }, async () => {
  const proxy = new EgressClientProxy(), client = new MemorySocket(), relay = new MemorySocket();
  (proxy as any).connectRelay = async () => relay;
  await proxy.start();
  try {
    await (proxy as any).connectRequest(request, client, Buffer.alloc(0));
    await proxy.stop(); await tick();
    assert.equal(client.destroyed, true); assert.equal(relay.destroyed, true);
    assert.equal((proxy as any).connections.size, 0); assert.deepEqual(proxy.environment(), {});
  } finally { client.destroy(); relay.destroy(); await proxy.stop(); }
});

test('stop cancels a real pending TLS handshake immediately, without waiting for its timeout', { timeout: 3000 }, async () => {
  let accepted!: () => void, peer: net.Socket | undefined;
  const incoming = new Promise<void>(resolve => { accepted = resolve; });
  const server = net.createServer(socket => { peer = socket; socket.on('error', () => socket.destroy()); socket.resume(); accepted(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxy = new EgressClientProxy({ enabled: true, host: '127.0.0.1', port: (server.address() as net.AddressInfo).port,
    certificateFingerprint: '00'.repeat(32), accessCode: 'fixture-only-access-code', username: 'fixture' });
  try {
    await proxy.start();
    const rejected = assert.rejects(proxy.probe(), /关闭|取消|连接/);
    await incoming; await proxy.stop(); await rejected;
    assert.equal((proxy as any).connections.size, 0);
  } finally {
    await proxy.stop(); peer?.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
