import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { CodexRequestGuard, codexRequestBudget, createCodexRequestGuard, encodeGuardBody } from '../src/core/codex-request-guard';
import { guardHistory, replaceGuardHistory, summaryRequest } from '../src/core/codex-guard-history';
import { guardProxy, guardWindowsProxy } from '../src/core/codex-guard-transport';
import { settingsSchema } from '../src/core/config';
import type { AgentRpc } from '../src/core/rpc';

const direct = { HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '', no_proxy: '' };
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const msg = (role: string, content: any) => ({ type: 'message', role, content });
const text = (value: string) => [{ type: 'input_text', text: value }];
const history = () => ({ model: 'test', stream: true, store: false, instructions: 'KEEP_SYSTEM', tools: [{ type: 'function', name: 'inspect', parameters: {} }],
  input: [msg('developer', text('KEEP_DEVELOPER')), msg('user', text('old question ' + 'a'.repeat(900))), msg('assistant', [{ type: 'output_text', text: 'old answer ' + 'b'.repeat(900) }]), msg('user', text('second question ' + 'c'.repeat(900))), msg('assistant', [{ type: 'output_text', text: 'second answer ' + 'd'.repeat(900) }]), msg('user', text('LATEST_KEEP'))] });

test('summary request disables parallel calls and lowers its own reasoning effort without changing the original turn', () => {
  const original = { model: 'test', reasoning: { effort: 'high', context: 'all_turns' }, parallel_tool_calls: true };
  const summary = summaryRequest(original, [msg('user', text('finished'))], 'prior');
  assert.equal(summary.parallel_tool_calls, false);
  assert.deepEqual(summary.reasoning, { effort: 'low', context: 'all_turns' });
  assert.deepEqual(original.reasoning, { effort: 'high', context: 'all_turns' });
  assert.equal(original.parallel_tool_calls, true);
});
async function request(url: string, body: Buffer, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', session_id: 'thread-A', authorization: 'Bearer test-A', ...headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', data => chunks.push(data)); res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), headers: res.headers })); res.on('error', reject);
    }); req.on('error', reject); req.end(body);
  });
}
async function fixture(run: (v: { url: string; guard: CodexRequestGuard; received: { bytes: Buffer; headers: http.IncomingHttpHeaders; value: any }[]; response: { mode: string; delay: number; overloadRemaining: number }; upstream: string }) => Promise<void>, options: { budget?: number; compression?: boolean } = {}) {
  const received: { bytes: Buffer; headers: http.IncomingHttpHeaders; value: any }[] = [], response = { mode: 'ok', delay: 0, overloadRemaining: 0 };
  const upstreamServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), raw = req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes;
    let value: any; try { value = JSON.parse(raw.toString()); } catch {}
    received.push({ bytes, headers: req.headers, value });
    if (bytes.length >= (options.budget ?? codexRequestBudget)) { res.writeHead(413).end('Strict upload limit'); return; }
    const summary = value?.tools?.length === 0 && value?.tool_choice === 'none';
    if (summary && response.delay) await new Promise(resolve => setTimeout(resolve, response.delay));
    if (summary && value.parallel_tool_calls !== false) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'unsupported_value', param: 'parallel_tool_calls' } })); return; }
    if (summary && response.mode === 'fail') { res.writeHead(500).end('PRIVATE_UPSTREAM_ERROR'); return; }
    if (summary && response.mode === 'fail-json') { res.writeHead(429, { 'content-type': 'application/json', 'x-request-id': 'req-summary-42' }).end(JSON.stringify({ error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', param: 'input', message: 'PRIVATE_HISTORY_AND_TOKEN' } })); return; }
    if (summary && response.mode === 'fail-html') { res.writeHead(403, { 'content-type': 'text/html' }).end('<html>PRIVATE_PROXY_PAGE</html>'); return; }
    if (summary && response.overloadRemaining > 0) { response.overloadRemaining--; res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: ' + JSON.stringify({ type: 'error', error: { code: 'server_is_overloaded', message: 'PRIVATE_UPSTREAM_DETAILS' } }) + '\n\n'); return; }
    res.writeHead(200, { ...(response.mode === 'missing-type' ? {} : { 'content-type': 'text/event-stream' }), 'x-test-stream': 'preserved' });
    const output = summary && response.mode === 'tool' ? [{ type: 'function_call', name: 'bad' }] : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: summary ? 'History: diagnosed the old attempt; keep constraints and unresolved work.' : 'FINAL' }] }];
    const terminalFailure = summary && ['incomplete', 'failed-event'].includes(response.mode);
    const event = { type: terminalFailure ? `response.${response.mode === 'incomplete' ? 'incomplete' : 'failed'}` : 'response.completed', response: {
      status: terminalFailure ? response.mode === 'incomplete' ? 'incomplete' : 'failed' : 'completed', output,
      ...(response.mode === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      ...(response.mode === 'failed-event' ? { error: { code: 'server_error', message: 'PRIVATE_UPSTREAM_DETAILS' } } : {}),
      usage: { input_tokens: 123, output_tokens: 9 } } };
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

test('a verified local size refusal notifies the matching thread; compact refuses without scheduling recursion', () => fixture(async ({ url, received, guard }) => {
  const observed: any[] = []; const detach = guard.observeRequests(value => observed.push(value));
  try {
    const body = json({ model: 'test', instructions: 'KEEP_INSTRUCTIONS', input: [msg('user', text('old')), msg('assistant', text('done')), msg('user', text('PRIVATE_LATEST_' + 'x'.repeat(1_000_000)))] });
    const refusal = await request(url, body);
    assert.equal(refusal.status, 400); assert.equal(observed.length, 1);
    assert.equal(observed[0].threadId, 'thread-A'); assert.equal(observed[0].inputBytes, body.length);
    assert.match(observed[0].rejected, /分层历史处理.*原生 compact 尚未执行/);
    assert.doesNotMatch(observed[0].rejected, /PRIVATE_LATEST/);
    const compact = await request(url + '/compact', body);
    assert.equal(compact.status, 400); assert.match(compact.body.toString(), /原生 compact 请求.*未上传/);
    assert.doesNotMatch(compact.body.toString(), /尚未执行/);
    const streamedCompact = await request(url, body, { 'thread-id': 'thread-A', 'x-codex-turn-metadata': '{"request_kind":"compaction"}' });
    assert.equal(streamedCompact.status, 400); assert.match(streamedCompact.body.toString(), /原生 compact 请求.*未上传/);
    assert.doesNotMatch(streamedCompact.body.toString(), /尚未执行/);
    assert.equal(observed.length, 1); assert.equal(received.length, 0);
  } finally { detach(); }
}));

test('native thread header spellings select the right observer and isolate summary caches', () => fixture(async ({ url, received, guard }) => {
  const observed: any[] = []; const detach = guard.observeRequests(value => observed.push(value));
  try {
    for (const header of ['thread-id', 'session-id', 'x-codex-session-id', 'x-session-id']) {
      const result = await request(url, json(history()), { session_id: '', [header]: header + '-native' });
      assert.equal(result.status, 200); assert.equal(observed.at(-1).threadId, header + '-native');
    }
    assert.equal(guard.stats.cacheHits, 0);
    assert.equal((await request(url, json({ input: [] }), { 'thread-id': 'child', 'session-id': 'parent' })).status, 200);
    assert.equal(observed.at(-1).threadId, 'child', 'thread identity takes precedence over a broader session');
    const count = observed.length;
    assert.equal((await request(url, json({ input: [] }), { 'x-codex-turn-metadata': '{"request_kind":"compaction"}' })).status, 200);
    assert.equal(observed.length, count, 'successful streamed compact cannot trigger another compact');
    assert(received.every(item => item.bytes.length < 3000));
  } finally { detach(); }
}, { budget: 3000 }));

test('compact keeps a small request byte-identical and never uploads an oversized protected latest turn', () => fixture(async ({ url, received, guard }) => {
  const compact = url + '/compact', observed: string[] = [];
  const detach = guard.observeRequests(request => observed.push(request.threadId));
  try {
    const raw = json({ model: 'test', instructions: 'COMPACT_INSTRUCTIONS', input: [msg('user', text('latest'))] });
    assert.equal((await request(compact, raw)).status, 200);
    assert.deepEqual(received[0].bytes, raw);
    const invalid = { model: 'test', input: [msg('user', text('old')), msg('assistant', text('done')), msg('user', text('x'.repeat(1_000_000)))] };
    assert.equal((await request(compact, json(invalid))).status, 400);
    assert.equal(received.length, 1); assert.equal(guard.stats.summaries, 0);
    assert.deepEqual(observed, [], 'compact must never schedule itself recursively');
  } finally { detach(); }
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

test('second-level history repair drops only completed opaque reasoning after the conservative pass cannot fit', () => fixture(async ({ url, received, guard }) => {
  const oldCipher = randomBytes(12000).toString('base64'), oldTextResult = randomBytes(1500).toString('base64');
  const active = [msg('user', text('请继续')), { type: 'reasoning', id: 'active', summary: [], encrypted_content: 'ACTIVE_CIPHER', internal_chat_message_metadata_passthrough: { turn_id: 'active-turn' } },
    { type: 'function_call', call_id: 'latest', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'latest', output: [{ type: 'input_text', text: 'ACTIVE_RESULT' }] }];
  const body = { model: 'test', instructions: 'KEEP_SYSTEM', tools: [{ type: 'function', name: 'read', parameters: {} }], input: [
    msg('developer', text('KEEP_DEVELOPER')), msg('user', text('old task ' + 'x'.repeat(1000))),
    { type: 'reasoning', id: 'old', summary: [], encrypted_content: oldCipher, internal_chat_message_metadata_passthrough: { turn_id: 'completed-turn' } },
    { type: 'function_call', call_id: 'old-text', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'old-text', output: [{ type: 'input_text', text: oldTextResult }] },
    msg('assistant', text('old answer')),
    { type: 'function_call', call_id: 'media', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'media', output: [{ type: 'input_image', image_url: 'MEDIA_KEEP' }] },
    msg('assistant', text('media handled')), { type: 'native_notice', value: 'INTERNAL_KEEP' }, ...active] };
  const conservative = guardHistory(body), completed = guardHistory(body, 'completed');
  assert(conservative.protectedIndices.has(2)); assert(conservative.protectedIndices.has(4));
  assert(completed.omittedIndices.has(2)); assert(!completed.protectedIndices.has(4));
  assert(completed.protectedIndices.has(body.input.length - 3), 'active reasoning remains unchanged');
  assert(completed.protectedIndices.has(7)); assert(completed.protectedIndices.has(9));
  assert(completed.cuts.every(cut => cut <= completed.activeStart));
  const richer = guardHistory({ input: [msg('user', text('old')), { type: 'reasoning', summary: [{ type: 'summary_text', text: 'readable' }], encrypted_content: 'KEEP' },
    msg('assistant', text('done')), msg('user', text('active')), msg('user', text('<subagent_notification>KEEP</subagent_notification>'))] }, 'completed');
  assert(richer.protectedIndices.has(1), 'reasoning with readable summary remains protected');
  assert.equal(richer.activeStart, 3, 'an internal notice must not move the active-turn boundary');
  const emptySummary = guardHistory({ input: [msg('user', text('old')), { type: 'reasoning', summary: [{ type: 'summary_text', text: ' ' }], encrypted_content: 'OPAQUE' },
    msg('assistant', text('done')), msg('user', text('active'))] }, 'completed');
  assert(emptySummary.omittedIndices.has(1));
  const unknownMetadata = guardHistory({ input: [msg('user', text('old')), { type: 'reasoning', summary: [], encrypted_content: 'OPAQUE', internal_chat_message_metadata_passthrough: { turn_id: 'old', safety_flag: true } },
    msg('assistant', text('done')), msg('user', text('active'))] }, 'completed');
  assert(unknownMetadata.protectedIndices.has(1), 'unknown reasoning metadata remains protected');
  const result = await request(url, json(body)); assert.equal(result.status, 200, result.body.toString());
  assert(guard.stats.summaries > 0 && guard.stats.summaries <= 8);
  assert(received.every(item => item.bytes.length < 7000));
  assert(received.slice(0, -1).every(item => item.value.tool_choice === 'none' && !JSON.stringify(item.value).includes(oldCipher) && !JSON.stringify(item.value).includes('MEDIA_KEEP')));
  assert(received.slice(0, -1).some(item => JSON.stringify(item.value).includes(oldTextResult)));
  const final = received.at(-1)!.value;
  assert.deepEqual(final.input.slice(-active.length), active);
  assert(JSON.stringify(final).includes('MEDIA_KEEP'));
  assert(JSON.stringify(final).includes('INTERNAL_KEEP'));
  assert(!JSON.stringify(final).includes(oldCipher));
}, { budget: 7000 }));

test('a long root-session shape with 129 old reasoning items resumes below the real 1 MB wire limit', () => fixture(async ({ url, received, guard }) => {
  const old: any[] = [];
  for (let index = 0; index < 129; index++) old.push(msg('user', text(`old-${index} ` + randomBytes(400).toString('base64'))),
    { type: 'reasoning', id: `rs-${index}`, summary: [], encrypted_content: randomBytes(5300).toString('base64'), internal_chat_message_metadata_passthrough: { turn_id: `completed-${index}` } },
    msg('assistant', text(`completed-${index}`)));
  const media = randomBytes(320000).toString('base64');
  const input = [msg('developer', text('KEEP_DEVELOPER')), ...old,
    { type: 'function_call', call_id: 'media-old', name: 'inspect', arguments: '{}' },
    { type: 'function_call_output', call_id: 'media-old', output: [{ type: 'input_image', image_url: media }] },
    msg('assistant', text('media inspected')), msg('user', text('继续'))];
  const body = { model: 'test', instructions: 'KEEP_SYSTEM', input };
  const strict = guardHistory(body), lastCut = strict.cuts.at(-1)!;
  const strictProbe = json(replaceGuardHistory(body, strict, lastCut, '历史摘要', false));
  assert.equal(await encodeGuardBody(strictProbe, undefined, true), undefined, 'first-level fixed content must still exceed 1 MB');
  const result = await request(url, json(body)); assert.equal(result.status, 200, result.body.toString());
  assert(guard.stats.summaries > 0 && guard.stats.summaries <= 8);
  assert(received.every(item => item.bytes.length < codexRequestBudget));
  assert(received.slice(0, -1).every(item => item.value.tool_choice === 'none' && !JSON.stringify(item.value).includes('encrypted_content')));
  const final = received.at(-1)!.value;
  assert.deepEqual(final.input.at(-1), input.at(-1));
  assert(JSON.stringify(final).includes(media));
  assert(!JSON.stringify(final).includes('encrypted_content'));
}, { compression: true }));

test('completed historical image tool results are redacted only at the last level, retaining their text without sending image bytes', () => fixture(async ({ url, received }) => {
  const image = randomBytes(1_050_000).toString('base64');
  const oldResult = { type: 'custom_tool_call_output', call_id: 'old-image', output: [
    { type: 'input_text', text: 'The old screenshot was from a completed inspection.' },
    { type: 'input_image', image_url: image, detail: 'auto' }],
    internal_chat_message_metadata_passthrough: { turn_id: 'old-turn', create_time: 123 } };
  const input = [msg('developer', text('KEEP_DEVELOPER')), msg('user', text('old task')),
    { type: 'custom_tool_call', call_id: 'old-image', name: 'inspect', input: '{}' }, oldResult,
    msg('assistant', text('Old inspection completed.')), msg('user', text('LATEST_KEEP'))];
  const body = { model: 'test', instructions: 'KEEP_SYSTEM', input };
  const conservative = guardHistory(body), completed = guardHistory(body, 'completed'), media = guardHistory(body, 'completed_media');
  assert(conservative.protectedIndices.has(3)); assert(completed.protectedIndices.has(3));
  assert(media.omittedIndices.has(3)); assert(!media.protectedIndices.has(3));
  const result = await request(url, json(body)); assert.equal(result.status, 200, result.body.toString());
  assert(received.length > 1);
  const summaries = received.slice(0, -1).map(item => JSON.stringify(item.value));
  assert(summaries.some(value => value.includes('omitted_images') && value.includes('The old screenshot was from a completed inspection.')));
  assert(summaries.every(value => !value.includes(image)));
  const final = received.at(-1)!.value;
  assert.deepEqual(final.input[0], input[0]); assert.deepEqual(final.input.at(-1), input.at(-1));
  assert(!JSON.stringify(final).includes(image));
  assert.deepEqual(body.input, input, 'saved native history is unchanged');
}, { compression: true }));

test('first-level repair keeps completed reasoning when it can fit; oversized active turn reports counts and never uploads', () => fixture(async ({ url, received, guard }) => {
  const oldCipher = randomBytes(300).toString('base64');
  const body = { model: 'test', input: [msg('user', text('old task ' + randomBytes(3500).toString('base64'))), msg('assistant', text('first result')),
    msg('user', text('old follow-up ' + randomBytes(3500).toString('base64'))),
    { type: 'reasoning', id: 'old', summary: [], encrypted_content: oldCipher }, msg('assistant', text('done')), msg('user', text('继续'))] };
  assert.equal((await request(url, json(body))).status, 200);
  assert(JSON.stringify(received.at(-1)!.value).includes(oldCipher), 'the conservative first level must win when it succeeds');
  const prior = received.length, oversized = { ...body, input: [...body.input.slice(0, -1), msg('user', text(randomBytes(8000).toString('base64')))] };
  const failed = await request(url, json(oversized)); assert.equal(failed.status, 400);
  assert.match(failed.body.toString(), /固定内容约 \d+ 字节、最新轮次约 \d+ 字节、基础字段约 \d+ 字节、保留旧媒体约 \d+ 字节、保留旧推理约 \d+ 字节、其他旧项约 \d+ 字节、占位预检编码后 \d+ 字节/);
  assert.equal(received.length, prior, 'neither a summary nor the original inference may upload when the active turn is too large');
  assert.equal(guard.stats.forwarded, 1);
}, { budget: 7000 }));

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

for (const mode of ['fail', 'tool', 'incomplete', 'failed-event']) test(`summary ${mode} fails locally without uploading the inference`, () => fixture(async ({ url, received, response }) => {
  response.mode = mode;
  const result = await request(url, json(history())); assert.equal(result.status, 400); assert(!result.body.includes('PRIVATE_UPSTREAM_ERROR'));
  const message = JSON.parse(result.body.toString()).error.message;
  if (mode === 'tool') assert.match(message, /输出类型 function_call/);
  if (mode === 'incomplete') assert.match(message, /事件 response\.incomplete、原因 max_output_tokens/);
  if (mode === 'failed-event') { assert.match(message, /事件 response\.failed、代码 server_error/); assert.doesNotMatch(message, /PRIVATE_UPSTREAM_DETAILS/); }
  assert(received.length > 0); assert(received.every(item => item.value.tool_choice === 'none'));
}, { budget: 3000 }));

test('upstream overload retries the summary with a new identity, then forwards the original turn', () => fixture(async ({ url, received, response, guard }) => {
  response.overloadRemaining = 1;
  assert.equal((await request(url, json(history()))).status, 200);
  const summaries = received.filter(item => item.value?.tool_choice === 'none');
  assert(summaries.length >= 2);
  assert.notEqual(summaries[0].headers['x-client-request-id'], summaries[1].headers['x-client-request-id']);
  assert.equal(guard.stats.summaries, summaries.length);
  assert.equal(received.at(-1)?.value?.instructions, 'KEEP_SYSTEM');
}, { budget: 3000 }));

test('persistent upstream overload stops after three summary attempts without forwarding the original turn', () => fixture(async ({ url, received, response, guard }) => {
  response.overloadRemaining = 3;
  const result = await request(url, json(history()));
  assert.equal(result.status, 400);
  assert.match(JSON.parse(result.body.toString()).error.message, /server_is_overloaded/);
  assert.match(JSON.parse(result.body.toString()).error.message, /已尝试 3 次/);
  assert.doesNotMatch(result.body.toString(), /PRIVATE_UPSTREAM_DETAILS/);
  assert.equal(guard.stats.summaries, 3);
  assert.equal(received.length, 3);
  assert(received.every(item => item.value?.tool_choice === 'none'));
}, { budget: 3000 }));

test('summary uses independent request identity while the original inference keeps its native headers', () => fixture(async ({ url, received }) => {
  const original = { 'thread-id': 'thread-A', 'session-id': 'session-A', 'x-codex-turn-metadata': '{"turn_id":"native-turn"}', 'x-codex-turn-state': 'native-state',
    'x-codex-window-id': 'native-window', 'x-codex-routing-hint': 'native-route', 'x-client-request-id': 'native-request',
    'x-openai-subagent': 'native-agent', 'x-custom-auth': 'custom-secret', 'chatgpt-account-id': 'account-A' };
  assert.equal((await request(url, json(history()), original)).status, 200);
  assert(received.length > 1);
  for (const item of received.slice(0, -1)) {
    for (const name of ['thread-id', 'session-id', 'session_id', 'x-codex-turn-metadata', 'x-codex-turn-state', 'x-codex-window-id', 'x-codex-routing-hint', 'x-openai-subagent']) assert.equal(item.headers[name], undefined, name);
    assert.match(String(item.headers['x-client-request-id']), /^[0-9a-f-]{36}$/);
    assert.notEqual(item.headers['x-client-request-id'], original['x-client-request-id']);
    assert.equal(item.headers['x-custom-auth'], original['x-custom-auth']);
    assert.equal(item.headers['chatgpt-account-id'], original['chatgpt-account-id']);
  }
  const final = received.at(-1)!.headers;
  for (const [name, value] of Object.entries(original)) assert.equal(final[name], value, name);
  assert.equal(final.session_id, 'thread-A');
}, { budget: 3000 }));

for (const mode of ['fail-json', 'fail-html']) test(`summary ${mode} reports safe upstream diagnostics without leaking its body`, () => fixture(async ({ url, received, response }) => {
  response.mode = mode;
  const result = await request(url, json(history()));
  assert.equal(result.status, 400);
  const message = JSON.parse(result.body.toString()).error.message;
  assert.match(message, mode === 'fail-json' ? /HTTP 429；类型 rate_limit_error；代码 rate_limit_exceeded；参数 input；响应 application\/json；上游请求 req-summary-42；上传 \d+ 字节/ : /HTTP 403；响应 text\/html；上传 \d+ 字节/);
  assert.doesNotMatch(message, /PRIVATE_|Bearer|custom-secret/);
  assert(received.every(item => item.value.tool_choice === 'none'), 'the original inference must not upload');
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
  try { const result = await request((await guard.start()) + '/responses', json({ input: 'ok' })); assert.equal(result.status, 400); assert.equal(connects, 1); assert(result.body.includes('未切换网络通路')); assert(result.body.includes('PROXY_403')); }
  finally { await guard.close(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
  assert.throws(() => guardProxy(new URL('https://example.com'), { ...direct, HTTPS_PROXY: 'socks5://localhost:1' }), /不支持/);
});

test('provider override preserves custom identity, headers and upstream; builtin uses a temporary alias; configuration remains untouched', async () => {
  for (const builtin of [false, true]) {
    const config = { model_provider: builtin ? 'openai' : 'custom', model_providers: { custom: { name: 'Private', base_url: 'https://custom.invalid/api', env_key: 'PRIVATE_API_KEY', http_headers: { 'x-user': 'retained' }, query_params: { 'api-version': 'test' }, supports_request_compression: true } } };
    const before = structuredClone(config);
    const rpc = { request: async (method: string) => method === 'config/read' ? { config } : { account: { type: 'chatgpt' } } } as unknown as AgentRpc;
    const { guard, config: overlay } = await createCodexRequestGuard(rpc, '.', { ...direct, HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '*' });
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

test('summary ceiling rejects without ever forwarding the oversized original', () => fixture(async ({ url, received, guard }) => {
  const body = history();
  body.input = Array.from({ length: 40 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', text('round-' + i + 'x'.repeat(800))));
  body.input.push(msg('user', text('LATEST')));
  assert.equal((await request(url, json(body))).status, 400);
  assert.equal(guard.stats.summaries, 16);
  assert.equal(received.length, 16); assert(received.every(item => item.bytes.length < 3000 && item.value.tool_choice === 'none'));
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
