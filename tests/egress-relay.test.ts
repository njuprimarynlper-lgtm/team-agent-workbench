import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EgressRelay, EgressClientProxy } from '../src/core/egress';
import type { AdminEgressConfig } from '../src/shared/egress';

const listen = (server: net.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
const until = async (predicate: () => boolean) => { const deadline = Date.now() + 3000; while (!predicate()) { if (Date.now() > deadline) throw new Error('relay timeout'); await new Promise(resolve => setTimeout(resolve, 10)); } };
const read = (socket: net.Socket, expected: string) => new Promise<string>((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => { socket.off('data', data); reject(new Error('read timeout')); }, 3000);
  const data = (chunk: Buffer) => { text += chunk.toString(); if (text.includes(expected)) { clearTimeout(timer); socket.off('data', data); resolve(text); } };
  socket.on('data', data); socket.once('error', error => { clearTimeout(timer); reject(error); });
});
async function fixture(mode: 'echo' | 'reject' | 'hang' = 'echo') {
  const upstreamSockets = new Set<net.Socket>(), peers = new Set<net.Socket>(), requests: string[] = [];
  const upstream = net.createServer(socket => {
    upstreamSockets.add(socket); socket.once('close', () => upstreamSockets.delete(socket)); socket.on('error', () => {});
    let connected = false, head = '';
    socket.on('data', chunk => {
      if (mode === 'hang') return;
      if (connected) { socket.write(chunk); return; }
      head += chunk.toString(); if (!head.includes('\r\n\r\n')) return;
      connected = true;
      requests.push(head.split('\r\n')[0]);
      if (mode === 'reject') socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      else socket.write('HTTP/1.1 200 Connection Established\r\n\r\nWELCOME');
    });
  });
  const upstreamPort = await listen(upstream);
  const config: AdminEgressConfig = { enabled: true, listenHost: '127.0.0.1', listenPort: 0, publicHost: '127.0.0.1', upstreamMode: 'http', upstreamHost: '127.0.0.1', upstreamPort, upstreamUsername: '', codex: true, cursor: true, claude: false };
  const relay = new EgressRelay(config, { accessCode: 'fixture-secret' }, { pfx: Buffer.alloc(0), passphrase: '', fingerprint: '' });
  // Exercise the actual relay protocol and real upstream sockets without creating certificates or GUI processes.
  const server = net.createServer(socket => { peers.add(socket); socket.once('close', () => peers.delete(socket)); void (relay as any).accept(socket); });
  const port = await listen(server);
  const connect = async () => { const socket = net.connect(port, '127.0.0.1'); await new Promise<void>(resolve => socket.once('connect', resolve)); return socket; };
  const handshake = (payload: object = {}) => JSON.stringify({ version: 1, accessCode: 'fixture-secret', username: 'alice', kind: 'connect', host: 'chatgpt.com', port: 443, ...payload }) + '\n';
  return { relay, config, connect, handshake, upstreamSockets, requests, close: async () => { await relay.stop(); for (const socket of peers) socket.destroy(); for (const socket of upstreamSockets) socket.destroy(); await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]); } };
}

