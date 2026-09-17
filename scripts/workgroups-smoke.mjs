import { _electron as electron, expect as baseExpect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';
import { completeProjectSetup } from './onboarding-helpers.mjs';
import { importConnection } from './connection-helpers.mjs';
const expect = baseExpect.configure({ timeout: 20000 });

const root = process.cwd(), data = path.join(root, '.test-data', 'workgroups-ui-' + Date.now()), share = path.join(data, 'share');
await fs.mkdir(share, { recursive: true });
const fixture = await authLauncher(path.join(data, 'cli')); await fixture.write({ status: 'ready' });
const apps = [], errors = [];
async function launch(edition) {
  const store = path.join(data, edition); await fs.mkdir(store);
  if (edition === 'user') await fs.writeFile(path.join(store, 'settings.json'), JSON.stringify({ connections: [], providerPaths: { codex: fixture.launcher, cursor: fixture.launcher }, lastWorkspace: '' }));
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: store, WORKBENCH_ADMIN_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['dist/' + edition], cwd: root, env, timeout: 60000 }); apps.push(app);
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message)); return { app, page };
}
async function confirm(page) { await page.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0); }
try {
  const admin = await launch('admin'), ap = admin.page;
  await ap.getByLabel('共享区类型').selectOption('local'); await ap.getByLabel('本地共享区根目录').fill(share);
  await ap.getByRole('button', { name: '打开共享目录', exact: true }).click(); await expect(ap.locator('.modal')).toHaveCount(0);
  await ap.getByRole('button', { name: '初始化账号管理', exact: true }).click(); await confirm(ap);
  for (const label of ['ocr', 'nlp', 'secret']) {
    await ap.getByRole('button', { name: '创建用户组', exact: true }).click(); await ap.getByLabel('组标识').fill(label); await confirm(ap);
  }
  await ap.getByRole('button', { name: '创建用户', exact: true }).click();
  await ap.getByLabel('成员姓名', { exact: true }).fill('测试成员'); await ap.getByLabel('登录账号', { exact: true }).fill('test1');
  await ap.getByLabel('初始密码', { exact: true }).fill('1'); await ap.getByLabel('再次输入密码', { exact: true }).fill('1'); await confirm(ap);
  const row = ap.locator('tbody tr').filter({ hasText: 'test1' });
  const exported = path.join(data, 'test1.json');
  await admin.app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, exported);
  await row.getByRole('button', { name: '导出连接配置', exact: true }).click(); await confirm(ap);
  const config = JSON.parse(await fs.readFile(exported, 'utf8')); assert.equal(config.workPath, ''); assert.deepEqual(config.projects, []);
  const user = await launch('user'), up = user.page;
  await importConnection(user, exported); await up.getByLabel('本机工作路径', { exact: true }).fill(data);
  await up.getByLabel('成员账号').fill('test1'); await up.getByLabel('登录密码', { exact: true }).fill('1');
  await expect(up.getByLabel('共享工作路径', { exact: true })).toHaveCount(0); await expect(up.getByLabel('Linux 工作路径', { exact: true })).toHaveCount(0);
  await up.getByRole('button', { name: '登录并发现工作组', exact: true }).click(); await expect(up.locator('.modal')).toHaveCount(0);
  await expect(up.getByText('还没有加入工作组', { exact: true })).toBeVisible(); await up.screenshot({ path: path.join(data, 'no-groups.png') });
  await expect(up.getByTitle('新建会话', { exact: true })).toHaveCount(0);
  const snap = () => up.evaluate(() => window.workbench.call('snapshot'));
  assert.equal((await snap()).sessions.length, 0);
  await assert.rejects(up.evaluate(data => window.workbench.call('session.create', { provider: 'codex', cwd: data }), data), /没有加入工作组/);
  for (const group of ['local_ocr', 'local_nlp']) {
    await row.getByRole('button', { name: '加入用户组', exact: true }).click(); await ap.getByLabel('选择已有用户组').selectOption(group);
    await ap.getByLabel('成员身份', { exact: true }).selectOption('admin'); await confirm(ap);
  }
  await up.getByRole('button', { name: '刷新工作组', exact: true }).click(); await expect(up.locator('.workgroup')).toHaveCount(2);
  await expect(up.getByText('还没有加入工作组', { exact: true })).toHaveCount(0); await expect(up.locator('[data-group-name="local_secret"]')).toHaveCount(0);
  for (const group of ['ocr', 'nlp']) {
    if (group !== 'ocr') await up.getByTitle('在 ' + group + ' 创建项目', { exact: true }).click();
    await expect(up.getByRole('dialog', { name: '完善项目资料' })).toContainText(group + ' · 项目初始化');
    await completeProjectSetup(up, '同名项目');
  }
  await expect(up.locator('.workgroup-project')).toHaveCount(2);
  // One saved account/connection discovers both groups again on the next login.
  await up.locator('.connection-button').click();
  await expect(up.getByLabel('团队连接（已保存）')).toHaveCount(0);
  await expect(up.getByLabel('本地共享区根目录', { exact: true })).toHaveCount(0);
  await up.getByLabel('登录密码', { exact: true }).fill('1');
  await up.getByRole('button', { name: '登录并发现工作组', exact: true }).click();
  await expect(up.locator('.modal')).toHaveCount(0);
  await expect(up.locator('.workgroup')).toHaveCount(2);
  await expect(up.locator('.workgroup-project')).toHaveCount(2);
  assert.equal((await snap()).settings.connections.length, 1);
  assert.equal((await snap()).connection.profile.localRoot, share);
  const projects = (await snap()).connection.profile.projects, ocr = projects.find(p => p.groupName === 'local_ocr');
  await up.locator('[data-project-id="' + ocr.id + '"]').click();
  await up.getByTitle('新建会话', { exact: true }).click(); await up.getByLabel('Codex 登录状态').getByText('已登录', { exact: true }).waitFor();
  assert.deepEqual(await up.getByLabel('绑定共享项目').locator('optgroup').evaluateAll(elements => elements.map(e => e.label).sort()), ['nlp', 'ocr']);
  await expect(up.getByLabel('绑定共享项目')).toHaveValue(ocr.id);
  await up.getByRole('button', { name: '创建会话', exact: true }).click(); await expect(up.locator('.modal')).toHaveCount(0);
  const bound = (await snap()).sessions.find(s => s.binding?.project.id === ocr.id); assert(bound);
  await up.locator('[data-group-name="local_nlp"] .workgroup-project').click();
  assert.equal((await snap()).sessions.find(s => s.id === bound.id).binding.project.id, ocr.id);
  await up.screenshot({ path: path.join(data, 'two-groups.png') });
  // Change role and membership through administrator UI while the user stays connected.
  await row.getByTitle('管理 nlp 成员身份', { exact: true }).click(); await ap.getByLabel('成员身份', { exact: true }).selectOption('member'); await ap.getByLabel('nlp 接任安排').selectOption('__vacant__'); await confirm(ap);
  await up.getByTitle('刷新工作组与项目', { exact: true }).click(); await expect(up.getByTitle('在 nlp 创建项目', { exact: true })).toHaveCount(0);
  await expect(up.getByTitle('在 ocr 创建项目', { exact: true })).toHaveCount(1);
  await assert.rejects(up.evaluate(() => window.workbench.call('project.create', { name: '越权创建', groupName: 'local_nlp' })), /子管理员|权限|管理/);
  await up.screenshot({ path: path.join(data, 'independent-roles.png') });
  await row.getByTitle('管理 ocr 成员身份', { exact: true }).click(); await ap.getByLabel('成员身份', { exact: true }).selectOption('remove'); await ap.getByLabel('ocr 接任安排').selectOption('__vacant__'); await confirm(ap);
  await up.getByTitle('刷新工作组与项目', { exact: true }).click(); await expect(up.locator('.workgroup')).toHaveCount(1);
  assert.equal((await snap()).sessions.find(s => s.id === bound.id).binding.project.id, ocr.id);
  await assert.rejects(up.evaluate(id => window.workbench.call('session.uploadTrajectory', { id }), bound.id), /项目入口配置已改变/);
  await fs.rename(path.join(share, 'projects', 'nlp'), path.join(share, 'projects', 'nlp-missing'));
  await up.getByTitle('刷新工作组与项目', { exact: true }).click(); await expect(up.locator('.workgroup .inline-error')).toBeVisible();
  await expect(up.getByText('还没有加入工作组', { exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(data, 'result.json'), JSON.stringify({ passed: true, cases: ['unassigned login and admin config import', 'no shared root or shared path input', 'unassigned users have no workbench', 'live group assignment', 'one saved account login discovers two groups', 'separate groups and same-name projects', 'independent subadmin/member roles and backend denial', 'session stays bound after switching groups', 'membership revocation blocks upload', 'inaccessible group differs from no groups'], screenshots: ['no-groups.png', 'two-groups.png', 'independent-roles.png'] }, null, 2));
  console.log(JSON.stringify({ passed: true, data }));
} finally { for (const app of apps.reverse()) await app.close().catch(() => {}); }
