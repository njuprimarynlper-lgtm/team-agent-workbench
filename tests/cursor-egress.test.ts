import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EgressClientProxy, EgressRelay } from '../src/core/egress';
import { cursorNetworkEnvironment, cursorNetworkPreload } from '../src/core/cursor-network';
import { inspectAuth } from '../src/core/provider-auth';
import { inspectCatalog } from '../src/core/provider-catalog';
import { testTlsIdentity } from './fixtures/tls-identity';
import type { AdminEgressConfig } from '../src/shared/egress';

const listen = async (s: net.Server) => { await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); return (s.address() as net.AddressInfo).port; };
const close = (s: net.Server) => new Promise<void>(r => s.close(() => r()));
const bytes = (field: number, value: string | Buffer) => { const data = Buffer.from(value); assert(data.length < 128); return Buffer.concat([Buffer.from([field * 8 + 2, data.length]), data]); };
type FixtureResponse = { writeHead(status: number, headers: Record<string, string | number>): unknown; write(chunk: string): unknown; end(chunk: string | Buffer): unknown; destroyed: boolean };

async function fixture(options: { http1Only?: boolean; streamGate?: Promise<void> } = {}) {
  const identity = testTlsIdentity(['api2.cursor.sh', 'api.cursor.sh', '*.cursor.sh', 'localhost']);
  const sockets = new Set<net.Socket>(), requests: { path: string; httpVersion: string; method: string; headers: http.IncomingHttpHeaders; body: Buffer; connection: number }[] = [], targets: string[] = [];
  const track = (s: net.Server) => s.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  const handle = (req: http.IncomingMessage | http2.Http2ServerRequest, res: FixtureResponse) => {
    const record = { path: req.url!, httpVersion: req.httpVersion, method: req.method!, headers: req.headers, body: Buffer.alloc(0), connection: req.socket.remotePort! };
    requests.push(record); req.on('data', chunk => { record.body = Buffer.concat([record.body, chunk]); });
    if (req.url === '/echo') {
      req.once('end', () => { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': record.body.length }); res.end(record.body); }); return;
    }
    if (req.url === '/denied') { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"fixture service denied"}'); return; }
    if (req.url === '/interrupted') { res.writeHead(200, { 'content-length': 999 }); res.write('partial'); setImmediate(() => req.socket.destroy()); return; }
    if (req.url?.endsWith('/stream')) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.write('{"text":"hello"}\n');
      void (options.streamGate || new Promise(r => setTimeout(r, 15))).then(() => { if (!res.destroyed) res.end('{"text":" world"}\n'); }); return;
    }
    const email = bytes(3, 'relay-test@example.invalid');
    res.writeHead(200, { 'content-type': 'application/proto' });
    const model = bytes(1, Buffer.concat([bytes(1, 'relay-test-model'), bytes(4, 'Relay Test Model')]));
    res.end(req.url?.endsWith('/GetMe') ? email : /\/(GetUsableModels|GetDefaultModelForCli)$/.test(req.url || '') ? model : Buffer.alloc(0));
  };
  const target = options.http1Only ? https.createServer({ ...identity, ALPNProtocols: ['http/1.1'] }, handle)
    : http2.createSecureServer({ ...identity, allowHTTP1: true }, handle);
  track(target); const targetPort = await listen(target);
  let rejection = 0;
  const upstream = http.createServer(); track(upstream);
  upstream.on('connect', (req, socket, head) => {
    targets.push(req.url!);
    if (rejection) { socket.end(`HTTP/1.1 ${rejection} Forbidden\r\nConnection: close\r\n\r\n`); return; }
    const remote = net.connect(targetPort, '127.0.0.1'); sockets.add(remote); remote.on('error', () => socket.destroy()); remote.once('close', () => { sockets.delete(remote); socket.destroy(); }); socket.once('close', () => remote.destroy());
    remote.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); socket.pipe(remote).pipe(socket); });
  });
  const config: AdminEgressConfig = { enabled: true, listenHost: '127.0.0.1', listenPort: 0, publicHost: '127.0.0.1', upstreamMode: 'http', upstreamHost: '127.0.0.1', upstreamPort: await listen(upstream), upstreamUsername: '', codex: true, cursor: true, claude: false };
  const relay = new EgressRelay(config, { accessCode: 'fixture-management-secret' }, { pfx: Buffer.alloc(0), passphrase: '', fingerprint: identity.fingerprint });
  // Actual TLS and actual relay handler, with an ephemeral in-memory key.
  const server = tls.createServer(identity, socket => void (relay as any).accept(socket)); track(server);
  const client = new EgressClientProxy({ enabled: true, host: '127.0.0.1', port: await listen(server), certificateFingerprint: identity.fingerprint, accessCode: 'fixture-management-secret', username: 'fixture' });
  await client.start();
  return { client, relay, config, identity, requests, targets, reject: (code: number) => { rejection = code; }, close: async () => {
    await client.stop(); await relay.stop(); for (const socket of sockets) socket.destroy(); await Promise.all([close(server), close(upstream), close(target)]);
  } };
}

