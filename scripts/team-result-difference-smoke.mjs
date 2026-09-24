import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const expect = baseExpect.configure({ timeout: 10000 });
const root = process.cwd(), data = path.join(root, '.test-data', 'team-result-difference-' + Date.now());
await fs.mkdir(data, { recursive: true });
// Production components and Workbench methods; only the remote catalog is a fixture.
// No Workbench.init(), provider discovery, real CLI, or visible desktop window.
await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
  import { app, BrowserWindow, ipcMain } from 'electron';
  import { Workbench } from './src/core/workbench';
  import { linkConclusionPublications } from './src/core/conclusion-publications';
  import { grantTestWorkspace, offlineProjectId } from './tests/fixtures/offline-workspace';
  import path from 'node:path';
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    let window, pendingImport, failImport = false;
    const wb = new Workbench(path.join(__dirname, 'state'), () => window?.webContents.send('event', { type: 'state' }), () => {});
    await wb.store.init(); grantTestWorkspace(wb, __dirname);
    wb.remote.binding = () => { const p = wb.store.settings.workspaceSnapshot.profile; return { connectionId: p.id, host: p.host, port: p.port, username: p.username, fingerprint: p.fingerprint, project: p.projects[0] }; };
    const now = new Date().toISOString();
    let items = [{ id: 'shared-result', title: '【项目结论】 验证过的团队结论', description: '这是团队确认的第一版结论。', kind: 'contribution', category: 'finding', author: 'alice', updatedBy: 'alice', createdAt: now, updatedAt: now, revision: 1, state: 'submitted', path: '/p/result', sha256: 'a'.repeat(64), size: 32 }];
    const original = structuredClone(items[0]);
    wb.remote.contentList = async () => structuredClone(items);
    ipcMain.handle('call', async (_, action, p = {}) => {
      if (action === 'content.list') return structuredClone(items);
      if (action === 'content.edit') {
        const item = items.find(item => item.id === p.change.id);
        if (!item || item.revision !== p.change.revision) throw new Error('成果版本已变化');
        Object.assign(item, {title:p.change.title, description:p.change.description, revision:item.revision + 1}); return item;
      }
      if (action === 'conclusion.list') return wb.conclusions(p.projectId, p.includeArchived);
      if (action === 'conclusion.import') {
        if (pendingImport) await new Promise(resolve => { pendingImport = resolve; });
        if (failImport) { failImport = false; throw new Error('测试存入失败'); }
        return wb.importContentConclusion(p.projectId, p.contentId, p.expectedRevision);
      }
      if (action === 'conclusion.deleteMany') return wb.deleteConclusions(p.selections);
      if (action === 'conclusion.save') return wb.saveConclusion(p.id, p.title, p.content, p.category);
      if (action === 'conclusion.archive') return wb.archiveConclusion(p.id, p.archived);
      if (action === 'test.personal') return wb.conclusions(offlineProjectId, true);
      if (action === 'test.deletePersonal') { const c = wb.conclusions(offlineProjectId, true).find(c => c.automatic); return wb.deleteConclusion(c.id, c.version); }
      if (action === 'test.editPersonal') { const c = wb.conclusions(offlineProjectId)[0]; return wb.saveConclusion(c.id, c.title, '这是我的独立补充分析。'); }
      if (action === 'test.archivePersonal') return wb.archiveConclusion(wb.conclusions(offlineProjectId)[0].id, true);
      if (action === 'test.remoteUpdate') { items[0].revision++; items[0].description = '这是团队补充证据后的新版结论。'; items[0].sha256 = 'b'.repeat(64); return; }
      if (action === 'test.remoteDelete') { items = []; return; }
      if (action === 'test.remoteRestore') { items = [structuredClone(original)]; return; }
      if (action === 'test.roleCatalog') {
        items = ['【项目标准】 接口规范', '【项目标准】【验收约束】 回归边界', '【方法探索】 候选方法', '【项目结论】 验证依据', '没有标签的成果'].map((title, index) => ({...original, id:'submitted-' + index, path:'/p/submitted-' + index, title}));
        items.push({...original, id:'curated', path:'/p/curated', title:'【综合整理】 跨方案结论', state:'curated', revision:2});
        wb.store.conclusions = []; await wb.store.save(); window.webContents.send('event', {type:'state'}); return;
      }
      if (action === 'test.legacyPublication') {
        items = [structuredClone(original)];
        const binding = wb.remote.binding(offlineProjectId), sourceId = 'local-preparation-1';
        wb.store.conclusions = [{ id: 'local-result', projectId: offlineProjectId, title: original.title, content: original.description, version: 1, automatic: true, updatedAt: now, sources: [{ id: sourceId, kind: 'session', title: '本地整理', updatedAt: now }] }];
        const drafts = [{ id: 'local-preparation', binding, artifacts: [{ id: sourceId, submitted: 'upload-task' }] }];
        const transfers = [{ id: 'upload-task', status: 'done', kind: 'upload', binding, target: original.path, sha256: original.sha256, metadata: {kind:'contribution'} }];
        linkConclusionPublications(wb.store.conclusions, drafts, transfers);
        await wb.store.save(); window.webContents.send('event', { type: 'state' }); return;
      }
      if (action === 'test.failImport') { failImport = true; return; }
      if (action === 'test.pauseImport') { pendingImport = true; return; }
      if (action === 'test.resumeImport') { const resolve = pendingImport; pendingImport = undefined; resolve(); return; }
      if (action === 'test.close') { await wb.close(); return; }
      throw new Error('Unexpected action: ' + action);
    });
    window = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true } });
    await window.loadFile(path.join(__dirname, 'index.html'));
  });
  app.on('window-all-closed', () => app.quit());