test('relay counts first-packet payload and live traffic, then closes upstream and removes the member on client disconnect', async () => {
  const f = await fixture(); const socket = await f.connect();
  try {
    const answer = read(socket, 'WELCOMEhello'); socket.write(f.handshake() + 'hello'); await answer;
    let snapshot = f.relay.snapshot(); assert.equal(snapshot.monitor.bytesUp, 5); assert.equal(snapshot.monitor.bytesDown, 12); assert.equal(snapshot.monitor.members.length, 1);
    const more = read(socket, 'again'); socket.write('again'); await more;
    snapshot = f.relay.snapshot(); assert.equal(snapshot.monitor.bytesUp, 10); assert.equal(snapshot.monitor.bytesDown, 17);
    socket.destroy(); await until(() => f.relay.snapshot().activeConnections === 0 && f.upstreamSockets.size === 0);
    assert.equal(f.relay.snapshot().monitor.activeTunnels, 0); assert.equal(f.relay.snapshot().monitor.members.length, 0); assert.equal(f.relay.snapshot().events[0].status, 'closed');
  } finally { socket.destroy(); await f.close(); }
});
test('upstream HTTP 403 is visible, counted as failure and releases the upstream socket', async () => {
  const f = await fixture('reject'), socket = await f.connect();
  try {
    const answer = read(socket, '\n'); socket.write(f.handshake()); assert.match(await answer, /HTTP 403/);
    await until(() => f.upstreamSockets.size === 0 && f.relay.snapshot().activeConnections === 0);
    assert.equal(f.relay.snapshot().monitor.failures, 1); assert.equal(f.relay.snapshot().monitor.rejections, 0);
  } finally { socket.destroy(); await f.close(); }
});
test('disconnect while upstream handshake is stalled cancels promptly and leaves no live member', async () => {
  const f = await fixture('hang'), socket = await f.connect();
  try {
    socket.write(f.handshake()); await until(() => f.upstreamSockets.size === 1); socket.destroy();
    await until(() => f.upstreamSockets.size === 0 && f.relay.snapshot().activeConnections === 0);
    assert.equal(f.relay.snapshot().monitor.activeTunnels, 0);
  } finally { socket.destroy(); await f.close(); }
});
test('authenticated CLI reports expose status codes without inflating tunnel totals or retaining extra fields', async () => {
  const f = await fixture(), socket = await f.connect();
  try {
    const answer = read(socket, '\n');
    socket.write(f.handshake({ kind: 'status', reports: [{ clientId: randomUUID(), sessionId: 'session', provider: 'codex', connection: { state: 'failed', kind: 'forbidden', httpStatus: 403, token: 'PRIVATE' }, prompt: 'PRIVATE' }] }));
    assert.equal(JSON.parse(await answer).ok, true); await until(() => f.relay.snapshot().activeConnections === 0);
    const snapshot = f.relay.snapshot(); assert.equal(snapshot.monitor.cliReports[0].connection.httpStatus, 403); assert.equal(snapshot.monitor.connections, 0); assert.equal(snapshot.monitor.bytesUp, 0); assert.equal(snapshot.events.length, 0); assert(!JSON.stringify(snapshot).includes('PRIVATE'));
    const wrong = await f.connect(); const denied = read(wrong, '\n'); wrong.write(f.handshake({ kind: 'status', accessCode: 'wrong', reports: [] })); assert.equal(JSON.parse(await denied).ok, false); wrong.destroy();
    assert.equal(f.relay.snapshot().monitor.cliReports.length, 1);
  } finally { socket.destroy(); await f.close(); }
});
test('user status reporting uses the verified member, strips secrets and clears prior account reports', async () => {
  const proxy = new EgressClientProxy({ enabled: true, host: '127.0.0.1', port: 1, certificateFingerprint: 'fixture', accessCode: 'fixture', username: 'old' });
  const reports: any[] = []; (proxy as any).connectRelay = async (value: unknown) => { reports.push(value); return { end() {} }; };
  try {
    await proxy.start(); proxy.reportCliStatus('codex', 'session', { state: 'failed', kind: 'forbidden', httpStatus: 403, at: new Date().toISOString(), token: 'PRIVATE' } as any, 'alice');
    await until(() => reports.length === 1); assert.equal(reports[0].username, 'alice'); assert(!JSON.stringify(reports).includes('PRIVATE'));
    proxy.setUsername('bob'); assert.equal((proxy as any).reports.size, 0);
    await proxy.stop(); proxy.reportCliStatus('codex', 'session', { state: 'connected', at: new Date().toISOString() }, 'bob'); assert.equal((proxy as any).reports.size, 0);
  } finally { await proxy.stop(); }
});

test('administrator can test every saved route without a running listener or service permission; members remain restricted', async () => {
  const f = await fixture();
  try {
    f.relay.update({ ...f.config, enabled: false, cursor: false, claude: false }, { accessCode: 'fixture-secret' });
    for (const provider of ['codex', 'cursor', 'claude'] as const) assert.equal(await f.relay.probe(provider), true);
    await until(() => f.upstreamSockets.size === 0);
    assert.deepEqual(f.requests, ['CONNECT chatgpt.com:443 HTTP/1.1', 'CONNECT api2.cursor.sh:443 HTTP/1.1', 'CONNECT api.anthropic.com:443 HTTP/1.1']);
    assert.equal(f.relay.snapshot().running, false); assert.equal(f.relay.snapshot().monitor.connections, 0); assert.equal(f.relay.snapshot().events.length, 0);
    f.relay.update({ ...f.config, cursor: false, claude: false }, { accessCode: 'fixture-secret' });
    for (const host of ['api2.cursor.sh', 'api.anthropic.com']) {
      const socket = await f.connect(), answer = read(socket, '\n'); socket.write(f.handshake({ host }));
      assert.match(await answer, /白名单/); socket.destroy();
    }
    assert.equal(f.requests.length, 3, 'denied member requests never reach the upstream');
    await assert.rejects(f.relay.probe('arbitrary-host' as any), /不支持/);
  } finally { await f.close(); }
});

test('a disabled-service network test reports upstream rejection and releases its socket', async () => {
  const f = await fixture('reject');
  try { await assert.rejects(f.relay.probe('claude'), /HTTP 403/); await until(() => f.upstreamSockets.size === 0); assert.equal(f.relay.snapshot().monitor.failures, 0); }
  finally { await f.close(); }
});