/** HTTP/1.1 inside provider TLS, inside the management TLS tunnel. */
function http1Client(f: Awaited<ReturnType<typeof fixture>>) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  const proxy = new URL(f.client.environment().HTTPS_PROXY!);
  agent.createConnection = (_options, callback) => {
    const request = http.request(proxy, { method: 'CONNECT', path: 'api2.cursor.sh:443', agent: false, timeout: 3000 });
    request.once('error', error => callback!(error, undefined as any));
    request.once('timeout', () => request.destroy(new Error('fixture CONNECT timeout')));
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); callback!(new Error('CONNECT ' + response.statusCode), undefined as any); return; }
      socket.setTimeout(0); if (head.length) socket.unshift(head);
      const secure = tls.connect({ socket, servername: 'api2.cursor.sh', ca: f.identity.cert, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
      const failed = (error: Error) => callback!(error, undefined as any);
      secure.once('error', failed);
      secure.once('secureConnect', () => { secure.off('error', failed); assert.equal(secure.alpnProtocol, 'http/1.1'); callback!(null, secure); });
    });
    request.end(); return undefined as any;
  };
  const send = (pathname: string, chunks: Buffer[] = [], options: { chunked?: boolean; firstChunk?: () => void } = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; complete: boolean }>((resolve, reject) => {
    const req = https.request('https://api2.cursor.sh' + pathname, { agent, method: chunks.length ? 'POST' : 'GET', headers: {
      authorization: 'Bearer synthetic-http1-token', 'content-type': 'application/octet-stream',
      ...(chunks.length && !options.chunked ? { 'content-length': chunks.reduce((sum, chunk) => sum + chunk.length, 0) } : {}),
    } }, res => {
      const data: Buffer[] = [];
      res.on('data', chunk => { if (!data.length) options.firstChunk?.(); data.push(chunk); });
      res.once('error', reject); res.once('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(data), complete: res.complete }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('fixture HTTP/1.1 timeout'))); req.once('error', reject);
    for (const chunk of chunks) req.write(chunk); req.end();
  });
  return { send, close: () => agent.destroy() };
}

test('HTTP/1.1 POST binary and chunked bodies survive both relay hops and reuse keep-alive', { timeout: 10000 }, async () => {
  const f = await fixture({ http1Only: true }), client = http1Client(f);
  try {
    const binary = Buffer.concat([Buffer.from('中文 / payload\0'), Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 256))]);
    const fixed = await client.send('/echo', [binary]);
    assert.equal(fixed.status, 200); assert.equal(fixed.complete, true); assert.deepEqual(fixed.body, binary);
    const chunks = [Buffer.from('first\0'), binary, Buffer.from('尾部')];
    const chunked = await client.send('/echo', chunks, { chunked: true });
    assert.equal(chunked.status, 200); assert.equal(chunked.complete, true); assert.deepEqual(chunked.body, Buffer.concat(chunks));
    assert.equal(f.requests.length, 2); assert(f.requests.every(r => r.httpVersion === '1.1' && r.method === 'POST'));
    assert.equal(f.requests[0].headers['content-length'], String(binary.length)); assert.equal(f.requests[1].headers['transfer-encoding'], 'chunked');
    assert(f.requests.every(r => r.headers.authorization === 'Bearer synthetic-http1-token'));
    assert.equal(f.requests[0].connection, f.requests[1].connection); assert.deepEqual(f.targets, ['api2.cursor.sh:443']);
    assert(!JSON.stringify(f.relay.snapshot()).includes('synthetic-http1-token'), 'relay must not inspect or log the encrypted account token');
  } finally { client.close(); await f.close(); }
});

