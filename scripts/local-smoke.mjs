import { releaseRoot } from './release-paths.mjs';
import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';

const root = process.cwd(), packaged = process.argv.includes('--packaged');
const data = path.join(root, '.test-data', 'local-ui-' + Date.now()), share = path.join(data, 'share');
await fs.mkdir(share, { recursive: true });
const fixture = await authLauncher(path.join(data, 'cli')); await fixture.write({ status: 'ready' });
const apps = [], pages = [], errors = [];
async function launch(edition, name) {
  const store = path.join(data, name); await fs.mkdir(store);
  if (edition === 'user') await fs.writeFile(path.join(store, 'settings.json'), JSON.stringify({ connections: [], providerPaths: { codex: fixture.launcher, cursor: fixture.launcher }, lastWorkspace: '' }));
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: store, WORKBENCH_ADMIN_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
  const config = packaged ? { executablePath: path.join(releaseRoot, edition, 'win-unpacked', 'Team Agent ' + (edition === 'user' ? 'User' : 'Admin') + '.exe'), args: [] } : { args: ['dist/' + edition] };
  const app = await electron.launch({ ...config, cwd: root, env, timeout: 60000 }); apps.push(app);
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message)); pages.push(page); return { app, page };
}
async function confirm(page) { await page.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0); }
async function connectUser(page, username) {
  await page.getByLabel('共享区类型').selectOption('local');
  await page.getByLabel('本机工作路径', { exact: true }).fill(data);
  await page.getByLabel('本地共享区根目录', { exact: true }).fill(share);
  await page.getByLabel('共享工作路径', { exact: true }).fill('/projects/competition');
  await page.getByLabel('模拟成员账号').fill(username); await page.getByLabel('登录密码', { exact: true }).fill('member-test-password');
  await page.getByRole('button', { name: '连接并验证工作路径', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0);
}
try {
  const admin = await launch('admin', 'admin'); const ap = admin.page;
  await ap.getByLabel('共享区类型').selectOption('local'); await ap.getByLabel('本地共享区根目录').fill(share);
  await ap.getByLabel('管理账号', { exact: true }).fill('admin'); await ap.getByLabel('登录密码', { exact: true }).fill('admin-test-password');
  await ap.getByRole('button', { name: '连接并验证权限', exact: true }).click(); await expect(ap.locator('.modal')).toHaveCount(0);
  await ap.getByRole('button', { name: '初始化账号管理', exact: true }).click(); await confirm(ap);
  await ap.getByRole('button', { name: '创建用户组', exact: true }).click(); await ap.getByLabel('组标识').fill('competition'); await confirm(ap);
  for (const username of ['alice', 'bob']) {
    await ap.getByRole('button', { name: '创建用户', exact: true }).click();
    await ap.getByLabel('成员姓名', { exact: true }).fill(username); await ap.getByLabel('模拟账号', { exact: true }).fill(username);
    await ap.getByLabel('初始密码', { exact: true }).fill('member-test-password'); await ap.getByLabel('再次输入密码', { exact: true }).fill('member-test-password');
    await ap.locator('.modal .check-row').filter({ hasText: 'competition' }).first().locator('input').check();
    if (username === 'alice') await ap.locator('.modal .check-row').filter({ hasText: '内容子管理员' }).locator('input').check();
    await confirm(ap);
  }
  const exported = path.join(data, 'alice.json');
  await admin.app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, exported);
  await ap.locator('tbody tr').filter({ hasText: 'alice' }).getByRole('button', { name: '导出连接配置' }).click(); await confirm(ap);
  const config = JSON.parse(await fs.readFile(exported, 'utf8')); assert.equal(config.mode, 'local'); assert.equal(config.localRoot, share); assert(!JSON.stringify(config).includes('password'));
  const alice = await launch('user', 'alice'); await connectUser(alice.page, 'alice');
  await alice.page.getByRole('button', { name: '创建第一个项目', exact: true }).click(); await alice.page.getByLabel('项目名称').fill('华为算法比赛'); await alice.page.getByRole('button', { name: '创建项目', exact: true }).click();
  const bob = await launch('user', 'bob'); await connectUser(bob.page, 'bob');
  const snapshot = await alice.page.evaluate(() => window.workbench.call('snapshot')), p = snapshot.connection.profile.projects[0];
  assert.equal(await bob.page.getByTitle('创建远端项目', { exact: true }).count(), 0);
  const source = path.join(data, 'competition-note.md'); await fs.writeFile(source, '# 比赛协同联调\n用户 A 与用户 B 各迭代两轮。');
  await alice.app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, source);
  await alice.page.getByTitle('上传文件到当前目录', { exact: true }).click();
  await expect.poll(async () => (await alice.page.evaluate(() => window.workbench.call('snapshot'))).transfers[0]?.status, { timeout: 15000 }).toBe('done');
  const uploaded = (await alice.page.evaluate(() => window.workbench.call('snapshot'))).transfers[0];
  assert((await fs.stat(path.join(share, ...uploaded.target.split('/').filter(Boolean)))).isFile());
  await bob.page.getByTitle('刷新文件', { exact: true }).click(); await bob.page.locator('.file-row').filter({ hasText: 'competition-note.md' }).click();
  await expect(bob.page.locator('.preview-content')).toContainText('各迭代两轮');
  await alice.page.getByTitle('新建会话', { exact: true }).click(); await alice.page.getByLabel('Codex 登录状态').getByText('已登录', { exact: true }).waitFor(); await alice.page.getByRole('button', { name: '创建会话', exact: true }).click();
  await alice.page.getByLabel('任务输入', { exact: true }).fill('为算法比赛建立基线');
  await alice.page.getByRole('button', { name: '交接文件', exact: true }).click(); await alice.page.getByLabel('交接文件正文').fill('# 比赛第一轮\n量化接口和数据已就绪'); await alice.page.getByRole('button', { name: '保存交接文件' }).click();
  await fixture.write({ status: 'ready', fileApproval: true });
  await alice.page.getByTitle('发送任务', { exact: true }).click();
  const approval = alice.page.locator('.approval'); await expect(approval).toContainText('Codex 请求修改文件');
  await approval.getByText('查看请求详情', { exact: true }).click();
  await expect(approval.locator('pre')).toContainText('solution.py'); await expect(approval.locator('pre')).toContainText('+new_value');
  await approval.getByRole('button', { name: '拒绝', exact: true }).click(); await expect(approval).toHaveCount(0);
  const session = (await alice.page.evaluate(() => window.workbench.call('snapshot'))).sessions[0];
  await alice.page.evaluate(id => window.workbench.call('session.uploadTrajectory', { id }), session.id);
  await expect.poll(async () => (await alice.page.evaluate(() => window.workbench.call('snapshot'))).transfers[0]?.status).toBe('done');
  const history = (await alice.page.evaluate(() => window.workbench.call('snapshot'))).transfers[0];
  await assert.rejects(bob.page.evaluate(x => window.workbench.call('remote.preview', x), { projectId: p.id, path: history.target }), /模拟权限拒绝/);
  const row = ap.locator('tbody tr').filter({ hasText: 'bob' });
  await row.getByRole('button', { name: '停用', exact: true }).click(); await confirm(ap);
  await assert.rejects(bob.page.evaluate(x => window.workbench.call('remote.list', x), { projectId: p.id, path: p.remoteRoot }), /已停用/);
  await row.getByRole('button', { name: '启用', exact: true }).click(); await confirm(ap);
  assert((await bob.page.evaluate(x => window.workbench.call('remote.list', x), { projectId: p.id, path: p.remoteRoot })).length);
  assert.equal(await alice.page.evaluate(() => typeof window.admin), 'undefined'); assert.equal(await ap.evaluate(() => typeof window.workbench), 'undefined'); assert.deepEqual(errors, []);
  if (!packaged) { await ap.screenshot({ path: path.join(data, 'admin.png'), timeout: 10000 }); await bob.page.screenshot({ path: path.join(data, 'user-bob.png'), timeout: 10000 }); }
  await fs.writeFile(path.join(data, 'result.json'), JSON.stringify({ passed: true, packaged, sharedRoot: share, cases: ['admin bootstrap', 'create group', 'create members/subadmin', 'export local profile', 'concurrent admin and two users', 'project creation', 'real disk upload', 'teammate preview', 'Codex authentication UI', 'file approval includes exact diff', 'handoff editing', 'history archive', 'history privacy', 'live disable/enable', 'edition isolation'] }, null, 2));
  console.log('Local filesystem administrator + two users UI passed:', data);
} catch (error) { for (const app of apps) await app.evaluate(({ app }) => app.exit(1)).catch(() => {}); throw error; }
finally { for (const app of apps.reverse()) await app.close().catch(() => {}); }
