import { _electron as electron, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';
const expect = baseExpect.configure({ timeout: 20000 });
const root = process.cwd(), data = path.join(root, '.test-data', 'composer-' + Date.now());
const fixture = await authLauncher(path.join(data, 'cli'), { status: 'ready', turn: 'success' });
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ connections: [], providerPaths: { codex: fixture.launcher, cursor: fixture.launcher }, lastWorkspace: data, localWorkspace: data, verifiedLocalWorkspace: data }));
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: data, CURSOR_CONFIG_DIR: path.join(data, 'cursor-config') }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['dist/user'], cwd: root, env, timeout: 60000 });
try {
  const page = await app.firstWindow(), errors = []; page.on('pageerror', e => errors.push(e.message));
  const call = (action, payload) => page.evaluate(([a, p]) => window.workbench.call(a, p), [action, payload]);
  const input = page.getByLabel('任务输入', { exact: true });
  for (const provider of ['codex', 'cursor']) {
    await fixture.write({ status: 'ready', turn: 'success' });
    const session = await call('session.create', { provider, cwd: data });
    const row = page.locator(`.session-row[data-session-id="${session.id}"]`); await row.click(); await expect(row).toHaveClass(/selected/);
    const current = async () => (await call('snapshot')).sessions.find(s => s.id === session.id);
    await expect(page.locator('.composer-bottom')).toContainText('Enter 发送 · Shift+Enter 换行');
    await input.fill('   '); await input.press('Enter'); await expect(input).toHaveValue('   '); assert.equal((await current()).messages.length, 0);
    await input.fill('中文选词');
    // Chromium IME confirmation, Windows legacy 229, and held-key repeats must not submit.
    for (const init of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
      const canceled = await input.evaluate((el, init) => { const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...init }); el.dispatchEvent(e); return e.defaultPrevented; }, init);
      assert.equal(canceled, !!init.repeat);
    }
    await expect(input).toHaveValue('中文选词'); assert.equal((await current()).messages.length, 0);
    await input.fill('第一行'); await input.press('End'); await input.press('Shift+Enter'); await input.pressSequentially('第二行');
    await expect(input).toHaveValue('第一行\n第二行'); assert.equal((await current()).messages.length, 0);
    await input.press('Enter');
    await expect.poll(async () => (await current()).messages.some(m => m.role === 'assistant')).toBe(true);
    await expect(input).toHaveValue(''); assert((await current()).messages.find(m => m.role === 'user').text.startsWith('第一行\n第二行'));
    // Preserve the old keyboard shortcut and protect a draft while work is running.
    await fixture.write({ status: 'ready', turn: 'hang' });
    await input.fill('继续任务'); await input.press('Control+Enter');
    await expect.poll(async () => (await current()).status).toBe('running');
    await expect.poll(async () => (await current()).messages.filter(m => m.role === 'user').length).toBe(2);
    await input.fill('下一条草稿'); await input.press('Enter'); await expect(input).toHaveValue('下一条草稿');
    assert.equal((await current()).messages.filter(m => m.role === 'user').length, 2);
    await call('session.close', { id: session.id });
  }
  assert.deepEqual(errors, []);
  console.log('Composer UI passed for Codex and Cursor: Enter sends, Shift+Enter inserts newline, Chinese IME confirmation and repeat do not send, empty input does not send, Ctrl+Enter stays supported, busy-session draft remains intact.');
} finally { await app.close(); }
