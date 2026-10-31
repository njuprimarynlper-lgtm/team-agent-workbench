import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store';
import { saveAgentSettings } from '../src/core/agent-settings';

async function fixture(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-settings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(root); await store.init();
  const invalidated: string[] = [];
  return { store, invalidated, save: (patch: unknown) => saveAgentSettings(store, patch, provider => invalidated.push(provider)) };
}

test('guard saves independently, persists across restart and keeps account/path/certificate settings', async t => {
  const f = await fixture(t);
  f.store.settings.providerPaths.codex = 'saved-cli';
  f.store.settings.codexCaCertificate = 'saved-cert';
  f.store.settings.projectDirectories = { p: 'workspace' };
  await f.save({ codexRequestGuard: false });
  const reopened = new Store(f.store.root); await reopened.init();
  assert.equal(reopened.settings.codexRequestGuard, false);
  assert.equal(reopened.settings.providerPaths.codex, 'saved-cli');
  assert.equal(reopened.settings.codexCaCertificate, 'saved-cert');
  assert.deepEqual(reopened.settings.projectDirectories, { p: 'workspace' });
  assert.deepEqual(f.invalidated, []);
});

test('concurrent partial saves retain the guard and invalidate only a changed CLI path', async t => {
  const f = await fixture(t);
  await Promise.all([f.save({ codexRequestGuard: false }), f.save({ providerPaths: { cursor: 'new-cursor' }, codexCaCertificate: '  cert.pem  ' })]);
  const reopened = new Store(f.store.root); await reopened.init();
  assert.equal(reopened.settings.codexRequestGuard, false);
  assert.equal(reopened.settings.codexCaCertificate, 'cert.pem');
  assert.deepEqual(reopened.settings.providerPaths, { codex: '', cursor: 'new-cursor', claude: '' });
  assert.deepEqual(f.invalidated, ['cursor']);
});

test('failed saving restores the switch without losing unrelated edits and the next save can retry', async t => {
  const f = await fixture(t), originalSave = f.store.saveSettings.bind(f.store);
  f.store.saveSettings = async () => { f.store.settings.projectDirectories = { new: 'keep-this-edit' }; throw Error('disk unavailable'); };
  await assert.rejects(f.save({ codexRequestGuard: false, providerPaths: { codex: 'not-saved' } }), /disk unavailable/);
  assert.equal(f.store.settings.codexRequestGuard, true);
  assert.equal(f.store.settings.providerPaths.codex, '');
  assert.deepEqual(f.store.settings.projectDirectories, { new: 'keep-this-edit' });
  assert.deepEqual(f.invalidated, []);
  f.store.saveSettings = originalSave;
  await f.save({ codexRequestGuard: false });
  assert.equal(f.store.settings.codexRequestGuard, false);
});

test('agent settings reject invalid and unrelated fields without replacing existing preferences', async t => {
  const f = await fixture(t);
  for (const patch of [{ codexRequestGuard: 'false' }, { connections: [] }, { providerPaths: { unknown: 'path' } }]) await assert.rejects(f.save(patch));
  assert.equal(f.store.settings.codexRequestGuard, true);
  assert.deepEqual(f.invalidated, []);
});
