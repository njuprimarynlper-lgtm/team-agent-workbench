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
  const requests: { model: string; effort: string; text: string; users: string[] }[] = [];
  const request = (label: string) => requests.findLast(value => value.text.startsWith(label))!;
  const server = http.createServer((req, res) => { void (async () => {
    if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), body = JSON.parse(bytes.toString()); uploads.push(bytes.length);
    assert(bytes.length < 1_000_000); assert.equal(req.headers.authorization, 'Bearer LOCAL_FAKE_KEY');
    const users = body.input.filter((item: any) => item.role === 'user').map((item: any) => item.content?.map((part: any) => part.text || '').join('\n') || '');
    const text = users.at(-1) || '';
    requests.push({ model: body.model, effort: body.reasoning?.effort, text, users });
    const label = text.startsWith('CHILD_RUNNING') ? 'CHILD_RUNNING' : text.startsWith('ROOT_TO_STOP') ? 'ROOT_TO_STOP' : '';
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
  const config = `model_provider = "writer_fixture"\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.writer_fixture]\nname = "Writer fixture"\nbase_url = "${upstream}"\nwire_api = "responses"\nenv_key = "WRITER_FIXTURE_KEY"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`;
  await fs.writeFile(path.join(personal, 'config.toml'), config);
  const env = { CODEX_HOME: personal, WRITER_FIXTURE_KEY: 'LOCAL_FAKE_KEY', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  let wb = new Workbench(path.join(root, 'workbench'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    wb.store.settings.providerPaths.codex = await resolveProvider('codex'); wb.store.settings.codexRequestGuard = true;
    const parent = await wb.createSession('codex', root, offlineProjectId, 'work', undefined, 'gpt-6.1-sol', 'inherit', false, 'direct');
    assert.equal(await wb.send(parent.id, 'ROOT_INITIAL'), true); await until(() => parent.status !== 'running');
    assert.equal(parent.status, 'idle', parent.error);
    const owner = (wb as any).runtimes.get(parent.id) as AgentRuntime, writer = owner.rpc as JsonRpc, pid = writer.process.pid, threadId = parent.nativeId;
    const child = await wb.forkSubsession(parent.id, '真实 CLI 子会话');
    assert.equal(await wb.send(child.id, 'CHILD_INITIAL'), true); await until(() => child.status !== 'running'); assert.equal(child.status, 'idle', child.error);
    const childRuntime = (wb as any).runtimes.get(child.id), childId = child.nativeId;
    const history = structuredClone(child.messages);
    await wb.changeModel(child.id, 'gpt-6-astra'); await wb.changeReasoningEffort(child.id, 'low');
    assert((wb as any).runtimes.get(child.id) === childRuntime); assert.deepEqual(child.messages, history);
    assert.equal(await wb.send(child.id, 'CHILD_RUNNING'), true); await until(() => held.has('CHILD_RUNNING'));
    assert.equal(request('CHILD_RUNNING').model, 'gpt-6-astra'); assert.equal(request('CHILD_RUNNING').effort, 'low');
    await wb.changeModel(child.id, 'gpt-6.1-sol'); await wb.changeReasoningEffort(child.id, 'high');
    assert.equal(child.status, 'running'); assert.equal(child.settingsPending, true); assert.equal(child.resolvedModel, 'gpt-6-astra');
    assert((wb as any).runtimes.get(child.id) === childRuntime);
    await wb.changeModel(parent.id, 'gpt-6-astra');
    assert((wb as any).runtimes.get(parent.id) === owner); assert.equal(writer.process.pid, pid);
    assert.equal(await wb.send(parent.id, 'ROOT_TO_STOP'), true); await until(() => held.has('ROOT_TO_STOP'));
    await wb.stop(parent.id); await until(() => !held.has('ROOT_TO_STOP'));
    assert.equal(child.status, 'running'); assert(held.has('CHILD_RUNNING')); assert.equal(writer.process.exitCode, null);
    assert.equal(await wb.send(parent.id, 'ROOT_REOPEN'), true); await until(() => parent.status !== 'running');
    assert.equal(parent.status, 'idle', parent.error); assert.equal(parent.nativeId, threadId);
    const reopened = (wb as any).runtimes.get(parent.id) as AgentRuntime;
    assert(reopened.rpc instanceof CodexSideRpc); assert.equal(reopened.rpc.owner, writer); assert.equal(writer.process.pid, pid);
    assert.equal(parent.messages.filter(item => item.role === 'user').length, 3);
    assert.equal(child.messages.filter(item => item.role === 'user').length, 2);
    held.get('CHILD_RUNNING')!.finish(); await until(() => child.status !== 'running'); assert.equal(child.status, 'idle', child.error);
    assert.equal(await wb.send(child.id, 'CHILD_NEXT_MODEL'), true); await until(() => child.status !== 'running'); assert.equal(child.status, 'idle', child.error);
    assert.equal(request('CHILD_NEXT_MODEL').model, 'gpt-6.1-sol'); assert.equal(request('CHILD_NEXT_MODEL').effort, 'high');
    assert.equal(child.resolvedModel, 'gpt-6.1-sol'); assert.equal(child.settingsPending, undefined);
    assert((wb as any).runtimes.get(child.id) === childRuntime);
    await wb.changeReasoningEffort(child.id, null);
    assert.equal(await wb.send(child.id, 'CHILD_DEFAULT_EFFORT'), true); await until(() => child.status !== 'running'); assert.equal(child.status, 'idle', child.error);
    assert.equal(request('CHILD_DEFAULT_EFFORT').effort, 'medium'); assert((wb as any).runtimes.get(child.id) === childRuntime);
    // Model-only updates must not discard a pending permissions reconnect.
    assert.equal(await wb.send(child.id, 'CHILD_RUNNING'), true); await until(() => held.has('CHILD_RUNNING'));
    await wb.changePermissions(child.id, 'full'); await wb.changeModel(child.id, 'gpt-6-astra');
    held.get('CHILD_RUNNING')!.finish(); await until(() => child.status !== 'running');
    await wb.changeReasoningEffort(child.id, 'medium'); assert.equal(child.settingsPending, true);
    assert.equal(await wb.send(child.id, 'CHILD_NEW_PERMISSION'), true); await until(() => child.status !== 'running'); assert.equal(child.status, 'idle', child.error);
    const reconfigured = (wb as any).runtimes.get(child.id) as AgentRuntime;
    assert(reconfigured !== childRuntime && reconfigured.rpc instanceof CodexSideRpc); assert.equal(reconfigured.rpc.owner, writer);
    assert.equal(request('CHILD_NEW_PERMISSION').model, 'gpt-6-astra'); assert.equal(request('CHILD_NEW_PERMISSION').effort, 'medium');
    assert.equal(child.nativeId, childId); assert.equal(child.permissions?.sandbox, 'dangerFullAccess');
    assert.equal(child.messages.filter(item => item.role === 'user').length, 6);
    await wb.closeSession(child.id); assert.equal(writer.process.exitCode, null, 'reopened root still owns a lease');
    await wb.closeSession(parent.id); await owner.waitForWriterExit(); await until(() => writer.process.exitCode !== null || writer.process.signalCode !== null);
    assert.equal((wb as any).codexWriters.size, 0); assert.deepEqual(failures, []);
    await wb.close(); wb = new Workbench(path.join(root, 'workbench'), () => {}, () => {});
    await wb.store.init(); grantTestWorkspace(wb, root);
    const restored = wb.store.sessions.find(session => session.id === child.id)!;
    assert.equal(restored.model, 'gpt-6-astra'); assert.equal(restored.reasoningEffort, 'medium'); assert.equal(restored.nativeId, childId);
    assert.deepEqual(restored.messages, JSON.parse(JSON.stringify(child.messages)));
    await wb.reopenSession(restored.id);
    assert.equal(await wb.send(restored.id, 'CHILD_AFTER_RESTART'), true); await until(() => restored.status !== 'running'); assert.equal(restored.status, 'idle', restored.error);
    assert.equal(restored.nativeId, childId); assert.equal(restored.messages.filter(item => item.role === 'user').length, 7);
    assert.equal(request('CHILD_AFTER_RESTART').model, 'gpt-6-astra'); assert.equal(request('CHILD_AFTER_RESTART').effort, 'medium');
    for (const label of ['CHILD_INITIAL', 'CHILD_NEXT_MODEL', 'CHILD_DEFAULT_EFFORT', 'CHILD_NEW_PERMISSION', 'CHILD_AFTER_RESTART']) {
      assert.equal(requests.filter(request => request.text.startsWith(label)).length, 1, label + ' must not be sent twice');
      assert.equal(request('CHILD_AFTER_RESTART').users.filter(text => text.startsWith(label)).length, 1, label + ' history must survive exactly once');
    }
    assert.equal(request('CHILD_AFTER_RESTART').users.filter(text => text.startsWith('CHILD_RUNNING')).length, 2);
    assert.equal(await fs.readFile(path.join(personal, 'config.toml'), 'utf8'), config);
    console.log(JSON.stringify({ passed: true, sameWriterProcess: true, parentReopened: true, childUninterrupted: true, modelSwitchIdle: true, modelSwitchRunning: true, parentModelSwitch: true, deferredPermissions: true, restartRestored: true, duplicateInputs: false, requestGuardEnabled: true, requests: uploads.length, maxUploadBytes: Math.max(...uploads), configUnchanged: true }));
  } finally {
    await wb.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
