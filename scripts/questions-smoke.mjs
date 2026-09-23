import { offlineSettings, offlineProjectId } from '../tests/fixtures/offline-workspace.mjs';
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';
import { dismissStartupLogin } from './connection-helpers.mjs';

const expect = baseExpect.configure({ timeout: 25000 });
const root = process.cwd(), data = path.join(root, '.test-data', 'questions-ui-' + Date.now());
await fs.mkdir(data, { recursive: true });
const fixture = await authLauncher(path.join(data, 'cli'), { status: 'ready', userQuestion: true, permissionRuntime: true });
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ ...offlineSettings(), connections: [], providerPaths: { codex: fixture.launcher, cursor: fixture.launcher }, lastWorkspace: data, localWorkspace: data, verifiedLocalWorkspace: data }));
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['dist/user'], cwd: root, env, timeout: 60000 });
try {
  const page = await app.firstWindow(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await dismissStartupLogin(page);
  const call = (action, payload) => page.evaluate(([name, value]) => window.workbench.call(name, value), [action, payload]);
  const snap = () => call('snapshot');
  const send = async text => { await page.getByLabel('任务输入', { exact: true }).fill(text); await page.getByRole('button', { name: '发送任务', exact: true }).click(); };

  const codex = await call('session.create', { provider: 'codex', cwd: data, projectId: offlineProjectId });
  await page.locator(`.session-row[data-session-id="${codex.id}"]`).click();
  await send('需要选择方向');
  await expect(page.getByLabel('待回答提醒')).toContainText('1 个问题');
  await expect(page.getByLabel('待授权提醒')).toHaveCount(0);
  const codexCard = page.locator('.question-request');
  await expect(codexCard.getByRole('button', { name: '提交回答' })).toBeDisabled();
  await expect(codexCard.getByRole('button', { name: '不提供信息，继续' })).toBeVisible();
  await codexCard.locator('input[list]').fill('先整理');
  await codexCard.getByRole('button', { name: '提交回答' }).click();
  await expect.poll(async () => (await snap()).sessions.find(session => session.id === codex.id).status).toBe('idle');

  const cursor = await call('session.create', { provider: 'cursor', cwd: data, projectId: offlineProjectId });
  await page.locator(`.session-row[data-session-id="${cursor.id}"]`).click();
  await send('选择检查项');
  await expect(page.getByLabel('待回答提醒')).toContainText('2 个问题');
  const cursorCard = page.locator('.question-request');
  await expect(cursorCard.getByRole('button', { name: '提交回答' })).toBeDisabled();
  await cursorCard.getByRole('combobox').selectOption('verify');
  await cursorCard.getByRole('checkbox', { name: '单元测试' }).check();
  await cursorCard.getByRole('checkbox', { name: '界面测试' }).check();
  await cursorCard.getByRole('button', { name: '提交回答' }).click();
  await expect.poll(async () => (await snap()).sessions.find(session => session.id === cursor.id).status).toBe('idle');
  const results = (await fixture.calls()).filter(event => event?.questionResult).map(event => event.questionResult);
  assert.deepEqual(results[0], { answers: { direction: { answers: ['先整理'] } } });
  assert.deepEqual(results[1].outcome.answers[1].selectedOptionIds, ['unit', 'ui']);
  assert.deepEqual(errors, []);
  console.log('Question card smoke passed for Codex and Cursor.');
} finally { await app.close(); }
