import { offlineSettings, offlineProjectId } from '../tests/fixtures/offline-workspace.mjs';
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';
const expect = baseExpect.configure({ timeout: 20000 });
const root = process.cwd(), data = path.join(root, '.test-data', 'composer-' + Date.now());
const fixture = await authLauncher(path.join(data, 'cli'), { status: 'ready', turn: 'success' });
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ ...offlineSettings(), connections: [], providerPaths: { codex: fixture.launcher, cursor: fixture.launcher }, lastWorkspace: data, localWorkspace: data, verifiedLocalWorkspace: data }));
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: data, CURSOR_CONFIG_DIR: path.join(data, 'cursor-config') }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['dist/user'], cwd: root, env, timeout: 60000 });
try {
  const page = await app.firstWindow(), errors = []; page.on('pageerror', e => errors.push(e.message));
  const call = (action, payload) => page.evaluate(([a, p]) => window.workbench.call(a, p), [action, payload]);
  await page.setViewportSize({ width: 1100, height: 760 });
  const artifacts = path.join(root, 'artifacts'); await fs.mkdir(artifacts, { recursive: true });
  const input = page.getByLabel('任务输入', { exact: true });
  for (const provider of ['codex', 'cursor']) {
    await fixture.write({ status: 'ready', turn: 'success' });
    const session = await call('session.create', { provider, cwd: data, projectId: offlineProjectId });
    const row = page.locator(`.session-row[data-session-id="${session.id}"]`); await row.click(); await expect(row).toHaveClass(/selected/);
    await call('provider.auth', { provider, cwd: data });
    const current = async () => (await call('snapshot')).sessions.find(s => s.id === session.id);
    await expect(page.locator('.composer-bottom')).toContainText('Enter 发送 · Shift+Enter 换行');
    await expect(page.locator('.composer').getByLabel('选择模型')).toBeVisible();
    await expect(page.locator('.composer').getByLabel('当前执行权限')).toBeVisible();
    await expect(page.locator('.session-permission-line')).toHaveCount(0);
    const chatBox = await page.locator('.messages').boundingBox();
    assert(chatBox.height >= 420 && chatBox.y < 170, 'chat must occupy the main area at 1100 × 760');
    const composeBox = await page.locator('.composer').boundingBox(); assert(composeBox.y + composeBox.height <= 740);
    await page.getByLabel('选择模型').click();
    const menu = page.getByRole('dialog', { name: '模型与额度', exact: true });
    await expect(menu.getByRole('group', { name: '可用模型' }).getByRole('button')).toHaveCount(2);
    if (provider === 'codex') await expect(menu).toContainText('剩余 77%');
    else await expect(menu).toContainText('官方额度页');
    const menuBox = await menu.boundingBox(); assert(menuBox.y >= 52 && menuBox.x + menuBox.width <= 1100);
    await page.screenshot({ path: path.join(artifacts, 'composer-model-' + provider + '.png') });
    await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
    await expect(page.getByLabel('选择模型')).toBeFocused();
    await page.getByLabel('当前执行权限').click();
    await expect(page.getByRole('dialog', { name: '执行权限', exact: true })).toBeVisible();
    if (provider === 'cursor') await expect(page.getByRole('button', { name: 'Auto-review（自动审查）', exact: true })).toBeDisabled();
    await input.click(); await expect(page.getByRole('dialog')).toHaveCount(0);
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
    const native = (await current()).nativeId;
    await input.fill('切换模型也保留草稿');
    await page.getByLabel('选择模型').click();
    await menu.getByRole('group', { name: '可用模型' }).getByRole('button').nth(1).click();
    await expect(menu).toHaveCount(0);
    assert.equal((await current()).model, provider === 'codex' ? 'gpt-fixture-2' : 'other-fixture');
    assert.equal((await current()).nativeId, native);
    assert.equal((await current()).messages.filter(m => m.role === 'user').length, 1);
    await expect(input).toHaveValue('切换模型也保留草稿');
    await page.screenshot({ path: path.join(artifacts, 'composer-layout-' + provider + '.png') });
    // Preserve the old keyboard shortcut and protect a draft while work is running.
    await fixture.write({ status: 'ready', turn: 'hang' });
    await input.fill('继续任务'); await input.press('Control+Enter');
    await expect.poll(async () => (await current()).status).toBe('running');
    await expect.poll(async () => (await current()).messages.filter(m => m.role === 'user').length).toBe(2);
    await input.fill('下一条草稿'); await input.press('Enter'); await expect(input).toHaveValue('下一条草稿');
    assert.equal((await current()).messages.filter(m => m.role === 'user').length, 2);
    await page.getByLabel('选择模型').click();
    await menu.getByRole('group', { name: '可用模型' }).getByRole('button').first().click();
    await expect(menu.getByText(/将停止当前任务/)).toBeVisible();
    assert.equal((await current()).status, 'running');
    await menu.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await current()).status, 'running');
    await menu.getByRole('group', { name: '可用模型' }).getByRole('button').first().click();
    await menu.getByRole('button', { name: '停止当前任务并切换', exact: true }).click();
    await expect(menu).toHaveCount(0);
    assert.equal((await current()).status, 'idle'); assert.equal((await current()).nativeId, native);
    assert.equal((await current()).messages.filter(m => m.role === 'user').length, 2, 'switch must not replay');
    await expect(input).toHaveValue('下一条草稿');
    // Failed catalog queries can be retried without changing the chosen model.
    await fixture.write({ status: 'ready', catalog: 'error' });
    await page.getByLabel('选择模型').click(); await expect(menu.getByRole('alert')).toBeVisible();
    await fixture.write({ status: 'ready', turn: 'success' });
    await menu.getByRole('button', { name: '刷新选项', exact: true }).click();
    await expect(menu.getByRole('group', { name: '可用模型' }).getByRole('button')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await call('session.close', { id: session.id });
  }
  assert.deepEqual(errors, []);
  console.log('Composer UI passed: inline model/permission menus, quotas, switch preserving native identity and drafts, stop/cancel, retry, compact viewport geometry;  for Codex and Cursor: Enter sends, Shift+Enter inserts newline, Chinese IME confirmation and repeat do not send, empty input does not send, Ctrl+Enter stays supported, busy-session draft remains intact.');
} finally { await app.close(); }
