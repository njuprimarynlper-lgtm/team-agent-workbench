import { _electron as electron, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { offlineSettings, offlineProjectId } from '../tests/fixtures/offline-workspace.mjs';
import { dismissStartupLogin } from './connection-helpers.mjs';

const expect = baseExpect.configure({ timeout: 25000 });
const root = process.cwd(), data = path.join(root, '.test-data', 'claude-ui-' + Date.now());
await fs.mkdir(data, { recursive: true });
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ ...offlineSettings(), connections: [], providerPaths: { codex: '', cursor: '', claude: path.join(root, 'tests/fixtures/claude-cli.cjs') }, lastWorkspace: data, localWorkspace: data, verifiedLocalWorkspace: data }));
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['dist/user'], cwd: root, env, timeout: 60000 });
try {
  const page = await app.firstWindow(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await dismissStartupLogin(page);
  const call = (action, payload) => page.evaluate(([name, value]) => window.workbench.call(name, value), [action, payload]);
  const snap = () => call('snapshot');
  const session = await call('session.create', { provider: 'claude', cwd: data, projectId: offlineProjectId, model: 'sonnet', permissionMode: 'review' });
  await page.locator(`.session-row[data-session-id="${session.id}"]`).click();
  await expect(page.locator('.session-toolbar')).toContainText('Claude Code');
  const send = async prompt => { await page.getByLabel('任务输入', { exact: true }).fill(prompt); await page.getByRole('button', { name: '发送任务', exact: true }).click(); };
  for (const [prompt, expected] of [['first task', 'first'], ['second task', 'continued']]) {
    await send(prompt);
    const card = page.locator('.approval').first();
    await expect(card).toContainText('Claude Code 请求使用 Bash');
    await card.getByRole('button', { name: '允许本次' }).click();
    await expect(page.getByLabel('待回答提醒')).toContainText('1 个问题');
    const question = page.locator('.question-request');
    await question.locator('input[list]').fill('B');
    await question.getByRole('button', { name: '提交回答' }).click();
    await expect.poll(async () => (await snap()).sessions.find(value => value.id === session.id).status).toBe('idle');
    await expect(page.locator('.message.assistant').last()).toContainText(expected);
  }
  const result = (await snap()).sessions.find(value => value.id === session.id);
  assert.ok(result.nativeId); assert.equal(result.messages.filter(value => value.role === 'assistant').length, 2);
  assert.deepEqual(errors, []);
  console.log('Claude Code user UI smoke passed: login, two turns, approval, question and resume.');
} finally { await app.close(); }
