import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { CodexRequestGuard, codexRequestBudget, createCodexRequestGuard, encodeGuardBody } from '../src/core/codex-request-guard';
import { guardHistory } from '../src/core/codex-guard-history';
import { guardProxy, guardWindowsProxy } from '../src/core/codex-guard-transport';
import { settingsSchema } from '../src/core/config';
import type { AgentRpc } from '../src/core/rpc';

const direct = { HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '', no_proxy: '' };
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const msg = (role: string, content: any) => ({ type: 'message', role, content });
const text = (value: string) => [{ type: 'input_text', text: value }];
const history = () => ({ model: 'test', stream: true, store: false, instructions: 'KEEP_SYSTEM', tools: [{ type: 'function', name: 'inspect', parameters: {} }],
  input: [msg('developer', text('KEEP_DEVELOPER')), msg('user', text('old question ' + 'a'.repeat(900))), msg('assistant', [{ type: 'output_text', text: 'old answer ' + 'b'.repeat(900) }]), msg('user', text('second question ' + 'c'.repeat(900))), msg('assistant', [{ type: 'output_text', text: 'second answer ' + 'd'.repeat(900) }]), msg('user', text('LATEST_KEEP'))] });
async function request(url: string, body: Buffer, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', session_id: 'thread-A', authorization: 'Bearer test-A', ...headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', data => chunks.push(data)); res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), headers: res.headers })); res.on('error', reject);
    }); req.on('error', reject); req.end(body);
  });
}
async function fixture(run: (v: { url: string; guard: CodexRequestGuard; received: { bytes: Buffer; headers: http.IncomingHttpHeaders; value: any }[]; response: { mode: string; delay: number }; upstream: string }) => Promise<void>, options: { budget?: number; compression?: boolean } = {}) {
  const received: { bytes: Buffer; headers: http.IncomingHttpHeaders; value: any }[] = [], response = { mode: 'ok', delay: 0 };
  const upstreamServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), raw = req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes;
    let value: any; try { value = JSON.parse(raw.toString()); } catch {}
    received.push({ bytes, headers: req.headers, value });
    if (bytes.length >= (options.budget ?? codexRequestBudget)) { res.writeHead(413).end('Strict upload limit'); return; }
    const summary = value?.tools?.length === 0 && value?.tool_choice === 'none';
    if (summary && response.delay) await new Promise(resolve => setTimeout(resolve, response.delay));
    if (summary && response.mode === 'fail') { res.writeHead(500).end('PRIVATE_UPSTREAM_ERROR'); return; }
    res.writeHead(200, { ...(response.mode === 'missing-type' ? {} : { 'content-type': 'text/event-stream' }), 'x-test-stream': 'preserved' });
    const output = summary && response.mode === 'tool' ? [{ type: 'function_call', name: 'bad' }] : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: summary ? 'History: diagnosed the old attempt; keep constraints and unresolved work.' : 'FINAL' }] }];
    const event = { type: response.mode === 'incomplete' && summary ? 'response.incomplete' : 'response.completed', response: { status: response.mode === 'incomplete' && summary ? 'incomplete' : 'completed', output, usage: { input_tokens: 123, output_tokens: 9 } } };
    res.write('data: ' + JSON.stringify(event) + '\n\n'); res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
  const upstream = `http://127.0.0.1:${(upstreamServer.address() as any).port}/v1`;
  const guard = new CodexRequestGuard({ upstream, compression: options.compression ?? false, budget: options.budget, env: direct });
  try { const url = await guard.start(); await run({ url: url + '/responses', guard, received, response, upstream }); }
  finally { await guard.close(); upstreamServer.closeAllConnections(); await new Promise<void>(resolve => upstreamServer.close(() => resolve())); }
}