` }, bundle: true, outfile: path.join(data, 'main.cjs'), platform: 'node', format: 'cjs', external: ['electron', 'ssh2'] });
await fs.writeFile(path.join(data, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron'); contextBridge.exposeInMainWorld('workbench',{call:(...args)=>ipcRenderer.invoke('call',...args),subscribe:callback=>{const handler=(_,event)=>callback(event);ipcRenderer.on('event',handler);return()=>ipcRenderer.removeListener('event',handler);}});`);
await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { SharedContentLibrary } from './src/renderer/shared-content';
  import { ConclusionLibrary } from './src/renderer/conclusions';
  import { ProjectResults } from './src/renderer/project-results';
  import './src/renderer/styles.css';
  import './src/renderer/result-card.css';
  function Harness() {
    const [scope, setScope] = useState('team'), [options, setOptions] = useState({admin:false, username:'alice'}), [notice, setNotice] = useState('');
    window.audit = { mount: setOptions };
    const project = {id:'project_' + 'a'.repeat(32), name:'差异验证项目'};
    return <><ProjectResults projectName={project.name} scope={scope} changeScope={setScope}>
      {scope === 'team' ? <SharedContentLibrary project={project} {...options} aliases={{}} aliasSaved={async()=>{}} attach={async()=>{}} attachSessions={[]} notice={setNotice} mergeSessions={[]} mergeStarted={()=>{}} returnToUpdates={()=>{}} embedded/>
      : <ConclusionLibrary project={project} sessions={[]} notice={setNotice} mergeStarted={()=>{}} embedded/>}
    </ProjectResults><output aria-label="操作结果">{notice}</output></>;
  }
  createRoot(document.getElementById('root')).render(<Harness/>);
