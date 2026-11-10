import fs from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';

const data = await fs.mkdtemp(path.resolve('.test-data/scheduled-tray-'));
const store = path.join(data, 'app'), personal = path.join(store, 'personal'); await fs.mkdir(personal, { recursive: true });
const cli = await authLauncher(path.join(data, 'cli'), { status: 'ready', turn: 'success', userQuestion: true });
const project = { id: 'project_' + 'c'.repeat(32), name: '本地后台任务', remoteRoot: '/local-projects/example', uploadPath: '/local-projects/example/results', historyPath: '/local-projects/example/history' };
const owner = JSON.stringify(['personal', 22, 'local', 'PERSONAL']);
await fs.writeFile(path.join(personal, 'project-sync.json'), JSON.stringify({ accounts: { [owner]: { [project.id]: { project, localOnly: true, revision: 1, centralRevision: 0, brief: { background: '本机项目资料', objectives: '验证后台运行', acceptance: '能够自动执行', scope: '', deliverables: '', resources: '', constraints: '', collaboration: '' } } } } }));
await fs.writeFile(path.join(personal, 'settings.json'), JSON.stringify({ connections: [], codexRequestGuard: false, providerPaths: { codex: cli.launcher, cursor: cli.launcher, claude: cli.launcher }, lastWorkspace: '' }));
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
const target = await fs.realpath(process.argv[2] || 'dist/user');
const app = await electron.launch({ args: [target], cwd: process.cwd(), env, timeout: 60000 });
let runId;
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.waitForURL(/index\.html$/); await page.locator('.rail').waitFor(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => !!window.workbench);
  await expect.poll(() => page.evaluate(async id => (await window.workbench.call('scheduledTask.list', { projectId: id })).length, project.id)).toBe(0);
  const task = await page.evaluate(async projectId => window.workbench.call('scheduledTask.save', { projectId, input: { projectId, name: '隐藏窗口后的任务', prompt: '检查本地资料', supplement: '仅用于此任务', model: '', networkRoute: 'direct', permissionMode: 'inherit', includeBrief: true, schedule: { kind: 'once', at: new Date(Date.now() + 3000).toISOString(), timezone: 'Asia/Shanghai' } } }), project.id);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
  const read = async () => JSON.parse(await fs.readFile(path.join(personal, 'scheduled-tasks/index.json'), 'utf8'));
  await expect.poll(async () => (await read()).runs[0]?.status, { timeout: 20000 }).toBe('waiting');
  const running = (await read()).runs[0]; runId = running.id;
  if(running.taskId!==task.id)throw Error('scheduled task binding changed');
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); });
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  await page.locator('.scheduled-run-entry').click();
  await expect(page.getByText('下一步做什么？', {exact:true})).toBeVisible();
  await page.getByLabel('继续验证', {exact:true}).check();
  await page.getByRole('button', {name:'提交回答',exact:true}).click();
  await expect.poll(async () => (await read()).runs[0]?.status, {timeout:15000}).toBe('completed');
  await expect.poll(() => page.evaluate(async () => (await window.workbench.call('snapshot')).sessions.filter(session=>session.scheduledRun?.managed).length)).toBe(0);
  await fs.writeFile(path.join(task.cwd, 'report.md'), 'mock report');
  const preview = await page.evaluate(async input => window.workbench.call('session.file.preview', input), { id: running.sessionId, path: 'report.md' });
  if(!JSON.stringify(preview).includes('mock report'))throw Error('archived file preview unavailable');
  await page.getByRole('button',{name:'继续对话',exact:true}).click();
  await expect.poll(() => page.evaluate(async ()=>(await window.workbench.call('snapshot')).sessions.filter(session=>session.scheduledRun?.managed===false).length)).toBe(1);
  const restored=await page.evaluate(async ()=>(await window.workbench.call('snapshot')).sessions.filter(session=>session.scheduledRun?.managed===false));
  if(restored.length!==1)throw Error('continuation did not become one ordinary session');
  if(errors.length)throw Error(errors.join('\n'));
  console.log('Real Electron tray lifecycle, hidden scheduled execution, question handling, archive and continuation verified.');
} finally {
  const exited = once(app.process(), 'exit');
  await app.evaluate(({app})=>app.quit()).catch(()=>{});
  let timer;
  try { await Promise.race([exited, new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('工作台未完成正常退出')),20000);})]); } finally { clearTimeout(timer); await app.close(); }
}
await expect.poll(async () => { try { await fs.stat(path.join(personal,'scheduled-tasks/scheduler.lock'));return false; }catch(e){return e.code==='ENOENT';} }).toBe(true);
console.log(data);