test('999,999 bytes pass unchanged; 1,000,000 and 1,000,001 bytes require repair; UTF-8 bytes decide the limit', async () => {
  const at = Buffer.alloc(codexRequestBudget - 1, 32);
  assert.equal((await encodeGuardBody(at, undefined, false))!.bytes, at);
  for (const size of [codexRequestBudget, codexRequestBudget + 1]) {
    const raw = Buffer.alloc(size, 32);
    assert.equal(await encodeGuardBody(raw, undefined, false), undefined);
    const repaired = await encodeGuardBody(raw, undefined, true);
    assert(repaired && repaired.bytes.length < codexRequestBudget);
    assert.deepEqual(zstdDecompressSync(repaired.bytes), raw);
  }
  const unicode = Buffer.from('中'.repeat(400000)); assert(unicode.length > codexRequestBudget);
  assert.equal(await encodeGuardBody(unicode, undefined, false), undefined);
});

test('compressed size at the exclusive limit is also rejected', async () => {
  const raw = json({ text: 'compressible content '.repeat(1000) });
  const compressed = (await encodeGuardBody(raw, undefined, true, raw.length))!.bytes;
  assert.equal(await encodeGuardBody(raw, undefined, true, compressed.length), undefined);
  assert.equal(await encodeGuardBody(compressed, 'zstd', true, compressed.length), undefined);
  assert.equal((await encodeGuardBody(compressed, 'zstd', true, compressed.length + 1))!.bytes, compressed);
});

test('strict gateway receives 999,999 unchanged and automatically repaired boundary requests', () => fixture(async ({ url, received, guard }) => {
  const body = json({ model: 'test', input: 'Reply OK' });
  for (const size of [999999, 1000000, 1000001]) {
    const raw = Buffer.concat([Buffer.alloc(size - body.length, 32), body]);
    assert.equal((await request(url, raw)).status, 200);
    const last = received.at(-1)!;
    assert(last.bytes.length < codexRequestBudget);
    if (size < codexRequestBudget) { assert.deepEqual(last.bytes, raw); assert.equal(last.headers['content-encoding'], undefined); }
    else { assert.equal(last.headers['content-encoding'], 'zstd'); assert.deepEqual(zstdDecompressSync(last.bytes), raw); }
  }
  assert.equal(guard.stats.forwarded, 3); assert.equal(guard.stats.summaries, 0);
  assert.equal(guard.stats.maxUploadBytes, 999999);
}, { compression: true }));

test('unrepairable exact-limit and over-limit latest inputs never reach the upstream', () => fixture(async ({ url, received, guard }) => {
  const base = { model: 'test', input: [msg('user', text(''))] };
  for (const size of [1000000, 1000001]) {
    const body = structuredClone(base); body.input[0].content[0].text = 'x'.repeat(size - json(base).length);
    assert.equal(json(body).length, size);
    assert.equal((await request(url, json(body))).status, 400);
  }
  assert.equal(received.length, 0); assert.equal(guard.stats.rejected, 2);
}));

