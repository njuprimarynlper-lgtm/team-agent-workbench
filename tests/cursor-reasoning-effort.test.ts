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

const thought = { id: 'thinking_budget', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] };
async function fixture(state: Record<string, unknown> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-cursor-effort-'));
  const cli = await authLauncher(root, { status: 'ready', turn: 'success', cursorConfigOptions: [thought], ...state });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.cursor = cli.launcher;
  wb.store.settings.codexRequestGuard = false;
  const session = await wb.createSession('cursor', root, offlineProjectId, 'work', undefined, 'grok-4.7');
  const calls = async () => (await fs.readFile(path.join(root, 'rpc-calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, wb, session, cli, calls, close: async () => { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
const until = async (check: () => boolean) => { const end = Date.now() + 5000; while (!check()) { assert(Date.now() < end); await new Promise(r => setTimeout(r, 20)); } };

test('Cursor thinking selection is applied and read back before prompt; changing it preserves history and running replies', async () => {
  const f = await fixture({ turnDelay: 800 });
  try {
    await f.wb.changeReasoningEffort(f.session.id, 'high');
    const first = f.wb.send(f.session.id, 'Remember this context'); await until(() => f.session.status === 'running');
    const nativeId = f.session.nativeId;
    await f.wb.changeReasoningEffort(f.session.id, 'low');
    assert.equal(f.session.status, 'running'); assert.equal(f.session.settingsPending, true); assert.equal(await first, true);
    await f.wb.send(f.session.id, 'Continue'); assert.equal(f.session.nativeId, nativeId);
    const calls = await f.calls(), settings = calls.filter(c => c.method === 'session/set_config_option' && c.params.sessionId === nativeId);
    assert.deepEqual(settings.map(c => [c.params.configId, c.params.value]), [['model', 'grok-4.7'], ['thinking_budget', 'high'], ['model', 'grok-4.7'], ['thinking_budget', 'low']]);
    assert(calls.findIndex(c => c.method === 'session/set_config_option' && c.params.value === 'high') < calls.findIndex(c => c.method === 'session/prompt'));
    assert.equal(f.session.messages.filter(m => m.role === 'user').length, 2);
    await f.wb.store.save(); const saved = new Store(f.wb.store.root); await saved.init();
    assert.equal(saved.sessions.find(s => s.id === f.session.id)?.reasoningEffort, 'low');
    await f.wb.changeModel(f.session.id, 'no-thinking'); assert.equal(f.session.reasoningEffort, undefined);
    await f.wb.closeSession(f.session.id); await assert.rejects(f.wb.changeReasoningEffort(f.session.id, 'high'), /已关闭/);
  } finally { await f.close(); }
});

for (const [name, state, message] of [
  ['unsupported effort', {}, /不支持所选思考强度/],
  ['unsupported model', { cursorConfigOptions: [] }, /不支持所选思考强度/],
  ['unconfirmed readback', { ignoreCursorConfigUpdate: true }, /未确认/],
  ['old CLI', { rpcErrors: { 'session/set_config_option': 'Method not found' }, rpcErrorCodes: { 'session/set_config_option': -32601 } }, /更新 CLI/],
] as const) test(`Cursor ${name} cannot silently ignore the effort or submit a prompt`, async () => {
  const f = await fixture(state);
  try {
    await f.wb.changeReasoningEffort(f.session.id, name === 'unsupported effort' ? 'ultra' : 'high');
    await assert.rejects(f.wb.send(f.session.id, 'Do not submit'), message);
    assert.equal(f.session.status, 'error'); assert(!(await f.calls()).some(c => c.method === 'session/prompt'));
    await f.wb.changeReasoningEffort(f.session.id, null);
    assert.equal(await f.wb.send(f.session.id, 'Explicit retry with CLI default'), true);
  } finally { await f.close(); }
});
