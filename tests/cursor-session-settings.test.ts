import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Shared JS fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

async function fixture(state: Record<string, unknown> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-cursor-settings-'));
  const cli = await authLauncher(root, { status: 'ready', turn: 'success', ...state });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {}, undefined, route => route === 'management'
    ? { HTTPS_PROXY: 'http://127.0.0.1:18001', TEAM_AGENT_MANAGEMENT_PROXY: '1' }
    : { HTTPS_PROXY: '', TEAM_AGENT_MANAGEMENT_PROXY: '' });
  await wb.store.init(); grantTestWorkspace(wb, root);
  wb.store.settings.providerPaths.cursor = cli.launcher;
  wb.store.settings.egress = { enabled: true, host: '127.0.0.1', port: 443, certificateFingerprint: 'A'.repeat(64) };
  const session = await wb.createSession('cursor', root, offlineProjectId, 'work', undefined, undefined, 'inherit', false, 'direct');
  const calls = async () => (await fs.readFile(path.join(root, 'rpc-calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, wb, session, cli, calls, close: async () => { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
const until = async (check: () => boolean | Promise<boolean>) => { const end = Date.now() + 10000; while (!await check()) { if (Date.now() > end) throw Error('test timed out'); await new Promise(r => setTimeout(r, 20)); } };

test('Cursor first management prompt uses the same base-model contract as its picker', async () => {
  const f = await fixture();
  try {
    await f.wb.changeNetworkRoute(f.session.id, 'management');
    await f.wb.changeModel(f.session.id, 'grok-4.7');
    assert.equal(await f.wb.send(f.session.id, 'First prompt on management'), true);
    const calls = await f.calls();
    assert.equal(calls.find(c => c.method === 'initialize').params.clientCapabilities._meta.parameterizedModelPicker, true);
    assert.equal(calls.find(c => c.method === 'session/set_model').params.modelId, 'grok-4.7');
    assert.equal(calls.filter(c => c.method === 'session/prompt').length, 1);
    assert.equal(f.session.status, 'idle'); assert.equal(f.session.messages.filter(m => m.role === 'assistant').length, 1);
  } finally { await f.close(); }
});

test('Cursor invalid model stops before sending, explains recovery, and can retry after model change', async () => {
  const f = await fixture({ rpcErrors: { 'session/set_model': 'Invalid params' }, rpcErrorCodes: { 'session/set_model': -32602 }, rpcErrorData: { 'session/set_model': { message: 'Invalid model value: grok-4.7', secret: 'DO_NOT_RENDER' } } });
  try {
    await f.wb.changeNetworkRoute(f.session.id, 'management'); await f.wb.changeModel(f.session.id, 'grok-4.7');
    await assert.rejects(f.wb.send(f.session.id, 'Do not lose this draft'), /刷新模型列表/);
    assert.equal(f.session.status, 'error'); assert.match(f.session.error!, /grok-4.7/); assert.doesNotMatch(f.session.error!, /DO_NOT_RENDER/);
    assert(!(await f.calls()).some(c => c.method === 'session/prompt')); assert.equal(f.session.nativeId, undefined);
    await f.cli.write({ status: 'ready', turn: 'success' }); await f.wb.changeModel(f.session.id, 'cursor-fixture');
    assert.equal(await f.wb.send(f.session.id, 'Retry explicitly'), true); assert.equal(f.session.networkRoute, 'management');
  } finally { await f.close(); }
});

test('Cursor prompt invalid params reports the sending stage and keeps the same native session', async () => {
  const f = await fixture({ rpcErrors: { 'session/prompt': 'Invalid params' }, rpcErrorCodes: { 'session/prompt': -32602 }, rpcErrorData: { 'session/prompt': { message: 'invalid payload SECRET' } } });
  try {
    assert.equal(await f.wb.send(f.session.id, 'Rejected prompt'), false);
    const nativeId = f.session.nativeId; assert(nativeId);
    assert.match(f.session.error!, /本次消息/); assert.doesNotMatch(f.session.error!, /SECRET/);
    await f.cli.write({ status: 'ready', turn: 'success' });
    assert.equal(await f.wb.send(f.session.id, 'Retry explicitly'), true); assert.equal(f.session.nativeId, nativeId);
  } finally { await f.close(); }
});

test('Cursor mode menu and selection work offline without starting/authenticating a native session', async () => {
  const f = await fixture({ status: 'none' });
  try {
    assert.deepEqual((await f.wb.modes(f.session.id)).modes.map(m => m.id), ['default', 'plan', 'ask']);
    for (const mode of ['plan', 'default', 'ask'] as const) { await f.wb.changeMode(f.session.id, mode); assert.equal(f.session.mode, mode); assert.equal(f.session.status, 'idle'); }
    assert.equal(f.session.nativeId, undefined); assert.deepEqual(await f.calls(), []);
    assert.equal(await fs.stat(path.join(f.root, 'cli-launches.jsonl')).then(() => true, () => false), false);
  } finally { await f.close(); }
});

test('Cursor metadata-only sessions are discarded on settings change, before their first prompt', async () => {
  const f = await fixture();
  try {
    await f.wb.capabilities(f.session.id, true, 'skill'); const emptyId = f.session.nativeId;
    assert(emptyId); assert.equal(f.session.messages.length, 0);
    await f.wb.changeMode(f.session.id, 'plan'); assert.equal(f.session.nativeId, undefined);
    await f.wb.send(f.session.id, 'First actual prompt');
    assert.notEqual(f.session.nativeId, emptyId); assert(!(await f.calls()).some(c => c.method === 'session/load'));
    assert.equal(f.session.messages.filter(m => m.role === 'user').length, 1);
  } finally { await f.close(); }
});

test('reselecting the current Cursor mode preserves the runtime and does not defer a settings restart', async () => {
  const f = await fixture({ turnDelay: 800 });
  try {
    await f.wb.capabilities(f.session.id, true, 'skill');
    const nativeId = f.session.nativeId;
    await f.wb.changeMode(f.session.id, 'default');
    assert.equal(f.session.nativeId, nativeId, 'selecting Agent again must not discard the prepared session');
    const turn = f.wb.send(f.session.id, 'Keep running in Agent');
    await until(() => f.session.status === 'running');
    await f.wb.changeMode(f.session.id, 'default');
    assert.equal(f.session.settingsPending, undefined);
    assert.equal(await turn, true);
    assert.equal((await f.calls()).filter(c => c.method === 'initialize').length, 1);
  } finally { await f.close(); }
});

for (const hasHistory of [false, true]) test(`Cursor repairs an old missing empty id only when it has no conversation (history=${hasHistory})`, async () => {
  const f = await fixture({ rpcErrors: { 'session/load': 'Invalid params' }, rpcErrorCodes: { 'session/load': -32602 }, rpcErrorData: { 'session/load': { message: 'Session "old-empty-id" not found' } } });
  try {
    f.session.nativeId = 'old-empty-id';
    if (hasHistory) f.session.messages.push({ id: 'kept', role: 'user', text: 'Never reset this context', createdAt: new Date().toISOString() });
    if (hasHistory) {
      await assert.rejects(f.wb.send(f.session.id, 'Must not silently start over'), /未找到.*原始记录/);
      assert.equal(f.session.nativeId, 'old-empty-id'); assert(!(await f.calls()).some(c => c.method === 'session/new'));
    } else { assert.equal(await f.wb.send(f.session.id, 'First prompt'), true); assert.notEqual(f.session.nativeId, 'old-empty-id'); }
  } finally { await f.close(); }
});

for (const method of ['authenticate', 'session/load', 'session/set_model', 'session/set_mode']) test(`Cursor ${method} failure during a Skill query releases startup state and allows route/mode recovery`, async () => {
  const f = await fixture();
  try {
    await f.wb.send(f.session.id, 'First conversation'); const nativeId = f.session.nativeId;
    await f.wb.changeModel(f.session.id, 'selected-model');
    await f.cli.write({ status: 'ready', turn: 'success', rpcErrors: { [method]: 'fixture startup failure' } });
    await assert.rejects(f.wb.capabilities(f.session.id, true, 'skill'), /fixture startup failure/);
    assert.equal(f.session.status, 'error', 'metadata failure must not leave the composer locked in starting');
    await f.wb.changeNetworkRoute(f.session.id, 'management');
    await f.wb.changeMode(f.session.id, 'plan');
    await f.cli.write({ status: 'ready', turn: 'success' });
    assert.equal(await f.wb.send(f.session.id, 'Retry after recovery'), true);
    assert.equal(f.session.status, 'idle'); assert.equal(f.session.nativeId, nativeId);
    assert.equal(f.session.messages.filter(m => m.role === 'user').length, 2);
  } finally { await f.close(); }
});

test('Cursor setting changes ignore ACP history replay and keep native id, transcript, draft and route across restart', async () => {
  const f = await fixture();
  try {
    await f.wb.send(f.session.id, 'Remember the original context');
    const nativeId = f.session.nativeId, history = structuredClone(f.session.messages);
    const draft = { text: 'Unsent draft', sourceIds: [], answers: {} }; f.wb.store.inputs[f.session.id] = draft;
    await f.cli.write({ status: 'ready', turn: 'success', omitCursorSessionId: true, cursorReplay: [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Remember the original context' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAY MUST NOT APPEAR' } },
      { sessionUpdate: 'tool_call', toolCallId: 'replay-0-1', title: 'old tool' },
    ] });
    for (const [mode, route] of [['plan', 'management'], ['ask', 'direct'], ['default', 'management']] as const) {
      await f.wb.changeMode(f.session.id, mode); await f.wb.changeNetworkRoute(f.session.id, route);
      await f.wb.send(f.session.id, `Continue in ${mode}`);
      assert.equal(f.session.nativeId, nativeId); assert.deepEqual(f.wb.store.inputs[f.session.id], draft);
      assert.equal(f.session.permissions?.warnings.some(warning => warning.includes('当前 Cursor 为 Ask 或 Plan')), mode !== 'default');
      assert.deepEqual(f.session.messages.slice(0, history.length), history);
    }
    assert.equal(f.session.messages.filter(m => m.role === 'assistant').length, 4);
    assert(!f.session.messages.some(m => /REPLAY|old tool/.test(m.text)));
    const events = () => fs.readFile(path.join(f.wb.store.sessionDir(f.session.id), 'events.jsonl'), 'utf8');
    await until(async () => (await events()).includes('Continue in default'));
    assert.doesNotMatch(await events(), /REPLAY MUST NOT APPEAR|replay-0-1/);
    assert.deepEqual((await f.calls()).filter(c => c.method === 'session/load').map(c => c.params.sessionId), [nativeId, nativeId, nativeId]);
    assert.deepEqual((await f.calls()).filter(c => c.method === 'session/set_mode').map(c => c.params.modeId), ['agent', 'plan', 'ask', 'agent']);
    const envs = await f.cli.environments(); assert(envs.some((e: any) => e.HTTPS_PROXY === '')); assert(envs.some((e: any) => e.managementNetwork === '1'));
    await f.wb.store.save(); const restored = new Store(f.wb.store.root); await restored.init();
    const saved = restored.sessions.find(s => s.id === f.session.id)!;
    assert.equal(saved.nativeId, nativeId); assert.equal(saved.networkRoute, 'management'); assert.equal(saved.mode, 'default');
  } finally { await f.close(); }
});

test('Cursor refuses a different native session on resume and can retry the original one', async () => {
  const f = await fixture();
  try {
    await f.wb.send(f.session.id, 'Original'); const nativeId = f.session.nativeId;
    await f.wb.changeModel(f.session.id, 'another-model');
    await f.cli.write({ status: 'ready', turn: 'success', returnedCursorSessionId: 'unexpected-session' });
    await assert.rejects(f.wb.send(f.session.id, 'Must not enter another context'), /另一条会话/);
    assert.equal(f.session.nativeId, nativeId);
    await f.cli.write({ status: 'ready', turn: 'success' });
    assert.equal(await f.wb.send(f.session.id, 'Retry the original'), true);
  } finally { await f.close(); }
});

test('Cursor active reply finishes before multiple settings changes take effect, including queued input', async () => {
  const f = await fixture({ turnDelay: 1200 });
  try {
    const running = f.wb.send(f.session.id, 'Working'); await until(() => f.session.status === 'running');
    const nativeId = f.session.nativeId;
    await f.wb.changeMode(f.session.id, 'plan'); await f.wb.changeModel(f.session.id, 'new-model');
    await f.wb.changePermissions(f.session.id, 'full'); await f.wb.changeNetworkRoute(f.session.id, 'management');
    assert.equal(f.session.status, 'running'); assert.equal(f.session.settingsPending, true);
    assert.equal((await f.calls()).filter(c => c.method === 'session/prompt').length, 1);
    await f.wb.enqueueInput(f.session.id, { text: 'Next queued input', sourceIds: [], answers: {} });
    await f.cli.write({ status: 'ready', turn: 'success' });
    assert.equal(await running, true);
    // Drive the same dispatcher tick used by Workbench.init, without starting
    // unrelated project/RSI timers in this isolated protocol fixture.
    await f.wb.inputQueue.pump(f.session.id);
    await until(() => f.session.status === 'idle' && !f.session.inputQueue?.items.length && f.session.messages.filter(m => m.role === 'user').length === 2);
    assert.equal(f.session.nativeId, nativeId); assert.equal(f.session.settingsPending, undefined);
    const calls = await f.calls(); assert(calls.some(c => c.method === 'session/set_mode' && c.params.modeId === 'plan'));
    assert(calls.some(c => c.method === 'session/set_model' && c.params.modelId === 'new-model'));
  } finally { await f.close(); }
});

test('Cursor plan acceptance preserves a next-turn Ask choice and route while keeping approval explicit', async () => {
  const f = await fixture({ proposedPlan: '# Fixture plan' });
  try {
    await f.wb.changeMode(f.session.id, 'plan');
    const turn = f.wb.send(f.session.id, 'Plan this work'); await until(() => f.session.status === 'approval');
    const approval = f.session.approvals[0];
    await f.wb.changeMode(f.session.id, 'ask'); await f.wb.changeNetworkRoute(f.session.id, 'management');
    assert.equal(f.session.approvals[0].id, approval.id);
    await f.wb.answer(f.session.id, approval.id, 'accept'); assert.equal(await turn, true);
    assert.equal(f.session.mode, 'ask');
    await f.cli.write({ status: 'ready', turn: 'success' }); await f.wb.send(f.session.id, 'Ask after implementation');
    assert.equal((await f.calls()).filter(c => c.method === 'session/set_mode').at(-1).params.modeId, 'ask');
    assert.equal(f.session.networkRoute, 'management');
  } finally { await f.close(); }
});

test('stopping Cursor startup cancels the pending request and allows selecting a replacement route', async () => {
  const f = await fixture({ rpcDelays: { authenticate: 10000 } });
  try {
    const turn = f.wb.send(f.session.id, 'Cancelled input');
    await until(async () => (await f.calls()).some(c => c.method === 'authenticate'));
    await f.wb.stop(f.session.id); assert.equal(await turn, false); assert.equal(f.session.status, 'idle');
    await f.wb.changeNetworkRoute(f.session.id, 'management'); await f.wb.changeMode(f.session.id, 'plan');
    await f.cli.write({ status: 'ready', turn: 'success' });
    assert.equal(await f.wb.send(f.session.id, 'Recovered input'), true);
    assert.equal(f.session.messages.filter(m => m.role === 'user').length, 1);
  } finally { await f.close(); }
});

test('unsupported Cursor Plan fails before sending and Agent remains usable', async () => {
  const f = await fixture({ noPlan: true });
  try {
    await f.wb.changeMode(f.session.id, 'plan');
    await assert.rejects(f.wb.send(f.session.id, 'Do not send in the wrong mode'), /不支持此模式/);
    assert.equal(f.session.status, 'error'); assert.equal(f.session.messages.length, 0);
    await f.wb.changeMode(f.session.id, 'default'); assert.equal(await f.wb.send(f.session.id, 'Use Agent'), true);
  } finally { await f.close(); }
});

test('one Cursor session changing route/mode does not change another session or its active response', async () => {
  const f = await fixture({ turnDelay: 900 });
  try {
    const other = await f.wb.createSession('cursor', f.root, offlineProjectId, 'work', undefined, undefined, 'inherit', false, 'direct');
    const active = f.wb.send(other.id, 'Separate session'); await until(() => other.status === 'running');
    await f.wb.changeNetworkRoute(f.session.id, 'management'); await f.wb.changeMode(f.session.id, 'ask');
    assert.equal(other.networkRoute, 'direct'); assert.equal(other.mode, undefined); assert.equal(other.status, 'running');
    assert.equal(await active, true); assert.equal(await f.wb.send(f.session.id, 'Another conversation'), true);
    assert.notEqual(f.session.nativeId, other.nativeId);
  } finally { await f.close(); }
});

test('Cursor failure from the active route is not attributed to the route selected for next turn', async () => {
  const f = await fixture({ turn: 'network', rpcDelays: { 'session/prompt': 1500 } });
  const failures: unknown[] = [];
  try {
    f.wb.accounts.failed = (_provider, _error, _cwd, route) => { failures.push(route); };
    await f.wb.changeNetworkRoute(f.session.id, 'management');
    const turn = f.wb.send(f.session.id, 'Old route request'); await until(() => f.session.status === 'running');
    await f.wb.changeNetworkRoute(f.session.id, 'direct');
    assert.equal(await turn, false); assert.deepEqual(failures, ['management']); assert.equal(f.session.networkRoute, 'direct');
  } finally { await f.close(); }
});
