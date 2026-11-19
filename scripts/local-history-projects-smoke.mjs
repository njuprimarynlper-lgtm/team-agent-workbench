// Actual Electron + loopback SSH + synthetic CLI. No real user records or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { teamServer } from '../tests/fixtures/team-server.mjs';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';

const expect = baseExpect.configure({ timeout: 20000 });
const root = process.cwd(), built = path.resolve(process.env.WORKBENCH_TEST_BUILD_ROOT || 'dist');
await fs.mkdir(path.join(root, '.test-data'), { recursive: true });
const data = await fs.mkdtemp(path.join(root, '.test-data', 'local-history-integration-')), store = path.join(data, 'user');
const server = await teamServer({ alice: 'alice' }), profile = server.profile('alice');
const owner = JSON.stringify([profile.host.toLowerCase(), profile.port, profile.username, profile.fingerprint]);
const account = path.join(store, 'account-workspaces', createHash('sha256').update(owner).digest('hex'));
const cli = await authLauncher(path.join(data, 'cli'), { status: 'ready', turn: 'success' });
const old = { id: 'project_' + 'a'.repeat(32), name: '同名研究项目', groupName: 'ocr', remoteRoot: '/projects/ocr/旧项目', uploadPath: '/projects/ocr/旧项目/submissions/alice', historyPath: '/projects/ocr/旧项目/trajectories/alice' };
const current = { ...old, id: 'project_' + 'b'.repeat(32), remoteRoot: '/projects/ocr/新项目' };
const seed = project => {
  server.nodes.set(project.remoteRoot, { mode: 0o40755, uid: 0, gid: 100, data: Buffer.alloc(0) });
  server.nodes.set(project.remoteRoot + '/.workbench-project.json', { mode: 0o100644, uid: 0, gid: 100, data: Buffer.from(JSON.stringify({ version: 1, id: project.id, name: project.name })) });
};
seed(current);
const write = async (directory, name, value) => { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, name), JSON.stringify(value)); };
const settings = { connections: [profile], lastWorkspace: '', providerPaths: { codex: cli.launcher, cursor: cli.launcher, claude: cli.launcher } };
const id = randomUUID(), now = new Date().toISOString();
const savedBinding = { connectionId: profile.id, host: profile.host, port: profile.port, username: profile.username, fingerprint: profile.fingerprint, project: old };
const session = { id, title: '旧项目中的本机对话', provider: 'codex', purpose: 'work', cwd: data, networkRoute: 'direct', createdAt: now, status: 'idle', sources: [], approvals: [], autoUpload: false, handoffPath: path.join(account, 'sessions', id, 'handoff.md'), binding: savedBinding, messages: [{ id: randomUUID(), role: 'user', text: 'PR12_PREVIOUS_USER', createdAt: now }, { id: randomUUID(), role: 'assistant', text: 'PR12_PREVIOUS_REPLY', createdAt: now }] };
await write(store, 'settings.json', settings);
await write(account, 'settings.json', { ...settings, workspaceSnapshot: { profile: { ...profile, projects: [old] }, workspaces: [] } });
await write(account, 'sessions.json', [session]);
await write(account, 'inputs.json', { [id]: { text: 'PR12_UNSENT_INPUT', sourceIds: [], answers: {} } });
await write(account, 'migration.json', { version: 1, owner, completedAt: now, sources: [store], counts: [0, 0, 0, 0] });
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
let app, page; const errors = [], cases = [];
const launch = async () => {
  app = await electron.launch({ args: [path.join(built, 'user')], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  await page.locator('.sidebar').waitFor();
};
const call = (action, payload) => page.evaluate(([action, payload]) => window.workbench.call(action, payload), [action, payload]);
const snapshot = () => call('snapshot');
const login = () => call('remote.connect', { profile, password: 'test-password' });
try {
  await launch(); await login();
  let state = await snapshot();
  assert.equal(state.projectSync[old.id].historyOnly, true);
  assert.equal(state.projectConnections[old.id].connected, false); assert.equal(state.projectConnections[current.id].connected, true);
  assert.deepEqual(state.sessions.find(item => item.id === id).binding, savedBinding);
  assert.equal(state.inputs[id].text, 'PR12_UNSENT_INPUT');
  const history = page.getByRole('region', { name: '本地历史项目', exact: true });
  await expect(history.locator(`[data-project-id="${old.id}"]`)).toBeVisible();
  await history.locator(`[data-project-id="${old.id}"]`).click();
  await expect(page.getByRole('dialog', { name: '设置项目代码目录', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('任务输入', { exact: true })).toHaveValue('PR12_UNSENT_INPUT');
  await expect(history.getByRole('switch')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '寻求帮助', exact: true })).toBeDisabled();
  await page.screenshot({ path: path.join(data, 'history-restored.png') });
  const denied = await page.evaluate(async payload => {
    try { await window.workbench.call('remote.list', payload); return { denied: false, message: '' }; }
    catch (error) { return { denied: true, message: error.message || error.failure?.message || '' }; }
  }, { projectId: old.id, path: old.remoteRoot });
  assert.equal(denied.denied, true); assert.match(denied.message, /此项目尚未连接|项目入口配置已改变|项目入口不存在/);
  cases.push('missing project cache is reconstructed from the same account conversation; same-name new project does not take over its binding or input');
  await call('session.send', { id, text: 'PR12_CONTINUE_LOCAL' });
  await expect.poll(async () => (await snapshot()).sessions.find(item => item.id === id)?.messages.filter(message => message.role === 'assistant').length).toBeGreaterThan(1);
  await call('session.input', { id, input: { text: 'PR12_RESTART_DRAFT', sourceIds: [], answers: {} } });
  await expect.poll(async () => ['idle', 'error'].includes((await snapshot()).sessions.find(item => item.id === id)?.status)).toBe(true);
  assert.equal((await snapshot()).sessions.find(item => item.id === id).status, 'idle');
  cases.push('historical conversation accepts a real synthetic CLI turn while shared access remains disabled');
  await app.close(); app = undefined;
  await launch(); await login();
  state = await snapshot();
  assert.equal(state.projectSync[old.id].historyOnly, true); assert.equal(state.inputs[id].text, 'PR12_RESTART_DRAFT');
  assert(state.sessions.find(item => item.id === id).messages.some(message => message.text.includes('PR12_CONTINUE_LOCAL')));
  assert.deepEqual(state.sessions.find(item => item.id === id).binding, savedBinding);
  cases.push('full application restart retains history, new replies, unsent draft and original binding');
  await page.getByRole('region', { name: '本地历史项目', exact: true }).locator(`[data-project-id="${old.id}"]`).click();
  await call('session.close', { id });
  await expect(page.getByRole('button', { name: '已关闭会话（1）', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '已关闭会话（1）', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('旧项目中的本机对话', { exact: true }).first()).toBeVisible();
  cases.push('closed historical conversation remains reachable through the current closed-conversation UI');
  seed(old); await call('remote.manifest');
  await expect.poll(async () => (await snapshot()).projectSync[old.id]?.historyOnly).toBe(false);
  await expect.poll(async () => (await snapshot()).projectConnections[old.id]?.connected).toBe(true);
  assert.deepEqual((await snapshot()).sessions.find(item => item.id === id).binding, savedBinding);
  await call('remote.list', { projectId: old.id, path: old.remoteRoot });
  cases.push('restoring the same remote project ID automatically restores its access and synchronization');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, data, cases }));
} finally { await app?.close(); await server.close(); }