test('HTTP/1.1 chunked response arrives before completion and service 403 remains distinguishable from CONNECT failure', { timeout: 10000 }, async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ http1Only: true, streamGate: gate }), client = http1Client(f);
  try {
    let sawFirstChunk = false;
    const stream = await client.send('/stream', [], { firstChunk: () => { sawFirstChunk = true; release(); } });
    assert(sawFirstChunk); assert.equal(stream.headers['transfer-encoding'], 'chunked'); assert.equal(stream.complete, true);
    assert.equal(stream.body.toString(), '{"text":"hello"}\n{"text":" world"}\n');
    const denied = await client.send('/denied'); assert.equal(denied.status, 403); assert.equal(denied.complete, true);
    assert.equal(denied.body.toString(), '{"error":"fixture service denied"}');
    assert(f.requests.every(r => r.httpVersion === '1.1')); assert.deepEqual(f.targets, ['api2.cursor.sh:443']);
  } finally { release(); client.close(); await f.close(); }
});

test('HTTP/1.1 interrupted response is rejected rather than reported as a completed reply', { timeout: 10000 }, async () => {
  const f = await fixture({ http1Only: true }), client = http1Client(f);
  try {
    await assert.rejects(client.send('/interrupted'), /aborted|reset|hang up/i);
    assert.equal(f.requests[0].httpVersion, '1.1');
    const recovered = await client.send('/echo', [Buffer.from('fresh connection')]);
    assert.equal(recovered.status, 200); assert.equal(recovered.complete, true); assert.equal(recovered.body.toString(), 'fresh connection');
    assert.notEqual(f.requests[0].connection, f.requests[1].connection);
    assert.equal(f.targets.length, 2, 'an interrupted tunnel must not be reused');
  } finally { client.close(); await f.close(); }
});

test('explicit management route overrides inherited bypass and system-CA bootstrap applies only to Cursor managed children', async t => {
  t.mock.property(process, 'env', { ...process.env, NO_PROXY: '*' });
  const f = await fixture();
  try {
    const env = f.client.environment(); assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1'); assert.equal(env.ALL_PROXY, env.HTTPS_PROXY);
    assert.equal(cursorNetworkEnvironment({ NODE_OPTIONS: '--trace-warnings' }).NODE_OPTIONS, '--trace-warnings');
    const managed = cursorNetworkEnvironment({ ...env, NODE_OPTIONS: '--trace-warnings' });
    assert.match(managed.NODE_OPTIONS!, /--trace-warnings --require .*cursor-network\.cjs/);
    assert.deepEqual(cursorNetworkEnvironment(managed), managed);
    assert.equal(cursorNetworkPreload(path.join('install with spaces', 'resources', 'app.asar')), path.join('install with spaces', 'resources', 'app.asar.unpacked', 'cursor-network.cjs'));
  } finally { await f.close(); }
});

test('Cursor provider probe distinguishes ping, disabled forwarding, upstream 403, trust failure and valid TLS', async t => {
  const f = await fixture(); const roots = tls.getCACertificates;
  try {
    await f.client.probe(); assert.equal(f.targets.length, 0, 'ping does not test the upstream');
    f.relay.update({ ...f.config, cursor: false }, { accessCode: 'fixture-management-secret' });
    await assert.rejects(f.client.probe('cursor'), /管理端尚未允许 Cursor/); assert.equal(f.targets.length, 0);
    f.relay.update(f.config, { accessCode: 'fixture-management-secret' }); f.reject(403);
    await assert.rejects(f.client.probe('cursor'), /HTTP 403/); assert.equal(f.client.status().available, false);
    f.reject(0);
    await assert.rejects(f.client.probe('cursor'), /无法验证模型服务证书/);
    t.mock.method(tls, 'getCACertificates', (type: string) => type === 'system' ? [f.identity.cert] : roots(type as any));
    await f.client.probe('cursor'); assert.equal(f.client.status().available, true); assert.match(f.client.status().detail, /连通 Cursor 服务/);
    assert(f.targets.every(x => x === 'api2.cursor.sh:443')); assert.equal(f.requests.length, 0, 'TLS probe sends no account or model request');
    assert(!JSON.stringify(f.client.status()).includes('fixture-management-secret'));
  } finally { await f.close(); }
});

