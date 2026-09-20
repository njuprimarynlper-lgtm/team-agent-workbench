import { offlineSettings, offlineProjectId } from '../tests/fixtures/offline-workspace.mjs';
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';
import { dismissStartupLogin } from './connection-helpers.mjs';
const expect = baseExpect.configure({ timeout: 25000 });
const root = process.cwd(), data = path.join(root, '.test-data', 'preparation-permissions-ui-' + Date.now());
const fixture = await authLauncher(path.join(data, 'cli'), { status: 'ready', turn: 'success', permissionRuntime: true, policyApproval: true, permissionConfig: { sandbox: 'read-only', approval: 'on-request' } });
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ ...offlineSettings(), connections: [], providerPaths: { codex: fixture.launcher, cursor: fixture.launcher }, lastWorkspace: data, localWorkspace: data, verifiedLocalWorkspace: data }));
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: data, CURSOR_CONFIG_DIR: path.join(data, 'cursor-config') }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['dist/user'], cwd: root, env, timeout: 60000 });
try {
  const page = await app.firstWindow(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await dismissStartupLogin(page);
  const call = (action, payload) => page.evaluate(([a, p]) => window.workbench.call(a, p), [action, payload]);
  for (const provider of ['codex', 'cursor']) {
    await page.getByRole('button', { name: '工作会话', exact: true }).click();
    const session = await call('session.create', { provider, cwd: data, projectId: offlineProjectId, permissionMode: 'review' });
    await page.locator(`.session-row[data-session-id="${session.id}"]`).click();
    await call('provider.auth', { provider, cwd: data });
    await page.getByRole('button', { name: '整理成果', exact: true }).click();
    await expect(page.getByLabel('整理状态')).toContainText('已整理好');
    const initial = await call('snapshot'), draft = initial.drafts.find(d => d.sessionId === session.id);
    const helper = initial.sessions.find(s => s.id === draft.prepareSessionId);
    assert.equal(helper.permissionMode, 'full'); assert.deepEqual(helper.approvals, []);
    await expect(page.locator('.approval')).toHaveCount(0); await expect(page.getByLabel('待授权提醒')).toHaveCount(0);
    await page.getByLabel('给团队的补充（可选）').fill('保留的补充');
    await page.getByRole('button', { name: '重新整理', exact: true }).click();
    await expect.poll(async () => (await call('snapshot')).drafts.find(d => d.id === draft.id)?.prepareSessionId).not.toBe(helper.id);
    await expect(page.getByLabel('整理状态')).toContainText('已整理好');
    const after = await call('snapshot'), retried = after.sessions.find(s => s.id === after.drafts.find(d => d.id === draft.id).prepareSessionId);
    assert.equal(retried.permissionMode, 'full'); assert.deepEqual(retried.approvals, []);
    assert.equal(after.sessions.find(s => s.id === session.id).permissionMode, 'review');
    assert.equal(after.transfers.length, 0, 'preparation never uploads automatically');
    await expect(page.getByLabel('给团队的补充（可选）')).toHaveValue('保留的补充');
    await expect(page.getByRole('button', { name: /^确认上传/ })).toBeEnabled();
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts', `preparation-full-access-${provider}.png`) });
    await page.locator('.draft-back').click();
    await expect(page.getByLabel('当前执行权限')).toContainText(provider === 'codex' ? '请求批准' : 'Allowlist');
  }
  assert.deepEqual(errors, []);
  console.log('Preparation UI passed for Codex/Cursor: full access on first run and retry, no approval clicks, parent permissions and supplement preserved, upload still explicit.');
} finally { await app.close(); }
