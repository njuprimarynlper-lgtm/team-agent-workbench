// Real Electron/SSH integration, using only isolated loopback fixtures and data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { teamServer } from '../tests/fixtures/team-server.mjs';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';

const expect = baseExpect.configure({ timeout: 15000 });
const root = process.cwd(), build = await fs.realpath(process.env.WORKBENCH_TEST_BUILD_ROOT || path.join(root, 'dist'));
await fs.mkdir(path.join(root, '.test-data'), { recursive: true });
const data = await fs.mkdtemp(path.join(root, '.test-data', 'central-node-menu-')), store = path.join(data, 'user');
const serverA = await teamServer({ taowen: 'taowen' }), serverB = await teamServer({ taowen: 'taowen' });
const profileA = serverA.profile('taowen'), profileB = serverB.profile('taowen');
const projects = ['轨迹研究', '团队工作台'].map((name, index) => ({ id: 'project_' + (index ? 'b' : 'a').repeat(32), name }));
function seed(server, project) {
  const folder = '/projects/ocr/' + project.name;
  server.nodes.set(folder, { mode: 0o40755, uid: 0, gid: 100, data: Buffer.alloc(0) });
  server.nodes.set(folder + '/.workbench-project.json', { mode: 0o100644, uid: 0, gid: 100, data: Buffer.from(JSON.stringify({ version: 1, ...project })) });
}
projects.forEach(project => seed(serverA, project));
seed(serverB, { id: 'project_' + 'c'.repeat(32), name: '另一个节点项目' });
const cli = await authLauncher(path.join(data, 'cli'));
await fs.mkdir(store);
await fs.writeFile(path.join(store, 'settings.json'), JSON.stringify({ connections: [profileA], lastWorkspace: '', providerPaths: { codex: cli.launcher, cursor: cli.launcher, claude: cli.launcher } }));
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const errors = [], cases = [];
const call = (action, payload, target = page) => target.evaluate(([a, p]) => window.workbench.call(a, p), [action, payload]);
const snapshot = () => call('snapshot');
const nodeEntry = () => page.locator('.central-node-trigger');
const panel = () => page.locator('.central-node-panel');
const submit = () => panel().getByRole('button', { name: '连接并查看项目', exact: true });
async function fillNode(profile, password) {
  await panel().getByLabel('中央节点地址', { exact: true }).fill(profile.host);
  await panel().getByLabel('SFTP 端口', { exact: true }).fill(String(profile.port));
  await panel().getByLabel('成员账号', { exact: true }).fill(profile.username);
  await panel().getByLabel('登录密码', { exact: true }).fill(password);
}
try {
  app = await electron.launch({ args: [path.join(build, 'user')], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  // Trust only these test SSH hosts, never a user's server.
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  await expect(nodeEntry()).toHaveText('连接中央节点');
  const refresh = page.getByRole('button', { name: '刷新项目和文件', exact: true });
  await expect(refresh).toBeDisabled();
  await nodeEntry().click(); await expect(panel()).toHaveAccessibleName('登录中央节点');
  await expect(panel().getByLabel('中央节点地址')).toHaveValue(profileA.host);
  await expect(panel().getByLabel('成员账号')).toHaveValue('');
  await expect(submit()).toBeDisabled();
  await expect(panel().getByLabel('选择中央节点连接')).toHaveCount(0);
  await panel().getByLabel('登录密码', { exact: true }).fill('discard-on-close');
  await page.keyboard.press('Escape'); await expect(panel()).toHaveCount(0); await expect(nodeEntry()).toBeFocused();
  await nodeEntry().click(); await expect(panel().getByLabel('登录密码', { exact: true })).toHaveValue('');
  await page.locator('.sidebar-head h3').click(); await expect(panel()).toHaveCount(0);
  cases.push('explicit topbar login, disabled offline refresh, Escape/outside close and password clearing');

  await nodeEntry().click(); await fillNode(profileA, 'wrong-password'); await submit().click();
  await expect(panel().getByRole('alert')).toContainText('账号或密码');
  assert.equal((await snapshot()).connection, undefined);
  await panel().getByLabel('登录密码', { exact: true }).fill('test-password');
  await panel().getByLabel('登录密码', { exact: true }).press('Enter');
  await expect.poll(async () => !!(await snapshot()).connection?.connected).toBe(true);
  await expect(panel()).toHaveCount(0); await expect(refresh).toBeEnabled();
  assert(Object.values((await snapshot()).projectConnections).every(project => !project.connected));
  await nodeEntry().click(); await expect(panel().getByText('已登录', { exact: true })).toBeVisible();
  await expect(panel().locator('.central-node-permissions')).toContainText('2 个');
  await expect(panel().locator('.central-node-member')).toContainText('taowen');
  await page.screenshot({ path: path.join(data, 'topbar-menu.png') });
  await page.keyboard.press('Escape');
  cases.push('real SSH wrong-password recovery and Enter login without activating any project');

  const added = { id: 'project_' + 'd'.repeat(32), name: '新授权项目' }; seed(serverA, added);
  await refresh.click();
  await expect(page.locator(`[data-project-id="${added.id}"]`)).toBeVisible();
  await expect(panel()).toHaveCount(0);
  await nodeEntry().click(); await expect(panel().locator('.central-node-permissions')).toContainText('3 个'); await page.keyboard.press('Escape');
  // Project synchronization still uses its own project-scoped form.
  await page.locator(`[data-project-id="${projects[1].id}"]`).click();
  await page.getByRole('button', { name: '暂不设置', exact: true }).click();
  await page.getByRole('button', { name: '项目同步：未开启同步', exact: true }).click();
  await page.getByLabel('项目中央节点', { exact: true }).getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('dialog', { name: '项目中央节点', exact: true }).getByRole('button', { name: '使用此连接', exact: true }).click();
  await expect.poll(async () => !!(await snapshot()).projectConnections[projects[1].id]?.connected).toBe(true);
  const directoryDialog = page.getByRole('button', { name: '暂不设置', exact: true });
  if (await directoryDialog.isVisible()) await directoryDialog.click();
  const beforeReuse = await snapshot();
  await nodeEntry().click(); await panel().getByRole('button', { name: '连接其他中央节点', exact: true }).click();
  await panel().getByLabel('选择中央节点连接').selectOption(beforeReuse.reusableConnections[0].key);
  await expect(panel().getByLabel('连接目标项目')).toHaveCount(0);
  await panel().getByRole('button', { name: '使用此连接', exact: true }).click();
  await expect(panel()).toHaveCount(0);
  assert.deepEqual((await snapshot()).projectConnections, beforeReuse.projectConnections);
  assert.equal((await snapshot()).selectedProjectId, beforeReuse.selectedProjectId);
  cases.push('refresh discovers new authorization; project sync remains independent; global reuse preserves current selection and sync');

  await nodeEntry().click(); await panel().getByRole('button', { name: '连接其他中央节点', exact: true }).click();
  await fillNode(profileB, 'wrong-password'); await submit().click();
  await expect(panel().getByRole('alert')).toContainText('账号或密码');
  assert.equal((await snapshot()).connection.profile.port, profileA.port);
  assert.deepEqual((await snapshot()).projectConnections, beforeReuse.projectConnections);
  await panel().getByLabel('登录密码', { exact: true }).fill('test-password');
  const nextWindow = app.waitForEvent('window'); await submit().click(); const second = await nextWindow;
  second.on('pageerror', error => errors.push(error.message));
  await second.locator('.central-node-trigger').waitFor();
  await expect.poll(async () => (await call('snapshot', undefined, second)).connection?.profile.port).toBe(profileB.port);
  const secondState = await call('snapshot', undefined, second);
  assert.equal(secondState.connection.profile.username, 'taowen');
  assert.equal(secondState.connection.profile.projects.length, 1);
  assert(Object.values(secondState.projectConnections).every(project => !project.connected));
  assert.equal((await snapshot()).connection.profile.port, profileA.port);
  assert.deepEqual((await snapshot()).projectConnections, beforeReuse.projectConnections);
  cases.push('same username on another Linux node opens an isolated window; failed or successful login leaves original sync intact');

  await call('remote.disconnect'); await expect(nodeEntry()).toHaveText('连接中央节点'); await expect(refresh).toBeDisabled();
  await nodeEntry().click(); await expect(panel()).not.toContainText('可访问项目');
  await expect(panel().getByLabel('成员账号')).toHaveValue('taowen');
  await expect(panel().getByLabel('登录密码', { exact: true })).toHaveValue('');
  await fillNode(profileA, 'test-password'); await submit().click();
  await expect.poll(async () => !!(await snapshot()).connection?.connected).toBe(true);
  await expect(panel()).toHaveCount(0);
  assert(Object.values((await snapshot()).projectConnections).every(project => !project.connected));
  cases.push('disconnection shows login rather than cached authorization; reconnect does not resume project sync implicitly');

  await page.setViewportSize({ width: 1100, height: 720 }); await nodeEntry().click();
  const bounds = await panel().boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= 1100 && bounds.y + bounds.height <= 720);
  await panel().getByRole('button', { name: '连接其他中央节点', exact: true }).click();
  await page.screenshot({ path: path.join(data, 'topbar-login.png') });
  assert.equal(await panel().evaluate(element => element.scrollWidth > element.clientWidth), false);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  const report = { passed: true, data, cases };
  await fs.writeFile(path.join(data, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) { await page?.screenshot({ path: path.join(data, 'failure.png') }).catch(() => {}); throw error; }
finally { await app?.close().catch(() => {}); await Promise.all([serverA.close(), serverB.close()]); }
