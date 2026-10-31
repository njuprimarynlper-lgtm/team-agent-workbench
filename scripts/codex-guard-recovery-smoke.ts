// Installed CLI + loopback model fixture, isolated home and fake key. No external inference.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/core/agents';
import { resolveProvider } from '../src/core/providers';
import type { AgentSession } from '../src/shared/types';

async function main() {
  const refused = process.argv.includes('--refused');
  const root = path.resolve('.test-data', 'guard-recovery-cli-' + Date.now());
  await fs.mkdir(root, { recursive: true });
  const latest = 'KEEP_LATEST_INPUT_' + 'x'.repeat(260_000);
  const uploads: { route: string; bytes: number; value: any }[] = [], events: any[] = [], calls: { method: string; params: any }[] = [], observations: any[] = [];
  const service = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks), value = JSON.parse(body.toString());
    uploads.push({ route: req.url!, bytes: body.length, value });
    if (body.length >= 1_000_000) { res.writeHead(413).end(); return; }
    assert.equal(req.headers.authorization, 'Bearer LOCAL_FAKE_KEY');
    if (req.url?.endsWith('/compact')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'cmp_fixture', object: 'response.compaction', created_at: 0,
        output: [...value.input.filter((item: any) => item.role === 'user' || item.role === 'developer'), { type: 'compaction', encrypted_content: 'FAKE_NATIVE_STATE' }],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } })); return;
    }
    const compact = JSON.parse(String(req.headers['x-codex-turn-metadata'] || '{}')).request_kind === 'compaction';
    const item = compact ? { type: 'compaction', id: 'cmp_' + uploads.length, encrypted_content: 'FAKE_NATIVE_STATE' }
      : { type: 'message', id: 'msg_' + uploads.length, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'RECOVERED_OK', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: 'resp_' + uploads.length, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      ...(!compact ? [{ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'RECOVERED_OK' }] : []),
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_' + uploads.length, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.end();
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  const upstream = `http://127.0.0.1:${(service.address() as any).port}/v1`;
  // OpenAI name enables the native remote compact path; compression stays disabled
  // to exercise the strict wire boundary with a deterministic synthetic payload.
  const config = `model_provider = "fixture"\nmodel = "gpt-6.1-sol"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.fixture]\nname = "OpenAI"\nbase_url = "${upstream}"\nwire_api = "responses"\nenv_key = "GUARD_TEST_KEY"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`;
  await fs.writeFile(path.join(root, 'config.toml'), config);
  const env = { CODEX_HOME: root, GUARD_TEST_KEY: 'LOCAL_FAKE_KEY', OPENAI_BASE_URL: upstream,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '' };
  const session = { id: 'native-smoke', provider: 'codex', purpose: 'work', cwd: root, status: 'idle', messages: [], approvals: [], sources: [], model: 'gpt-6.1-sol', permissionMode: 'inherit' } as unknown as AgentSession;
  let done = 0;
  const runtime = new AgentRuntime(session, await resolveProvider('codex'), { changed() {}, event(value) { events.push(value); }, done() { done++; } }, undefined, env, undefined, false, true);
  const request = runtime.rpc.request.bind(runtime.rpc);
  runtime.rpc.request = (method, params, timeout, written) => { calls.push({ method, params }); return request(method, params, timeout, written); };
  try {
    await runtime.start();
    (runtime as any).requestGuard.observeRequests((value: any) => observations.push(value));
    await runtime.rpc.request('thread/inject_items', { threadId: session.nativeId, items: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'OLD_USER' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Readable native reasoning must not be silently dropped.' }], encrypted_content: 'r'.repeat(refused ? 700_000 : 600_000) },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OLD_ANSWER' }] },
    ] });
    await runtime.prompt(latest);
    const deadline = Date.now() + 60_000;
    while (!done) { if (Date.now() > deadline) throw Error('Native recovery timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(calls.filter(call => call.method === 'thread/compact/start').length, 1);
    assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(session.messages.filter(message => message.role === 'user').length, 1);
    assert.equal(observations.length, 1, 'native compact never schedules itself, including /responses streaming');
    if (refused) {
      assert.equal(session.status, 'error'); assert.match(session.error!, /原生 compact 请求.*未上传/);
      assert.doesNotMatch(session.error!, /尚未执行/); assert.equal(uploads.length, 0);
      assert(events.some(event => event.reason === 'local-rejection' && event.status === 'failed'));
    } else {
      assert.equal(session.status, 'idle', session.error);
      assert(events.some(event => event.method === 'workbench/autoCompact' && event.status === 'completed'));
      // Verify the real CLI retains the accepted user in its read history and
      // permits empty-input continuation without re-appending that user message.
      const current = (await runtime.rpc.request('thread/read', { threadId: session.nativeId, includeTurns: true })).thread;
      const users = current.turns.flatMap((turn: any) => turn.items).filter((item: any) => item.type === 'userMessage');
      assert.equal(users.at(-1).content[0].text, latest);
      const completed = events.filter(event => event.method === 'turn/completed').length;
      await runtime.rpc.request('turn/start', { threadId: session.nativeId, input: [] });
      while (events.filter(event => event.method === 'turn/completed').length === completed) {
        if (Date.now() > deadline) throw Error('Continuation timed out'); await new Promise(resolve => setTimeout(resolve, 20));
      }
      const resumed = uploads.at(-1)!.value;
      assert(resumed.input.some((item: any) => item.type === 'compaction' && item.encrypted_content === 'FAKE_NATIVE_STATE'));
      assert(uploads.every(upload => upload.bytes < 1_000_000));
    }
    assert.equal(await fs.readFile(path.join(root, 'config.toml'), 'utf8'), config);
    console.log(JSON.stringify({ passed: true, scenario: refused ? 'local-refusal-compact-also-refused' : 'proactive-native-compact-and-continuation', uploads: uploads.map(({ route, bytes }) => ({ route, bytes })), configUnchanged: true }));
  } catch (error) {
    // Never print the large synthetic inputs or any real authentication/configuration.
    console.error(JSON.stringify({ status: session.status, error: session.error, calls: calls.map(call => call.method),
      uploads: uploads.map(({ route, bytes }) => ({ route, bytes })), observations, nativeId: session.nativeId, terminalEvents: events.filter(event => event.method === 'error' || event.method === 'turn/completed'), maintenance: events.filter(event => event.method === 'workbench/autoCompact') })); throw error;
  } finally { await runtime.close(); service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
