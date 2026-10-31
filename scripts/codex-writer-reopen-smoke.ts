// Real installed CLI and Workbench, isolated homes and a loopback model fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { Workbench } from '../src/core/workbench';
import { CodexSideRpc } from '../src/core/codex-side-rpc';
import { AgentRuntime } from '../src/core/agents';
import { JsonRpc } from '../src/core/rpc';
import { resolveProvider } from '../src/core/providers';
import { grantTestWorkspace, offlineProjectId } from '../tests/fixtures/offline-workspace';

async function until(check: () => boolean) {
  const deadline = Date.now() + 30_000;
  while (!check()) { if (Date.now() > deadline) throw Error('Writer lifecycle smoke timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function main() {
  const root = path.resolve('.test-data', 'writer-reopen-cli-' + Date.now()), personal = path.join(root, 'personal');
  await fs.mkdir(personal, { recursive: true });
  const held = new Map<string, { res: http.ServerResponse; finish: () => void }>(), uploads: number[] = [], failures: string[] = [];
  const server = http.createServer((req, res) => { void (async () => {
    if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), body = JSON.parse(bytes.toString()); uploads.push(bytes.length);
    assert(bytes.length < 1_000_000); assert.equal(req.headers.authorization, 'Bearer LOCAL_FAKE_KEY');
    const text = body.input.findLast((item: any) => item.role === 'user')?.content?.map((part: any) => part.text || '').join('\n') || '';
    const label = text.includes('CHILD_RUNNING') ? 'CHILD_RUNNING' : text.includes('ROOT_TO_STOP') ? 'ROOT_TO_STOP' : '';
    const item = { type: 'message', id: 'msg_' + uploads.length, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'WRITER_OK', annotations: [] }] };
    const responseId = 'resp_' + uploads.length;
    const emit = (value: unknown) => res.write('data: ' + JSON.stringify(value) + '\n\n');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    emit({ type: 'response.created', response: { id: responseId, status: 'in_progress', output: [] } });
    const finish = () => {
      emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'WRITER_OK' });
      emit({ type: 'response.output_item.done', output_index: 0, item });
      emit({ type: 'response.completed', response: { id: responseId, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
      res.end();
    };
    if (label) { held.set(label, { res, finish }); res.once('close', () => held.delete(label)); } else finish();
  })().catch(error => { failures.push(error.message); res.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const upstream = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const config = `model_provider = "writer_fixture"\nmodel = "gpt-6.1-sol"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.writer_fixture]\nname = "Writer fixture"\nbase_url = "${upstream}"\nwire_api = "responses"\nenv_key = "WRITER_FIXTURE_KEY"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`;
  await fs.writeFile(path.join(personal, 'config.toml'), config);
  const env = { CODEX_HOME: personal, WRITER_FIXTURE_KEY: 'LOCAL_FAKE_KEY', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const wb = new Workbench(path.join(root, 'workbench'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    wb.store.settings.providerPaths.codex = await resolveProvider('codex'); wb.store.settings.codexRequestGuard = true;
    const parent = await wb.createSession('codex', root, offlineProjectId, 'work', undefined, 'gpt-6.1-sol', 'inherit', false, 'direct');
    assert.equal(await wb.send(parent.id, 'ROOT_INITIAL'), true); await until(() => parent.status !== 'running');
    assert.equal(parent.status, 'idle', parent.error);
    const owner = (wb as any).runtimes.get(parent.id) as AgentRuntime, writer = owner.rpc as JsonRpc, pid = writer.process.pid, threadId = parent.nativeId;
    const child = await wb.forkSubsession(parent.id, '真实 CLI 子会话');
    assert.equal(await wb.send(child.id, 'CHILD_RUNNING'), true); await until(() => held.has('CHILD_RUNNING'));
    assert.equal(await wb.send(parent.id, 'ROOT_TO_STOP'), true); await until(() => held.has('ROOT_TO_STOP'));
    await wb.stop(parent.id); await until(() => !held.has('ROOT_TO_STOP'));
    assert.equal(child.status, 'running'); assert(held.has('CHILD_RUNNING')); assert.equal(writer.process.exitCode, null);
    assert.equal(await wb.send(parent.id, 'ROOT_REOPEN'), true); await until(() => parent.status !== 'running');
    assert.equal(parent.status, 'idle', parent.error); assert.equal(parent.nativeId, threadId);
    const reopened = (wb as any).runtimes.get(parent.id) as AgentRuntime;
    assert(reopened.rpc instanceof CodexSideRpc); assert.equal(reopened.rpc.owner, writer); assert.equal(writer.process.pid, pid);
    assert.equal(parent.messages.filter(item => item.role === 'user').length, 3);
    assert.equal(child.messages.filter(item => item.role === 'user').length, 1);
    held.get('CHILD_RUNNING')!.finish(); await until(() => child.status !== 'running'); assert.equal(child.status, 'idle', child.error);
    await wb.closeSession(child.id); assert.equal(writer.process.exitCode, null, 'reopened root still owns a lease');
    await wb.closeSession(parent.id); await owner.waitForWriterExit(); await until(() => writer.process.exitCode !== null || writer.process.signalCode !== null);
    assert.equal((wb as any).codexWriters.size, 0); assert.deepEqual(failures, []);
    assert.equal(await fs.readFile(path.join(personal, 'config.toml'), 'utf8'), config);
    console.log(JSON.stringify({ passed: true, sameWriterProcess: true, parentReopened: true, childUninterrupted: true, duplicateInputs: false, requestGuardEnabled: true, requests: uploads.length, maxUploadBytes: Math.max(...uploads), configUnchanged: true }));
  } finally {
    await wb.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