test('HTTP/2 streaming survives both management TLS and upstream CONNECT', async () => {
  const f = await fixture();
  try {
    const proxy = new URL(f.client.environment().HTTPS_PROXY!);
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const req = http.request(proxy, { method: 'CONNECT', path: 'api2.cursor.sh:443', agent: false });
      req.once('error', reject); req.once('connect', (res, socket) => { assert.equal(res.statusCode, 200); resolve(socket); }); req.end();
    });
    const secure = tls.connect({ socket, servername: 'api2.cursor.sh', ca: f.identity.cert, rejectUnauthorized: true, ALPNProtocols: ['h2'] });
    const session = http2.connect('https://api2.cursor.sh', { createConnection: () => secure });
    try {
      const response = await new Promise<string>((resolve, reject) => { const req = session.request({ ':path': '/stream' }); let result = ''; req.on('data', chunk => { result += chunk; }); req.on('error', reject); req.on('end', () => resolve(result)); req.end(); });
      assert.equal(response, '{"text":"hello"}\n{"text":" world"}\n'); assert.equal(f.requests[0].httpVersion, '2.0');
    } finally { session.destroy(); secure.destroy(); socket.destroy(); }
  } finally { await f.close(); }
});

test('real installed Cursor account and model queries use HTTP/1.1 through management relay with system trust', { skip: process.env.RUN_CURSOR_NATIVE_CLI !== '1', timeout: 45000 }, async () => {
  const f = await fixture({ http1Only: true }), root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-relay-native-'));
  try {
    const executable = path.resolve('.tools/cursor/dist-package/cursor-agent.cmd');
    await fs.mkdir(path.join(root, 'Cursor')); await fs.mkdir(path.join(root, 'config')); await fs.mkdir(path.join(root, 'data'));
    const token = `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.synthetic`;
    await fs.writeFile(path.join(root, 'Cursor/auth.json'), JSON.stringify({ accessToken: token, refreshToken: 'synthetic-refresh' }));
    const rootsFile = path.join(root, 'system-roots.cjs');
    // Simulate a company CA installed in Windows; never modify the OS store.
    await fs.writeFile(rootsFile, `const tls=require('node:tls');const roots=tls.getCACertificates;tls.getCACertificates=type=>type==='system'?[${JSON.stringify(f.identity.cert)}]:roots(type);`);
    const env = { ...f.client.environment(), APPDATA: root, CURSOR_CONFIG_DIR: path.join(root, 'config'), CURSOR_DATA_DIR: path.join(root, 'data'), CURSOR_API_KEY: '', CURSOR_AUTH_TOKEN: '', NODE_EXTRA_CA_CERTS: '', NODE_OPTIONS: `--require ${JSON.stringify(rootsFile)}` };
    const broken = await inspectAuth('cursor', executable, root, undefined, 15000, { ...env, TEAM_AGENT_MANAGEMENT_PROXY: '' });
    assert.equal(broken.verifiedLocally, true); assert(broken.connectionIssue, 'before fix: saved login masks the TLS failure');
    const fixed = await inspectAuth('cursor', executable, root, undefined, 15000, env);
    assert.equal(fixed.status, 'authenticated'); assert.equal(fixed.identity, 'relay-test@example.invalid'); assert.equal(fixed.connectionIssue, undefined);
    assert(f.requests.some(x => x.path.endsWith('/GetMe')));
    const catalog = await inspectCatalog('cursor', executable, root, undefined, 15000, env);
    assert.equal(catalog.modelError, undefined, JSON.stringify(f.requests));
    assert(catalog.models.some(m => m.id === 'relay-test-model'));
    const accountRequests = f.requests.filter(x => x.path.endsWith('/GetMe'));
    const modelRequests = f.requests.filter(x => x.path.endsWith('/GetUsableModels'));
    assert(accountRequests.length > 0 && modelRequests.length > 0);
    assert([...accountRequests, ...modelRequests].every(x => x.httpVersion === '1.1'), 'assert the upstream application protocol, not just the CONNECT handshake');
  } finally { await f.close(); assert(path.basename(root).startsWith('cursor-relay-native-')); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
