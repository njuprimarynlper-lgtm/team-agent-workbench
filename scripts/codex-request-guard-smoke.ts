// Real local CLI + synthetic loopback model service. No login or external inference.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { JsonRpc } from '../src/core/rpc';
import { resolveProvider } from '../src/core/providers';
import { createCodexRequestGuard } from '../src/core/codex-request-guard';

async function main() {
const root = path.resolve('.test-data', 'request-guard-cli-' + Date.now()); await fs.mkdir(root, { recursive: true });
const received: { bytes: number; summary: boolean }[] = [];
const service = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/responses')) { res.writeHead(404).end(); return; }
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks), value = JSON.parse((req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString()); received.push({ bytes: bytes.length, summary: value.tool_choice === 'none' });
  assert.equal(req.headers.authorization, 'Bearer LOCAL_FAKE_KEY');
  const item = { type: 'message', id: 'msg_' + received.length, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'GUARD_OK', annotations: [] }] };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { id: 'resp_' + received.length, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'GUARD_OK' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_' + received.length, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
  ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
  res.end();
});
await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
const upstream = `http://127.0.0.1:${(service.address() as any).port}/v1`;
const provider = process.argv.includes('--builtin') ? 'openai' : 'guard_fixture';
await fs.writeFile(path.join(root, 'config.toml'), `model_provider = "${provider}"\nmodel = "gpt-6.1-sol"\n[model_providers.${provider}]\nname = "Guard fixture"\nbase_url = "${upstream}"\nwire_api = "responses"\nenv_key = "GUARD_TEST_KEY"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
if (provider === 'openai') {
  await fs.writeFile(path.join(root, 'config.toml'), 'model_provider = "openai"\nmodel = "gpt-6.1-sol"\nopenai_base_url = "' + upstream + '"\n');
  await fs.writeFile(path.join(root, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'LOCAL_FAKE_KEY' }));
}
const before = await fs.readFile(path.join(root, 'config.toml'));
const env = { CODEX_HOME: root, GUARD_TEST_KEY: 'LOCAL_FAKE_KEY', OPENAI_BASE_URL: upstream, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '' };
const executable = await resolveProvider('codex');
let rpc = new JsonRpc(executable, ['app-server'], root, false, env);
let protectedRoute: Awaited<ReturnType<typeof createCodexRequestGuard>> | undefined;
const events: any[] = []; rpc.on('message', event => { if (event.id !== undefined) rpc.reject(event.id, 'Synthetic check does not authorize tools'); else events.push(event); });
const wait = async (count: number) => { const until = Date.now() + 60000; while (events.filter(e => e.method === 'turn/completed').length < count) { if (Date.now() > until) throw new Error('CLI smoke timeout'); await new Promise(resolve => setTimeout(resolve, 50)); } return events.filter(e => e.method === 'turn/completed').at(-1); };
try {
  await rpc.request('initialize', { clientInfo: { name: 'workbench_guard_test', version: '1' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized');
  protectedRoute = await createCodexRequestGuard(rpc, root, env);
  const started = await rpc.request('thread/start', { cwd: root, model: 'gpt-6.1-sol', approvalPolicy: 'never', sandbox: 'read-only', config: protectedRoute.config });
  assert.equal(started.modelProvider, protectedRoute.config.model_provider); const threadId = started.thread.id;
  await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Only reply GUARD_OK. Do not use tools.' }] });
  assert.equal((await wait(1)).params.turn.status, 'completed'); assert.equal(received.length, 1); assert(received[0].bytes < 1_000_000);
  const fork = await rpc.request('thread/fork', { threadId, cwd: root, ephemeral: true, excludeTurns: true, config: protectedRoute.config, modelProvider: protectedRoute.config.model_provider });
  assert.equal(fork.modelProvider, protectedRoute.config.model_provider);
  assert.notEqual(fork.thread.id, threadId);
  await rpc.request('thread/unsubscribe', { threadId: fork.thread.id });
  const oversized = await rpc.request('thread/start', { cwd: root, model: 'gpt-6.1-sol', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, config: protectedRoute.config });
  // CJK bytes exceed the wire budget while remaining below the CLI character cap.
  const random = randomBytes(1600000); const randomText = Array.from({ length: 800000 }, (_, i) => String.fromCharCode(0x4e00 + random.readUInt16LE(i * 2) % 20000)).join('');
  await rpc.request('turn/start', { threadId: oversized.thread.id, input: [{ type: 'text', text: randomText }] });
  assert.equal((await wait(2)).params.turn.status, 'failed');
  assert.equal(received.length, 1, 'oversized original must never reach model service');
  assert.equal(protectedRoute.guard.stats.forwarded, 1); assert.equal(protectedRoute.guard.stats.rejected, 1);
  await rpc.close(); await protectedRoute.guard.close();
  rpc = new JsonRpc(executable, ['app-server'], root, false, env); events.length = 0;
  rpc.on('message', event => { if (event.id !== undefined) rpc.reject(event.id, 'No tools'); else events.push(event); });
  await rpc.request('initialize', { clientInfo: { name: 'workbench_guard_test', version: '1' } }); rpc.notify('initialized');
  const previous = await rpc.request('thread/read', { threadId, includeTurns: false }); const restore = previous.thread.modelProvider === 'workbench_guard_openai' ? { modelProvider: provider, config: { model_provider: provider } } : {};
  const resumed = await rpc.request('thread/resume', { threadId, cwd: root, approvalPolicy: 'never', sandbox: 'read-only', ...restore });
  assert.equal(resumed.modelProvider, provider, 'disabled protection must restore the current original provider');
  await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Continue; only reply GUARD_OK.' }] });
  assert.equal((await wait(1)).params.turn.status, 'completed'); assert.equal(received.length, 2);
  assert.deepEqual(await fs.readFile(path.join(root, 'config.toml')), before);
  console.log(JSON.stringify({ passed: true, provider, underBudgetBytes: received[0].bytes, oversizedRejectedLocally: true, reconnectWithoutGuard: true, configUnchanged: true }));
} catch (error) {
  console.error(JSON.stringify({ received, stats: protectedRoute?.guard.stats, errors: events.filter(e => e.method === 'error' || e.method === 'turn/completed').map(e => e.params) })); throw error;
} finally { await rpc.close(); await protectedRoute?.guard.close(); service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
