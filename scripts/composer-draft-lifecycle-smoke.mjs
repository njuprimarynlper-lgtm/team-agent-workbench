// Real Electron/IPC and disk, isolated fake CLI/account; no model requests.
import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';
import { dismissStartupLogin } from './connection-helpers.mjs';

const root = process.cwd(), build = await fs.realpath(path.resolve(process.argv[2] || 'dist/user'));
const data = path.resolve('.test-data', 'composer-draft-lifecycle-' + Date.now());
const fixture = await authLauncher(path.join(data, 'cli'), { status: 'ready', turn: 'success' });
const settings = { connections: [], providerPaths: { codex: fixture.launcher, cursor: fixture.launcher, claude: '' }, lastWorkspace: data, codexRequestGuard: false };
for (const dir of [path.join(data, 'personal'), path.join(data, 'window-state', '1')]) {
  await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify(settings));
}
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: data, CODEX_HOME: path.join(data, 'fake-codex'), CURSOR_CONFIG_DIR: path.join(data, 'fake-cursor') };
delete env.ELECTRON_RUN_AS_NODE;
const errors = []; let app, page;
async function launch() {
  app = await electron.launch({ args: [build], cwd: root, env, timeout: 60000 }); page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message)); await dismissStartupLogin(page);
}
async function closeWindow() {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  await closed; app = undefined;
}
const call = (action, payload) => page.evaluate(([action, payload]) => window.workbench.call(action, payload), [action, payload]);
try {
  await launch();
  const sessions = [];
  for (let i = 0; i < 2; i++) sessions.push(await call('personal:session.create', { provider: 'codex', cwd: data, projectId: '__personal__', includeBrief: false, networkRoute: 'direct' }));
  const input = page.getByLabel('任务输入', { exact: true });
  await page.locator(`.session-row[data-session-id="${sessions[0].id}"]`).click();
  await input.fill('切换前保留的中文草稿');
  await page.locator(`.session-row[data-session-id="${sessions[1].id}"]`).click();
  await expect(input).toHaveValue('');
  const readInputs = async () => JSON.parse(await fs.readFile(path.join(data, 'personal', 'inputs.json'), 'utf8'));
  await expect.poll(async () => (await readInputs())[sessions[0].id]?.text).toBe('切换前保留的中文草稿');
  await input.fill('窗口关闭前最后输入的字');
  // Production close handler, not app.close()/process termination. No 300ms wait.
  await closeWindow();
  const saved = await readInputs(); assert.equal(saved[sessions[1].id].text, '窗口关闭前最后输入的字');
  assert.equal(saved[sessions[0].id].text, '切换前保留的中文草稿');
  await launch();
  await page.locator(`.session-row[data-session-id="${sessions[1].id}"]`).click();
  await expect(page.getByLabel('任务输入', { exact: true })).toHaveValue('窗口关闭前最后输入的字');
  await page.locator(`.session-row[data-session-id="${sessions[0].id}"]`).click();
  await expect(page.getByLabel('任务输入', { exact: true })).toHaveValue('切换前保留的中文草稿');
  await closeWindow(); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, realElectronIPC: true, sessionSwitchSaved: true, windowCloseSaved: true, restartRestored: true, externalModelRequests: 0 }));
} finally { if (app) await app.close(); }