for (const compression of [false, true]) test(`existing history above 1 MB automatically resumes after bounded summaries (compression=${compression})`, () => fixture(async ({ url, received, guard }) => {
  const original = history();
  original.input = [original.input[0], ...Array.from({ length: 8 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', [{ type: i % 2 ? 'output_text' : 'input_text', text: randomBytes(150000).toString('base64') }])), original.input.at(-1)!];
  const raw = json(original);
  assert(raw.length > codexRequestBudget);
  assert(zstdCompressSync(raw).length > codexRequestBudget, 'lossless compression alone must not solve this fixture');
  assert.equal((await request(url, raw)).status, 200);
  assert(guard.stats.summaries > 0 && guard.stats.summaries <= 8);
  assert(received.every(item => item.bytes.length < codexRequestBudget));
  assert(guard.stats.maxUploadBytes < codexRequestBudget);
  const final = received.at(-1)!.value;
  assert.equal(final.instructions, original.instructions); assert.deepEqual(final.tools, original.tools);
  assert.deepEqual(final.input[0], original.input[0]); assert.deepEqual(final.input.at(-1), original.input.at(-1));
  assert(JSON.stringify(final).includes('工作台历史交接摘要'));
  const summaries = guard.stats.summaries;
  assert.equal((await request(url, raw)).status, 200, 'unchanged native history can continue through the cached repair');
  assert.equal(guard.stats.summaries, summaries); assert.equal(guard.stats.cacheHits, 1);
  assert.deepEqual(json(original), raw, 'saved original history is never rewritten');
}, { compression }));

test('zstd is lossless and already-small compressed bytes remain untouched', async () => {
  const raw = json({ text: '内容'.repeat(220000) });
  const encoded = await encodeGuardBody(raw, undefined, true); assert(encoded); assert.equal(encoded.encoding, 'zstd');
  assert.deepEqual(zstdDecompressSync(encoded.bytes), raw);
  assert.equal((await encodeGuardBody(encoded.bytes, 'zstd', false))!.bytes, encoded.bytes);
  assert.equal(await encodeGuardBody(raw, undefined, false), undefined);
});

test('closed tool boundaries include late results, preserve media and internal notices, and reject continuation references', () => {
  const body = { input: [msg('user', text('old')), { type: 'function_call', call_id: 'x', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'x', output: 'first' }, msg('assistant', text('still waiting')), { type: 'function_call_output', call_id: 'x', output: 'late' },
    msg('user', text('<subagent_notification>KEEP</subagent_notification>')), msg('user', [{ type: 'input_image', image_url: 'KEEP_MEDIA' }]), msg('user', text('latest'))] };
  const result = guardHistory(body); assert(!result.cuts.includes(3)); assert(!result.cuts.includes(4)); assert(result.cuts.includes(5));
  assert(result.protectedIndices.has(5)); assert(result.protectedIndices.has(6));
  assert.throws(() => guardHistory({ ...body, previous_response_id: 'old' }), /续接/);
  assert.throws(() => guardHistory({ input: [{ type: 'function_call_output', call_id: 'missing', output: 'bad' }, msg('user', text('latest'))] }), /缺少/);
});

test('budget-fitting final body retains bytes, authentication, headers, streamed response and true usage', () => fixture(async ({ url, received, guard }) => {
  const raw = Buffer.from('{ "model": "test", "input": "ok" }');
  const result = await request(url, raw, { 'x-custom': 'original-header', 'chatgpt-account-id': 'account-A' });
  assert.equal(result.status, 200); assert.equal(received.length, 1); assert.deepEqual(received[0].bytes, raw);
  assert.equal(received[0].headers.authorization, 'Bearer test-A'); assert.equal(received[0].headers['x-custom'], 'original-header');
  assert.equal(received[0].headers['chatgpt-account-id'], 'account-A'); assert.equal(result.headers['x-test-stream'], 'preserved');
  assert(result.body.includes('"input_tokens":123')); assert.equal(guard.stats.summaries, 0);
}));

test('oversized requests are compressed only for an opted-in upstream', () => fixture(async ({ url, received }) => {
  const raw = json({ model: 'test', input: 'z'.repeat(1100000) }); assert.equal((await request(url, raw)).status, 200);
  assert.equal(received[0].headers['content-encoding'], 'zstd'); assert(received[0].bytes.length < codexRequestBudget);
}, { compression: true }));

test('summary and inference obey the same wire budget, preserving instructions, tools and newest content', () => fixture(async ({ url, received, guard }) => {
  const original = history(); const result = await request(url, json(original));
  assert.equal(result.status, 200); assert(guard.stats.summaries > 0);
  assert(received.every(item => item.bytes.length < 3000));
  const final = received.at(-1)!.value; assert.equal(final.instructions, original.instructions); assert.deepEqual(final.tools, original.tools);
  assert.deepEqual(final.input[0], original.input[0]); assert.deepEqual(final.input.at(-1), original.input.at(-1));
  for (const item of received.slice(0, -1)) { assert.deepEqual(item.value.tools, []); assert.equal(item.value.tool_choice, 'none'); }
  assert.equal(guard.stats.summaryInputTokens, 123 * guard.stats.summaries);
}, { budget: 3000 }));

for (const mode of ['fail', 'tool', 'incomplete']) test(`summary ${mode} fails locally without uploading the inference`, () => fixture(async ({ url, received, response }) => {
  response.mode = mode;
  const result = await request(url, json(history())); assert.equal(result.status, 400); assert(!result.body.includes('PRIVATE_UPSTREAM_ERROR'));
  assert(received.length > 0); assert(received.every(item => item.value.tool_choice === 'none'));
}, { budget: 3000 }));

test('mandatory latest content or no safe cut causes no upload', () => fixture(async ({ url, received }) => {
  for (const input of [[msg('user', text('a'.repeat(5000)))], [msg('developer', text('d'.repeat(5000))), msg('user', text('latest'))]]) {
    assert.equal((await request(url, json({ model: 'test', input }))).status, 400);
  }
  assert.equal(received.length, 0);
}, { budget: 3000 }));

test('parallel same-session preparations reuse summaries; native compaction clears the mapping; scope and prefix changes invalidate', () => fixture(async ({ url, guard, response }) => {
  response.delay = 30;
  const original = history();
  const results = await Promise.all([request(url, json(original)), request(url, json(original))]);
  assert(results.every(result => result.status === 200)); assert.equal(guard.stats.cacheHits, 1);
  const calls = guard.stats.summaries;
  await request(url, json({ ...original, input: [msg('user', text('native compacted'))] }));
  await request(url, json(original)); assert(guard.stats.summaries > calls);
  for (const mutation of [() => { original.model = 'changed'; }, () => { original.input[1] = msg('user', text('c'.repeat(900))); }]) {
    const previous = guard.stats.summaries; mutation(); await request(url, json(original)); assert(guard.stats.summaries > previous);
  }
  const previous = guard.stats.summaries; await request(url, json(original), { authorization: 'Bearer other-account' }); assert(guard.stats.summaries > previous);
}, { budget: 3000 }));

test('unsupported compression and cross-origin local calls fail without forwarding', () => fixture(async ({ url, received }) => {
  assert.equal((await request(url, Buffer.alloc(3001), { 'content-encoding': 'unknown' })).status, 400);
  assert.equal((await request(url, json({ input: 'secret' }), { origin: 'https://untrusted.invalid' })).status, 403); assert.equal(received.length, 0);
}, { budget: 3000 }));

test('existing proxy is mandatory, including CONNECT refusal; unsupported schemes never fall back', async () => {
  let connects = 0;
  const proxy = http.createServer((_req, res) => res.writeHead(403).end());
  proxy.on('connect', (_req, socket) => { connects++; socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const guard = new CodexRequestGuard({ upstream: 'https://unreachable.invalid/v1', compression: false, env: { ...direct, HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as any).port}` } });
  try { const result = await request((await guard.start()) + '/responses', json({ input: 'ok' })); assert.equal(result.status, 400); assert.equal(connects, 1); assert(result.body.includes('未改为直连')); }
  finally { await guard.close(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
  assert.throws(() => guardProxy(new URL('https://example.com'), { ...direct, HTTPS_PROXY: 'socks5://localhost:1' }), /不支持/);
});

test('provider override preserves custom identity, headers and upstream; builtin uses a temporary alias; configuration remains untouched', async () => {
  for (const builtin of [false, true]) {
    const config = { model_provider: builtin ? 'openai' : 'custom', model_providers: { custom: { name: 'Private', base_url: 'https://custom.invalid/api', env_key: 'PRIVATE_API_KEY', http_headers: { 'x-user': 'retained' }, query_params: { 'api-version': 'test' }, supports_request_compression: true } } };
    const before = structuredClone(config);
    const rpc = { request: async (method: string) => method === 'config/read' ? { config } : { account: { type: 'chatgpt' } } } as unknown as AgentRpc;
    const { guard, config: overlay } = await createCodexRequestGuard(rpc, '.', direct);
    try { assert.deepEqual(config, before); const id = builtin ? 'workbench_guard_openai' : 'custom'; assert.equal(overlay.model_provider, id);
      const provider = (overlay as any)[`model_providers.${id}`]; assert(provider.base_url.startsWith('http://127.0.0.1:')); assert.equal(provider.supports_websockets, false);
      if (!builtin) { assert.equal(provider.env_key, 'PRIVATE_API_KEY'); assert.deepEqual(provider.http_headers, before.model_providers.custom.http_headers); }
    } finally { await guard.close(); }
  }
  const base = { connections: [], providerPaths: { codex: '', cursor: '', claude: '' }, lastWorkspace: '' };
  assert.equal(settingsSchema.parse(base).codexRequestGuard, true);
  assert.equal(settingsSchema.parse({ ...base, codexRequestGuard: true }).codexRequestGuard, true);
  assert.equal(settingsSchema.parse({ ...base, codexRequestGuard: false }).codexRequestGuard, false);
});

test('gateway SSE without Content-Type is accepted only after a completed text response', () => fixture(async ({ url, response, guard }) => {
  response.mode = 'missing-type';
  assert.equal((await request(url, json(history()))).status, 200);
  assert(guard.stats.summaries > 0);
}, { budget: 3000 }));

test('eight-summary ceiling rejects without ever forwarding the oversized original', () => fixture(async ({ url, received, guard }) => {
  const body = history();
  body.input = Array.from({ length: 40 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', text('round-' + i + 'x'.repeat(800))));
  body.input.push(msg('user', text('LATEST')));
  assert.equal((await request(url, json(body))).status, 400);
  assert.equal(guard.stats.summaries, 8);
  assert.equal(received.length, 8); assert(received.every(item => item.bytes.length < 3000 && item.value.tool_choice === 'none'));
}, { budget: 3000 }));

test('latest closed tool group, media and internal annotations stay whole', () => fixture(async ({ url, received }) => {
  const body = history();
  const group = [{ type: 'function_call', call_id: 'latest', name: 'read', arguments: '{}' }, { type: 'function_call_output', call_id: 'latest', output: 'LATEST_RESULT' }];
  body.input.push(...group as any);
  assert.equal((await request(url, json(body))).status, 200);
  assert.deepEqual(received.at(-1)!.value.input.slice(-2), group);
  const pinned = { type: 'function_call_output', call_id: 'media', output: [{ type: 'input_image', image_url: 'protected' }] };
  const parsed = guardHistory({ input: [msg('user', text('old')), { type: 'function_call', call_id: 'media' }, pinned, msg('assistant', text('done')), msg('user', text('new'))] });
  assert(parsed.protectedIndices.has(1)); assert(parsed.protectedIndices.has(2));
}, { budget: 3000 }));

test('cache does not cross sessions, expire entries or retain data after close', () => fixture(async ({ url, guard }) => {
  await request(url, json(history()));
  const count = guard.stats.summaries;
  await request(url, json(history()), { session_id: 'different' }); assert(guard.stats.summaries > count);
  const now = guard.stats.summaries;
  for (const entry of (guard as any).cache) entry.used = Date.now() - 3600001;
  await request(url, json(history())); assert(guard.stats.summaries > now);
  assert((guard as any).cache.length > 0);
  await guard.close(); assert.equal((guard as any).cache.length, 0);
  await assert.rejects(request(url, json(history())));
}, { budget: 3000 }));

test('closing an instance aborts a pending summary and releases queued callers', () => fixture(async ({ url, guard, response, received }) => {
  response.delay = 300;
  const first = request(url, json(history())).catch(() => undefined), second = request(url, json(history())).catch(() => undefined);
  while (!received.length) await new Promise(resolve => setTimeout(resolve, 5));
  await guard.close(); await Promise.all([first, second]);
  assert.equal(guard.stats.forwarded, 0); assert.equal(received.length, 1);
}, { budget: 3000 }));

test('Windows proxy remains the upstream route and private/loopback exclusions remain local', () => {
  const before = { ...direct };
  const env = guardWindowsProxy(before, { ProxyEnable: 1, ProxyServer: 'http=127.0.0.1:7897;https=proxy.company:8080', ProxyOverride: 'localhost;127.*;10.*;<local>' });
  assert.equal(guardProxy(new URL('https://chatgpt.com'), env)?.href, 'http://proxy.company:8080/');
  assert.equal(guardProxy(new URL('http://external.example'), env)?.href, 'http://127.0.0.1:7897/');
  for (const address of ['http://127.0.0.1:1000', 'http://10.1.2.3', 'https://intranet']) assert.equal(guardProxy(new URL(address), env), undefined);
  assert.deepEqual(before, direct);
  assert.throws(() => guardWindowsProxy(direct, { AutoConfigURL: 'http://company/proxy.pac' }), /自动代理/);
  assert.throws(() => guardWindowsProxy(direct, { ProxyEnable: 1, ProxyServer: 'socks=localhost:1080' }), /不支持/);
});
