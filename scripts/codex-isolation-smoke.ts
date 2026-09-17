import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { JsonRpc } from '../src/core/rpc';
import { resolveProvider } from '../src/core/providers';
import { grantTestWorkspace, offlineProjectId } from '../tests/fixtures/offline-workspace';

async function main() {
  const data = path.resolve('.test-data', 'native-codex-isolation-' + Date.now());
  const personal = path.join(data, 'personal'), workspace = path.join(data, 'workspace');
  await fs.mkdir(personal, { recursive: true }); await fs.mkdir(workspace);
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    const id = 'msg_' + randomUUID(), responseId = 'resp_' + randomUUID();
    const text = '记住了隔离验证口令 WB_CONTEXT_20260917。';
    const item = { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: responseId, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: id, output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: responseId, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
    ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  await fs.writeFile(path.join(personal, 'config.toml'), `model_provider = "workbench_fixture"\nmodel = "fixture-model"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n[model_providers.workbench_fixture]\nname = "Local test only"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
  const oldHome = process.env.CODEX_HOME, oldSqlite = process.env.CODEX_SQLITE_HOME, oldNoProxy = process.env.NO_PROXY, oldNoProxyLower = process.env.no_proxy;
  process.env.CODEX_HOME = personal; delete process.env.CODEX_SQLITE_HOME;
  process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
  const executable = await resolveProvider('codex');
  let wb = new Workbench(path.join(data, 'workbench'), () => {}, () => {});
  let source: JsonRpc | undefined;
  const wait = async (s: any) => { const deadline = Date.now() + 30000; while (['starting', 'running', 'approval'].includes(s.status)) { if (Date.now() > deadline) throw new Error('Native turn timed out: ' + s.status); await new Promise(r => setTimeout(r, 50)); } assert.equal(s.status, 'idle', s.error); };
  try {
    await wb.store.init(); grantTestWorkspace(wb, workspace); wb.store.settings.providerPaths.codex = executable;
    const s = await wb.createSession('codex', workspace, offlineProjectId, 'work', undefined, 'fixture-model', 'inherit');
    await wb.send(s.id, '请记住口令 WB_CONTEXT_20260917。'); await wait(s);
    const nativeId = s.nativeId; assert(nativeId); assert.equal(s.codexStorage, 'workbench');
    assert(s.nativePath?.startsWith(path.join(data, 'workbench', 'codex-home')));
    await wb.changePermissions(s.id, 'full');
    await wb.send(s.id, '刚才的口令是什么？'); await wait(s);
    assert.equal(s.nativeId, nativeId); assert.equal(s.permissions?.sandbox, 'dangerFullAccess');
    assert(JSON.stringify(requests.at(-1)?.input).includes('请记住口令 WB_CONTEXT_20260917'), 'previous user context must reach the next model request');
    assert(JSON.stringify(requests.at(-1)?.input).includes('记住了隔离验证口令'), 'previous assistant context must reach the next model request');
    await wb.close();
    wb = new Workbench(path.join(data, 'workbench'), () => {}, () => {});
    await wb.store.init(); grantTestWorkspace(wb, workspace);
    await wb.send(s.id, '重启后继续回答之前的口令。'); const restored = wb.session(s.id); await wait(restored);
    assert.equal(restored.nativeId, nativeId);
    assert(JSON.stringify(requests.at(-1)?.input).includes('请记住口令 WB_CONTEXT_20260917'));
    source = new JsonRpc(executable, ['app-server'], workspace, false);
    await source.request('initialize', { clientInfo: { name: 'workbench_isolation_check', version: '0.7.0' } }); source.notify('initialized');
    const listed = await source.request('thread/list', { limit: 100, sourceKinds: [], modelProviders: [] });
    assert(!listed.data.some((t: any) => t.id === nativeId), 'default Codex must not list the workbench session');
    const read = await source.request('thread/read', { threadId: nativeId }).catch(() => null);
    assert.equal(read, null, 'default Codex must not be able to load isolated history by id');
    assert(await fs.readFile(restored.nativePath!, 'utf8').then(raw => raw.includes('WB_CONTEXT_20260917')));
    assert(!(await fs.readdir(path.join(data, 'workbench', 'codex-home'))).includes('auth.json'));
    const legacy = await source.request('thread/start', { cwd: workspace, model: 'fixture-model', sandbox: 'read-only', approvalPolicy: 'on-request' });
    const legacyDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Legacy fixture timed out')), 30000);
      source!.on('message', m => { if (m.method === 'turn/completed') { clearTimeout(timer); resolve(); } });
    });
    await source.request('turn/start', { threadId: legacy.thread.id, input: [{ type: 'text', text: '旧会话迁移前的口令 LEGACY_CONTEXT_20260917。', text_elements: [] }] }); await legacyDone;
    await source.close(); source = undefined;
    const original = await fs.readFile(legacy.thread.path, 'utf8');
    const migrated = await wb.createSession('codex', workspace, offlineProjectId);
    migrated.nativeId = legacy.thread.id; migrated.nativePath = legacy.thread.path;
    await wb.send(migrated.id, '迁移后继续之前的工作。'); await wait(migrated);
    assert.equal(migrated.nativeId, legacy.thread.id); assert.equal(migrated.codexStorage, 'workbench');
    assert.notEqual(migrated.nativePath, legacy.thread.path);
    assert(JSON.stringify(requests.at(-1)?.input).includes('旧会话迁移前的口令 LEGACY_CONTEXT_20260917'));
    assert.equal(await fs.readFile(legacy.thread.path, 'utf8'), original, 'continuing migrated history must not change the desktop copy');
    const report = { passed: true, data, nativeId, cases: ['new thread absent from personal Codex list', 'default Codex cannot read isolated id', 'permission change preserves user and assistant model context', 'restart preserves context and native id', 'native rollout retained', 'no auth file copied', 'legacy context migrates without changing desktop copy'], modelRequests: requests.length };
    await fs.writeFile(path.join(data, 'verification.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } finally {
    await source?.close(); await wb.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    if (oldSqlite === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = oldSqlite;
    if (oldNoProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = oldNoProxy;
    if (oldNoProxyLower === undefined) delete process.env.no_proxy; else process.env.no_proxy = oldNoProxyLower;
  }
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
