import { _electron as electron, expect as baseExpect, type ElectronApplication, type Page } from '@playwright/test';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from '../tests/fixtures/member-profile';
import { Workbench } from '../src/core/workbench';
// @ts-expect-error fixture
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';
const expect = baseExpect.configure({ timeout: 20000 });
async function main() {
const root = process.cwd(), data = path.join(root, '.test-data', 'collaboration-ui-' + Date.now()), share = path.join(data, 'shared');
await fs.mkdir(share, { recursive: true });
const cli = await authLauncher(path.join(data, 'cli'), { status: 'ready', turn: 'success' });
const admin = new LocalAdminConnection(() => {});
await admin.connect({ mode: 'local', localRoot: share, host: 'local', port: 22, username: '', root: '/srv/teamspace', fingerprint: '' }, '', '', async () => false);
await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: 'research' });
for (const username of ['alice', 'bob']) await admin.operation({ op: 'user_create', username, name: username, password: '1', groups: ['local_research'], contentAdminGroups: username === 'alice' ? ['local_research'] : [] });
const profiles = Object.fromEntries(['alice', 'bob'].map(name => [name, memberProfile(admin.snapshot.profile!, admin.snapshot.state!, name)]));
const alice = new Workbench(path.join(data, 'alice'), () => {}, () => {}), bob = new Workbench(path.join(data, 'bob'), () => {}, () => {});
const brief = { background: '项目背景', objectives: '提高质量', acceptance: '指标验收', scope: '', deliverables: '', resources: '', constraints: '', collaboration: '' };
await alice.store.init(); await alice.configureWorkspace(profiles.alice, '1', data, async () => false);
const project = await alice.createProject('方案迭代', 'local_research', brief);
await bob.store.init(); await bob.configureWorkspace(profiles.bob, '1', data, async () => false);
for (const wb of [alice, bob]) { wb.store.settings.providerPaths = { codex: cli.launcher, cursor: cli.launcher }; await wb.createSession('codex', data, project.id); }
const file = path.join(data, 'report.md'); await fs.writeFile(file, '原始结论');
for (const name of ['第一项结论', '第二项结论']) await bob.remote.upload(bob.remote.binding(project.id), file, bob.remote.binding(project.id).project.uploadPath + '/' + name + '.md', () => {}, { kind: 'contribution', title: name, description: '待整理依据 ' + name });
await alice.close(); await bob.close(); admin.disconnect();
const apps: ElectronApplication[] = [], pages: Page[] = [], errors: string[] = [];
async function launch(edition: string, user: string) {
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: path.join(data, user), WORKBENCH_ADMIN_DATA_DIR: path.join(data, user) }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['dist/' + edition], cwd: root, env, timeout: 60000 }); apps.push(app);
  const page = await app.firstWindow(); pages.push(page); page.on('pageerror', e => errors.push(e.message)); return { app, page, env };
}
const call = (page: Page, action: string, payload?: unknown): Promise<any> => page.evaluate(([a, p]) => (window as any).workbench.call(a, p), [action, payload]);
try {
  const a = await launch('user', 'alice'), b = await launch('user', 'bob'), management = await launch('admin', 'admin');
  for (const [client, name] of [[a, 'alice'], [b, 'bob']] as const) await call(client.page, 'remote.connect', { profile: profiles[name], password: '1', localPath: data });
  const ap = a.page, bp = b.page, mp = management.page;
  // Two user data directories coexist; reopening one user edition creates another window
  // in the owning process so all windows share one safely serialized local state.
  const duplicate = spawn(electronPath as unknown as string, ['dist/user'], { cwd: root, env: b.env, windowsHide: true, stdio: 'ignore' });
  const exitCode = await new Promise<number | null>((resolve, reject) => { const timer = setTimeout(() => { duplicate.kill(); reject(new Error('duplicate instance did not exit')); }, 10000); duplicate.on('exit', code => { clearTimeout(timer); resolve(code); }); duplicate.on('error', reject); });
  assert.equal(exitCode, 0); await expect.poll(() => b.app.windows().length).toBe(2);
  const secondBobWindow = b.app.windows().find(page => page !== bp)!; pages.push(secondBobWindow); secondBobWindow.on('pageerror', error => errors.push(error.message));
  await secondBobWindow.getByTitle('工作会话', { exact: true }).waitFor(); assert.equal((await call(secondBobWindow, 'snapshot')).sessions.length, 1);
  await secondBobWindow.close(); await expect.poll(() => b.app.windows().length).toBe(1);
  await mp.getByLabel('共享区类型').selectOption('local'); await mp.getByLabel('本地共享区根目录').fill(share);
  await mp.getByRole('button', { name: '打开共享目录', exact: true }).click();
  // The admin window shares the same team state but no longer carries an offline validity setting.
  await expect(mp.locator('.admin-content')).not.toContainText('离线工作');
  await call(bp, 'remote.manifest');
  await ap.getByTitle('设置', { exact: true }).click();
  await expect(ap.getByRole('tab', { name: '项目设置', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(ap.getByLabel('项目背景', { exact: true })).toHaveValue('项目背景'); await ap.getByLabel('项目目标', { exact: true }).fill('提高质量和效率'); await ap.getByRole('button', { name: '保存项目设置', exact: true }).click();
  await expect(ap.locator('.project-settings-form')).toContainText('资料版本：v2');
  const briefMarkdown = await fs.readFile(path.join(share, ...project.remoteRoot.split('/').filter(Boolean), '项目说明.md'), 'utf8');
  assert.match(briefMarkdown, /## 项目目标\s+提高质量和效率/); await ap.getByRole('button', { name: '关闭窗口', exact: true }).click();
  // Wait for Alice's asynchronous save before Bob re-reads the manifest, or Bob legitimately still sees version 1.
  await expect(ap.getByRole('button', { name: '项目资料 · v2', exact: true })).toBeVisible();
  await call(bp, 'remote.manifest'); await expect(bp.locator('.session-materials .materials-update')).toBeVisible();
  assert.equal((await call(bp, 'snapshot')).sessions[0].projectBrief.revision, 1);
  // The adoption action and the version note live behind the collapsed materials summary.
  await bp.locator('.session-materials > summary').click(); await expect(bp.locator('.session-materials-content')).toContainText('有新版本'); await bp.getByRole('button', { name: '更新项目说明', exact: true }).click();
  await expect.poll(async () => (await call(bp, 'snapshot')).sessions[0].projectBrief.revision).toBe(2);
  await bp.getByTitle('公共成果', { exact: true }).click(); await bp.locator('.content-card').filter({ hasText: '第一项结论' }).click();
  await bp.getByRole('button', { name: '修改自己的提交', exact: true }).click(); await bp.getByLabel('公共成果内容').fill('Bob 补充的验证依据'); await bp.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(bp.locator('.content-detail')).toContainText('Bob 补充的验证依据');
  await ap.getByTitle('公共成果', { exact: true }).click(); await ap.locator('.content-card').filter({ hasText: '第一项结论' }).click();
  await ap.getByRole('button', { name: '整理 / 编辑', exact: true }).click(); await ap.getByLabel('公共成果内容').fill('Alice 统一整理的结论');
  await ap.getByText('合并其他成果（保存后替代所选原件）', { exact: true }).click(); await ap.locator('.content-detail .check-row input').check(); await ap.getByRole('button', { name: '保存整理结果', exact: true }).click();
  await expect(ap.locator('.content-card')).toHaveCount(1);
  await bp.getByRole('button', { name: '刷新', exact: true }).click(); await bp.getByLabel('搜索公共成果').fill('统一整理');
  await expect(bp.locator('.content-card')).toHaveCount(1); await bp.locator('.content-card').click();
  await expect(bp.getByRole('button', { name: '修改自己的提交', exact: true })).toHaveCount(0);
  await expect(bp.locator('.content-detail')).toContainText('已整理，原作者不可覆盖');
  await bp.getByRole('button', { name: '加入当前会话', exact: true }).click(); await bp.getByTitle('工作会话', { exact: true }).click();
  await expect(bp.locator('.source-chips')).toContainText('第一项结论 · v3');
  const snapshot = await call(bp, 'snapshot'), reference = snapshot.sessions[0].sources.find((s: any) => s.name === '第一项结论 · v3');
  assert((await fs.readFile(reference.localPath, 'utf8')).includes('Alice 统一整理'));
  assert(snapshot.inputs[snapshot.sessions[0].id].sourceIds.includes(reference.id));
  // An existing group still requires a brief for every new project, or explicit deferral.
  await ap.getByTitle('在 research 创建项目', { exact: true }).click(); await ap.getByLabel('项目名称', { exact: true }).fill('第二个项目');
  await expect(ap.getByRole('dialog', { name: '项目资料' }).getByRole('button', { name: '创建项目', exact: true })).toBeDisabled();
  await ap.getByText('先创建目录，稍后完善项目资料', { exact: true }).click(); await ap.getByRole('dialog', { name: '项目资料' }).getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(ap.getByRole('button', { name: '项目资料 · 待完善', exact: true })).toBeVisible();
  await ap.getByRole('button', { name: '项目资料 · 待完善', exact: true }).click();
  await ap.getByLabel('项目背景', { exact: true }).fill('新项目背景'); await ap.getByLabel('项目目标', { exact: true }).fill('新目标'); await ap.getByLabel('验收标准', { exact: true }).fill('新指标'); await ap.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(ap.getByRole('button', { name: '项目资料 · v1', exact: true })).toBeVisible();
  await ap.setViewportSize({ width: 1100, height: 760 }); await ap.getByTitle('公共成果', { exact: true }).click();
  await ap.locator(`[data-project-id="${project.id}"]`).click(); await ap.locator('.content-card').click();
  await ap.screenshot({ path: path.join(data, 'public-content.png') }); await mp.screenshot({ path: path.join(data, 'admin-management.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, data, cases: ['concurrent distinct users/admin', 'multi-window user edition with shared state', 'admin window without an offline setting', 'project settings synchronize 项目说明.md', 'project brief versions and explicit adoption', 'author revision', 'subadmin edit/merge/lock', 'search and frozen session reuse', 'every-project brief lifecycle', '1100px layout'] }));
} catch (error) {
  for (const [i, page] of pages.entries()) { await page.screenshot({ path: path.join(data, 'failure-' + i + '.png') }).catch(() => {}); await fs.writeFile(path.join(data, 'failure-' + i + '.txt'), await page.locator('body').innerText().catch(() => 'closed')); }
  throw error;
} finally { for (const app of apps.reverse()) await app.close().catch(() => {}); }

}
main().catch(error => { console.error(error); process.exitCode = 1; });