` }, bundle: true, outfile: path.join(data, 'renderer.js'), platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
await fs.writeFile(path.join(data, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['--disable-gpu', path.join(data, 'main.cjs')], cwd: root, env });
try {
  const page = await app.firstWindow(), errors = []; page.on('pageerror', error => errors.push(error.message));
  const call = (action, payload) => page.evaluate(({ action, payload }) => window.workbench.call(action, payload), { action, payload });
  const mount = options => page.evaluate(options => window.audit.mount(options), options);
  const cards = page.locator('.content-card'), save = () => cards.getByRole('button', { name: /^存入个人成果库：/ });
  const refresh = async () => { await page.getByRole('button', { name: '刷新', exact: true }).click(); await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled(); };
  await expect(cards).toHaveCount(1); await expect(cards).toContainText('尚未存入个人库');
  await expect(cards.locator('.result-card-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(cards.locator('.result-card-details')).toHaveCount(0); await expect(save()).toBeVisible();
  await expect(page.locator('.content-detail')).toHaveCount(0);
  await cards.locator('.result-card-toggle').click();
  await expect(cards.locator('.result-card-details')).toContainText('这是团队确认的第一版结论。');
  await expect(save()).toHaveCount(1);
  expect(await cards.evaluate(card => {
    const summary = card.querySelector('.result-card-toggle').getBoundingClientRect();
    const detail = card.querySelector('.result-card-details').getBoundingClientRect();
    const actions = card.querySelector('.result-card-actions').getBoundingClientRect();
    return summary.right <= actions.left && summary.bottom <= detail.top && actions.bottom <= detail.top;
  })).toBe(true);
  await cards.locator('.result-card-toggle').click(); await expect(cards.locator('.result-card-details')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: '包含个人库已有成果' })).toHaveCount(0);
  await page.screenshot({ path: path.join(data, 'team-differences.png') });
  await call('test.failImport'); await save().click();
  await expect(page.getByRole('alert')).toContainText('测试存入失败'); await expect(cards).toHaveCount(1);
  await save().click(); await expect(cards).toHaveCount(0); await expect(page.getByText('团队成果与个人库已一致，暂无需要存入的内容。')).toBeVisible();
  await page.getByRole('tab', { name: '个人', exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.getByRole('button', { name: '删除成果', exact: true })).toBeVisible();
  await expect(cards.locator('.result-card-details')).toHaveCount(0);
  await cards.getByRole('checkbox').check(); await expect(cards.locator('.result-card-details')).toHaveCount(0);
  await cards.getByRole('checkbox').uncheck();
  await cards.locator('.content-card-summary').click();
  await page.getByRole('button', { name: '删除成果', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /删除/ }).click();
  await expect(cards).toHaveCount(0);
  await page.getByRole('tab', { name: '团队', exact: true }).click(); await expect(cards).toHaveCount(1);
  await save().click(); await expect(cards).toHaveCount(0);
  await call('test.archivePersonal'); await expect(cards).toHaveCount(0);
  await call('test.deletePersonal'); await expect(cards).toHaveCount(1); // Live state broadcast without a tab switch.
  await save().click(); await expect(cards).toHaveCount(0);
  await call('test.editPersonal'); await expect(cards).toHaveCount(1); await expect(cards).toContainText('个人内容不同');
  await save().click(); await expect(cards).toHaveCount(0);
  const copies = await call('test.personal'); expect(copies).toHaveLength(2); expect(copies.some(c => c.content === '这是我的独立补充分析。')).toBe(true);
  await call('test.remoteUpdate'); await refresh(); await expect(cards).toHaveCount(1); await expect(cards).toContainText('团队版本有变化');
  await save().click(); await expect(cards).toHaveCount(0); expect(await call('test.personal')).toHaveLength(2);
  await mount({ admin: true, username: 'alice' }); await expect(cards).toHaveCount(0);
  await page.getByRole('checkbox', { name: '包含个人库已有成果', exact: true }).check(); await expect(cards).toHaveCount(1); await expect(save()).toBeDisabled();
  await page.screenshot({ path: path.join(data, 'admin-maintenance.png') });
  await page.getByRole('checkbox', { name: '包含个人库已有成果', exact: true }).uncheck(); await expect(cards).toHaveCount(0);
  await mount({ admin: false, username: 'alice', resultId: 'shared-result' }); await expect(page.getByRole('heading', { name: '【项目结论】 验证过的团队结论' })).toBeVisible();
  await expect(page.getByRole('button', { name: '个人库已有此版本', exact: true })).toBeDisabled();
  await call('test.remoteDelete'); await refresh(); await expect(page.getByText('这条成果已删除或被合并', { exact: false })).toBeVisible();
  expect(await call('test.personal')).toHaveLength(2);
  await mount({ admin: false, username: 'alice' }); await expect(cards).toHaveCount(0);
  await call('test.deletePersonal'); await expect(cards).toHaveCount(0); expect(await call('test.personal')).toHaveLength(1);
  await call('test.remoteRestore'); await refresh(); await expect(cards).toHaveCount(1);
  await call('test.pauseImport'); await save().click(); await expect(save()).toHaveText('正在存入…');
  await mount({ admin: false, username: 'bob' }); await expect(save()).toBeEnabled();
  await call('test.resumeImport'); await expect(cards).toHaveCount(0);
  await mount({ admin: false, username: 'alice' });
  await call('test.legacyPublication'); await refresh(); await expect(cards).toHaveCount(0);
  expect((await call('test.personal'))[0].sources[0].kind).toBe('session');
  await call('test.deletePersonal'); await expect(cards).toHaveCount(1);
  await call('test.roleCatalog'); await refresh();
  // Both roles see every sharing state, and labels come from actual titles.
  for (const admin of [false, true]) {
    await mount({admin, username:'alice'});
    await expect(cards).toHaveCount(6); await expect(page.getByLabel('团队成果数量')).toHaveText('共 6 条');
    await cards.nth(0).locator('.result-card-toggle').click(); await expect(cards.locator('.result-card-details')).toHaveCount(1);
    await cards.nth(1).locator('.result-card-toggle').click(); await expect(cards.locator('.result-card-details')).toHaveCount(1);
    await expect(cards.nth(0).locator('.result-card-toggle')).toHaveAttribute('aria-expanded', 'false');
    await cards.nth(1).locator('.result-card-toggle').click(); await expect(cards.locator('.result-card-details')).toHaveCount(0);
    await expect(page.getByLabel('团队成果操作状态')).toHaveCount(0);
    await expect(page.locator('.content-cards')).not.toContainText('待整理');
    await expect(page.locator('.content-cards')).not.toContainText('已整理');
    const tags = page.getByLabel('团队成果类别');
    await expect(tags).toContainText('【综合整理】（1）');
    await expect(tags).toContainText('【项目标准】（2）');
    await tags.selectOption('label:项目标准'); await expect(cards).toHaveCount(2);
    await expect(page.getByLabel('团队成果数量')).toHaveText('显示 2 / 共 6 条');
    await page.getByRole('button', {name:'批量删除团队成果',exact:true}).click();
    await cards.first().getByRole('checkbox').check();
    await expect(page.getByRole('button', {name:'删除选中的 1 项',exact:true})).toBeEnabled();
    await tags.selectOption('label:方法探索'); await expect(cards).toHaveCount(1);
    await expect(page.getByRole('button', {name:'删除选中的 0 项',exact:true})).toBeDisabled();
    await page.getByRole('button', {name:'取消批量删除',exact:true}).click();
    await tags.selectOption('label:综合整理'); await expect(cards).toHaveCount(1); await expect(cards).toContainText('【综合整理】 跨方案结论');
    await tags.selectOption('untagged'); await expect(cards).toHaveCount(1); await expect(cards).toContainText('没有标签的成果');
    await page.getByRole('button', {name:'清除筛选',exact:true}).click(); await expect(cards).toHaveCount(6);
    await page.screenshot({path:path.join(data, admin ? 'admin-labels.png' : 'member-labels.png')});
  }
  const help = page.locator('.team-results-help-body');
  await expect(help).toBeHidden(); await page.locator('.team-results-help summary').click(); await expect(help).toBeVisible();
  await page.locator('.team-results-help summary').press('Escape'); await expect(help).toBeHidden();
  await page.getByLabel('团队成果类别').selectOption('label:项目标准');
  await page.getByRole('button', {name:'多选语义合并',exact:true}).click();
  await cards.getByRole('checkbox').nth(0).check(); await cards.getByRole('checkbox').nth(1).check();
  await expect(page.getByLabel('语义合并设置')).toContainText('已选择 2 条文字成果');
  await page.getByLabel('团队成果类别').selectOption('label:综合整理');
  await expect(page.getByLabel('语义合并设置')).toContainText('已选择 0 条文字成果');
  await page.getByRole('button', {name:'退出多选',exact:true}).click();
  await cards.getByRole('button', {name:'编辑成果',exact:true}).click();
  await page.getByLabel('团队成果标题').fill('【自定义验证】 标签来自标题');
  await page.getByRole('button', {name:'保存修改',exact:true}).click();
  await expect(page.getByLabel('团队成果类别')).toContainText('【自定义验证】（1）');
  await expect(page.getByLabel('团队成果类别')).toHaveValue('label:综合整理');
  await expect(cards).toHaveCount(0); // Keep the chosen filter after its last result changes labels.
  await page.getByRole('button', {name:'清除筛选',exact:true}).click();
  await page.getByLabel('团队成果类别').selectOption('label:自定义验证'); await expect(cards).toHaveCount(1);
  await expect(cards).toContainText('【自定义验证】 标签来自标题');
  await page.getByLabel('搜索团队成果').fill('不存在的内容'); await expect(cards).toHaveCount(0);
  await expect(page.getByLabel('团队成果类别')).toHaveValue('label:自定义验证');
  await page.getByRole('button', {name:'清除筛选',exact:true}).click(); await expect(cards).toHaveCount(6);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ passed: true, data, cases: ['failed and successful import', 'personal deletion and live reappearance', 'history still retained', 'personal rewrites preserved', 'team revision updates', 'admin maintenance', 'activity detail remains readable', 'remote deletion retains personal copies', 'switching context releases import busy state', 'locally prepared publication hidden until personal copy deleted', 'same six results for member and admin', 'automatic custom, multiple and untagged label filtering for both roles', 'filter changes clear bulk selections', 'label editing and zero-count filters', 'collapsed help opens and closes'] }));
  await call('test.close');
} finally { await app.close(); }
