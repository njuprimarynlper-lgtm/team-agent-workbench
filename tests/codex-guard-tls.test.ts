import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { guardProbe, guardRequest } from '../src/core/codex-guard-transport';
import { guardNetworkError, guardTrustedCertificates, GuardNetworkError } from '../src/core/codex-guard-trust';
import { parseGuardNetworkProblem } from '../src/shared/guard-network';
import { CodexRequestGuard } from '../src/core/codex-request-guard';
import { AgentRuntime } from '../src/core/agents';
import { resolveProvider } from '../src/core/providers';
import type { AgentSession } from '../src/shared/types';

const direct = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '', no_proxy: '', CODEX_CA_CERTIFICATE: '', SSL_CERT_FILE: '', NODE_EXTRA_CA_CERTS: '' };
let root: string, ca: string, key: string, cert: string, expired: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-tls-test-'));
  const openssl = process.env.OPENSSL_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
  const run = async (...args: string[]) => { await promisify(execFile)(openssl, args, { cwd: root, windowsHide: true }); };
  await run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Temporary Guard Test Root', '-addext', 'basicConstraints=critical,CA:TRUE');
  await run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=model.test');
  await fs.writeFile(path.join(root, 'leaf.ext'), 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:model.test,DNS:localhost\nextendedKeyUsage=serverAuth\n');
  for (const [name, days, serial] of [['leaf.pem', '2', '1'], ['expired.pem', '-1', '2']])
    await run('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-set_serial', serial, '-out', name, '-days', days, '-extfile', 'leaf.ext');
  [ca, key, cert, expired] = await Promise.all(['ca.pem', 'leaf.key', 'leaf.pem', 'expired.pem'].map(file => fs.readFile(path.join(root, file), 'utf8')));
});
after(async () => { assert(root.startsWith(path.join(os.tmpdir(), 'guard-tls-test-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

async function fixture(run: (v: { target: URL; proxy: string; env: NodeJS.ProcessEnv; counts: { connects: number; requests: number }; upstreamPort: number }) => Promise<void>, options: { secureProxy?: boolean; certificate?: () => string; reject?: number; stall?: boolean; respond?: http.RequestListener } = {}) {
  const sockets = new Set<net.Socket>(), counts = { connects: 0, requests: 0 };
  const server = https.createServer({ key, cert: options.certificate?.() || cert }, (req, res) => { counts.requests++; req.resume(); if (options.respond) options.respond(req, res); else res.end('GUARD_TLS_OK'); });
  const proxy = options.secureProxy ? https.createServer({ key, cert }) : http.createServer();
  for (const listener of [server, proxy]) listener.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  const listen = (listener: net.Server) => new Promise<number>(resolve => listener.listen(0, '127.0.0.1', () => resolve((listener.address() as net.AddressInfo).port)));
  const upstreamPort = await listen(server), proxyPort = await listen(proxy);
  proxy.on('connect', (_req, socket, head) => {
    counts.connects++;
    if (options.stall) return;
    if (options.reject) { socket.end(`HTTP/1.1 ${options.reject} Rejected\r\n\r\n`); return; }
    const connection = net.connect(upstreamPort, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) connection.write(head); socket.pipe(connection).pipe(socket); });
    sockets.add(connection); connection.on('error', () => socket.destroy()); connection.once('close', () => { sockets.delete(connection); socket.destroy(); }); socket.once('close', () => connection.destroy());
  });
  const address = `${options.secureProxy ? 'https' : 'http'}://private-user:private-password@localhost:${proxyPort}`;
  try { await run({ target: new URL('https://model.test/v1/responses'), proxy: address, env: { ...direct, HTTPS_PROXY: address }, counts, upstreamPort }); }
  finally { for (const socket of sockets) socket.destroy(); await Promise.all([server, proxy].map(listener => new Promise<void>(resolve => listener.close(() => resolve())))); }
}
const content = async (response: http.IncomingMessage) => { let result = ''; for await (const chunk of response) result += chunk.toString(); return result; };
const call = (target: URL, env: NodeJS.ProcessEnv, certificateFile = '') => guardRequest(target, {}, Buffer.from('{}'), env, AbortSignal.timeout(5000), 'POST', certificateFile);

test('system and default roots are combined; explicit Codex bundle takes precedence over SSL_CERT_FILE', async () => {
  const file = path.join(root, 'ca.pem');
  const certificates = await guardTrustedCertificates({ CODEX_CA_CERTIFICATE: file, SSL_CERT_FILE: 'missing-ignored', NODE_EXTRA_CA_CERTS: file }, file, type => [type === 'default' ? 'PUBLIC_ROOT' : 'SYSTEM_ROOT']);
  assert.deepEqual(certificates, ['PUBLIC_ROOT', 'SYSTEM_ROOT', ca]);
  assert((await guardTrustedCertificates({ SSL_CERT_FILE: file }, '', () => [])).includes(ca));
  assert((await guardTrustedCertificates({ NODE_EXTRA_CA_CERTS: file }, '', () => [])).includes(ca));
});

test('missing, private-key and non-CA files fail without leaking file contents or paths', async () => {
  for (const [file, code] of [['private-path-secret.pem', 'CA_FILE_UNREADABLE'], ['leaf.key', 'CA_FILE_INVALID'], ['leaf.pem', 'CA_FILE_INVALID']]) {
    await assert.rejects(guardTrustedCertificates({}, path.join(root, file)), (error: any) => {
      assert.equal(error.problem.code, code); assert(!error.message.includes(root)); assert(!error.message.includes('private-path-secret')); assert(!error.message.includes('BEGIN')); return true;
    });
  }
  await assert.rejects(guardTrustedCertificates({}, '', () => { throw Error('private detail'); }), (error: any) => error.problem.code === 'SYSTEM_CA_UNAVAILABLE');
});

test('PEM comments and DER roots are accepted but malformed extra PEM blocks are rejected', async () => {
  const pem = path.join(root, 'commented.pem'), der = path.join(root, 'binary.cer');
  await fs.writeFile(pem, '# Company root\nBag Attributes\n' + ca + '\n# End of bundle\n');
  assert.deepEqual(await guardTrustedCertificates({}, pem, () => []), [ca]);
  await fs.writeFile(der, Buffer.from(ca.replace(/-----[^\n]+-----/g, '').replace(/\s/g, ''), 'base64'));
  assert.deepEqual(await guardTrustedCertificates({}, der, () => []), [ca]);
  await fs.writeFile(pem, ca + '\n-----BEGIN CERTIFICATE-----\nbroken');
  await assert.rejects(guardTrustedCertificates({}, pem), (error: any) => error.problem.code === 'CA_FILE_INVALID');
});

test('HTTP CONNECT succeeds with explicit enterprise CA and fails without it; no direct fallback', () => fixture(async ({ target, env, counts }) => {
  await assert.rejects(call(target, env), (error: any) => {
    assert(error instanceof GuardNetworkError); assert.equal(error.problem.stage, 'target_tls');
    assert(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.problem.code));
    assert(!error.message.includes('private-user')); assert(!error.message.includes('private-password')); return true;
  });
  assert.equal(counts.connects, 1); assert.equal(counts.requests, 0);
  assert.equal(await content(await call(target, env, path.join(root, 'ca.pem'))), 'GUARD_TLS_OK');
  assert.equal(counts.connects, 2); assert.equal(counts.requests, 1);
}));

test('a root trusted by the system works automatically, including both HTTPS proxy and target TLS', async t => {
  const original = tls.getCACertificates.bind(tls);
  t.mock.method(tls, 'getCACertificates', (type: 'default' | 'system') => type === 'system' ? [...original(type), ca] : original(type));
  await fixture(async ({ target, env, counts }) => {
    assert.equal(await content(await call(target, env)), 'GUARD_TLS_OK'); assert.equal(counts.requests, 1);
  }, { secureProxy: true });
});

test('direct HTTPS uses the same CA and probe performs only the TLS handshake', () => fixture(async ({ upstreamPort, counts }) => {
  const target = new URL(`https://localhost:${upstreamPort}/v1/responses`);
  assert.deepEqual(await guardProbe(target, direct, path.join(root, 'ca.pem')), { viaProxy: false });
  assert.equal(counts.requests, 0);
  assert.equal(await content(await call(target, { ...direct, CODEX_CA_CERTIFICATE: path.join(root, 'ca.pem') })), 'GUARD_TLS_OK');
}));

test('trusted root never disables target hostname verification', () => fixture(async ({ env, counts }) => {
  await assert.rejects(call(new URL('https://wrong.test/v1/responses'), env, path.join(root, 'ca.pem')), (error: any) => error.problem.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal(counts.connects, 1); assert.equal(counts.requests, 0);
}));

test('trusted root never accepts an expired server certificate', () => fixture(async ({ target, env, counts }) => {
  await assert.rejects(call(target, env, path.join(root, 'ca.pem')), (error: any) => error.problem.code === 'CERT_HAS_EXPIRED');
  assert.equal(counts.requests, 0);
}, { certificate: () => expired }));

for (const status of [403, 407]) test(`proxy ${status} is preserved without leaking its credentials or changing route`, () => fixture(async ({ target, env, counts }) => {
  await assert.rejects(call(target, env), (error: any) => {
    assert.equal(error.problem.code, `PROXY_${status}`); assert.equal(error.problem.stage, 'proxy_connect'); assert(!error.message.includes('private-')); return true;
  });
  assert.equal(counts.connects, 1); assert.equal(counts.requests, 0);
}, { reject: status }));

test('proxy timeout and cancellation release the connection without fallback', () => fixture(async ({ target, env, counts }) => {
  await assert.rejects(guardRequest(target, {}, Buffer.from('{}'), env, AbortSignal.timeout(5000), 'POST', '', 40), (error: any) => error.problem.code === 'ETIMEDOUT' && error.problem.stage === 'proxy_connect');
  await assert.rejects(guardRequest(target, {}, Buffer.from('{}'), env, AbortSignal.timeout(40)), (error: any) => error.problem.code === 'ABORT_ERR');
  assert.equal(counts.connects, 2); assert.equal(counts.requests, 0);
}, { stall: true }));

test('network reset retains only allowlisted diagnostics', () => {
  const safe = guardNetworkError(Object.assign(Error('https://user:secret@proxy.invalid private response'), { code: 'ECONNRESET' }), 'upstream', true);
  assert.equal(parseGuardNetworkProblem(safe.message)?.code, 'ECONNRESET'); assert.equal((safe as any).cause, undefined); assert(!safe.message.includes('secret'));
  assert.equal(guardNetworkError({ code: 'PRIVATE_SECRET' }, 'upstream', true).problem.code, 'NETWORK_ERROR');
});

test('guard returns a useful error and uses a newly saved CA on the next request without restart', () => fixture(async ({ target, env, counts }) => {
  let file = '';
  const guard = new CodexRequestGuard({ upstream: target.origin + '/v1', compression: false, env, certificateFile: () => file });
  try {
    const url = (await guard.start()) + '/responses';
    const failed = await fetch(url, { method: 'POST', body: '{}' }); const error = await failed.text();
    assert.equal(failed.status, 400); assert(parseGuardNetworkProblem(error)); assert(!error.includes('private-'));
    file = path.join(root, 'ca.pem');
    const passed = await fetch(url, { method: 'POST', body: '{}' }); assert.equal(await passed.text(), 'GUARD_TLS_OK');
    assert.equal(counts.requests, 1); assert.equal(guard.stats.forwarded, 1);
  } finally { await guard.close(); }
}));

const nativeRequests: {method?: string; url?: string}[] = [];
// Optional real installed CLI; isolated fake account and synthetic model, no external inference.
test('native Codex preserves the certificate diagnostic and resumes after updating CA in the same runtime', { skip: process.env.RUN_GUARD_NATIVE_CLI !== '1' }, () => fixture(async ({ target, env, counts }) => {
  const home = path.join(root, 'native-home'); await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'config.toml'), `model_provider = "guard_fixture"\nmodel = "gpt-6.1-sol"\n[model_providers.guard_fixture]\nname = "Guard fixture"\nbase_url = "${target.origin}/v1"\nwire_api = "responses"\nenv_key = "GUARD_TEST_KEY"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  let file = '', turns = 0;
  const session = { id: 'guard-native-tls', provider: 'codex', purpose: 'work', cwd: home, model: 'gpt-6.1-sol', status: 'idle', messages: [], approvals: [], sources: [], permissionMode: 'review' } as unknown as AgentSession;
  const runtime = new AgentRuntime(session, await resolveProvider('codex'), { changed() {}, event() {}, done() {} }, undefined,
    { ...env, CODEX_HOME: home, GUARD_TEST_KEY: 'SYNTHETIC_KEY', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }, undefined, false, true, () => file);
  runtime.rpc.on('message', event => { if (event.method === 'turn/completed') turns++; });
  const wait = async (count: number) => { const end = Date.now() + 30000; while (turns < count) { assert(Date.now() < end, 'native CLI did not complete'); await new Promise(resolve => setTimeout(resolve, 25)); } };
  try {
    await runtime.prompt('Only reply GUARD_TLS_OK. Do not use tools.'); await wait(1);
    assert.equal(session.status, 'error'); assert(parseGuardNetworkProblem(session.error || ''));
    assert(!session.error?.includes('private-password')); assert.equal(counts.requests, 0, JSON.stringify(nativeRequests));
    const nativeId = session.nativeId; file = path.join(root, 'ca.pem');
    await runtime.prompt('Continue. Only reply GUARD_TLS_OK. Do not use tools.'); await wait(2);
    assert.equal(session.nativeId, nativeId); assert.equal(session.status, 'idle'); assert.equal(session.error, undefined);
    assert(session.messages.some(message => message.role === 'assistant' && message.text.includes('GUARD_TLS_OK')));
    assert.equal(counts.requests, 1, JSON.stringify(nativeRequests));
  } finally { await runtime.close(); }
}, { respond: (_req, res) => {
  nativeRequests.push({ method: _req.method, url: _req.url });
  const item = { type: 'message', id: 'msg_tls', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'GUARD_TLS_OK', annotations: [] }] };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { id: 'resp_tls', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'GUARD_TLS_OK' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_tls', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
  ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
  res.end();
} }));
