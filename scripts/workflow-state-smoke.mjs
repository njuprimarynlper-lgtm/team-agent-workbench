import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const expect = baseExpect.configure({ timeout: 10000 });
const root = process.cwd(), data = path.join(root, '.test-data', 'workflow-states-' + Date.now());
await fs.mkdir(data, { recursive: true });
// Render the production components with deferred API replies to reproduce stale results deterministically.
await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { StorageView } from './src/admin/storage-view';
  import { SessionFilesDialog } from './src/renderer/session-files';
  import { ModelPicker } from './src/renderer/model-picker';
  import './src/renderer/styles.css';
  import './src/admin/styles.css';
  const pending = [];
  const call = (action, payload) => new Promise((resolve, reject) => pending.push({ action, payload, resolve, reject, settled: false }));
  window.admin = { call }; window.workbench = { call };
  window.audit = { pending };
  function Harness() {
    const [view, setView] = useState({ kind: 'storage', identity: 'first' }); window.audit.mount = setView;
    return <div style={{ padding: 24 }}>{view.kind === 'storage'
      ? <StorageView active enabled identity={view.identity}/>
      : view.kind === 'files' ? <SessionFilesDialog sessionId={view.id} initialPath={view.path} close={() => {}}/>
      : <ModelPicker provider={view.provider} cwd="D:/test" ready={view.ready} model="" changed={() => {}}/>}</div>;
  }
  createRoot(document.getElementById('root')).render(<Harness/>);
` }, bundle: true, outfile: path.join(data, 'renderer.js'), platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
await fs.writeFile(path.join(data, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>');
await fs.writeFile(path.join(data, 'main.cjs'), "const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{contextIsolation:true}});w.loadFile(require('path').join(__dirname,'index.html'));});app.on('window-all-closed',()=>app.quit());");
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [path.join(data, 'main.cjs')], cwd: root, env });
try {
  const page = await app.firstWindow(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.audit?.mount === 'function');
  const count = async action => page.evaluate(action => window.audit.pending.filter(item => item.action === action).length, action);
  const reply = (action, index, value, error) => page.evaluate(({ action, index, value, error }) => { const item = window.audit.pending.filter(item => item.action === action)[index]; item.settled = true; error ? item.reject(new Error(error)) : item.resolve(value); }, { action, index, value, error });
  const mount = value => page.evaluate(value => window.audit.mount(value), value);
  const report = bytes => ({ scannedAt: new Date().toISOString(), path: '', name: '测试共享区', total: { bytes, files: 1, directories: 0, directBytes: bytes }, volume: { totalBytes: 0, freeBytes: 0 }, categories: [], groups: [], users: [], children: [], childCount: 0, offset: 0, limit: 100, warningCount: 0, warnings: [] });
  await expect.poll(() => count('storage.scan')).toBe(1);
  await mount({ kind: 'storage', identity: 'second' });
  await expect.poll(() => count('storage.scan')).toBe(2);
  await reply('storage.scan', 1, report(2048));
  await expect(page.locator('.primary-stat strong')).toHaveText('2.00 KB');
  await reply('storage.scan', 0, report(1024));
  await expect(page.locator('.primary-stat strong')).toHaveText('2.00 KB');
  await page.getByRole('button', { name: '刷新统计', exact: true }).click();
  await expect.poll(() => count('storage.scan')).toBe(3);
  await mount({ kind: 'storage', identity: 'third' }); await expect.poll(() => count('storage.scan')).toBe(4);
  await reply('storage.scan', 2, undefined, '旧服务器错误');
  await expect(page.getByRole('button', { name: '取消统计', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await reply('storage.scan', 3, report(3072)); await expect(page.locator('.primary-stat strong')).toHaveText('3.00 KB');
  await page.screenshot({ path: path.join(data, 'storage-current-result.png') });

  await mount({ kind: 'files', id: 'a', path: 'D:/a.txt' }); await expect.poll(() => count('session.file.preview')).toBe(1);
  await mount({ kind: 'files', id: 'b', path: 'D:/b.txt' }); await expect.poll(() => count('session.file.preview')).toBe(2);
  const preview = name => ({ path: 'D:/' + name, name, type: 'text', content: name + ' 的内容', size: 10, truncated: false });
  await reply('session.file.preview', 1, preview('b.txt')); await expect(page.locator('.session-file-path')).toHaveText('D:/b.txt');
  await reply('session.file.preview', 0, preview('a.txt')); await expect(page.locator('.session-file-path')).toHaveText('D:/b.txt');
  await mount({ kind: 'files', id: 'c', path: 'D:/missing.txt' }); await expect.poll(() => count('session.file.preview')).toBe(3);
  await expect(page.getByRole('button', { name: '用系统应用打开', exact: true })).toHaveCount(0);
  await reply('session.file.preview', 2, undefined, '文件已不存在'); await expect(page.getByRole('alert')).toContainText('文件已不存在');
  await expect(page.locator('.session-file-path')).toHaveCount(0);
  await expect(page.getByText('尚未找到文件记录。', { exact: false })).toHaveCount(0);
  await page.screenshot({ path: path.join(data, 'file-unavailable.png') });

  await mount({ kind: 'models', provider: 'codex', ready: true }); await expect.poll(() => count('provider.catalog')).toBe(1);
  await mount({ kind: 'models', provider: 'cursor', ready: false });
  await expect(page.getByRole('button', { name: '刷新模型与额度', exact: true })).toBeDisabled();
  await reply('provider.catalog', 0, { models: [{ id: 'old', name: '旧账号模型' }], quota: { windows: [{ name: '旧账号', usedPercent: 10 }], detail: '', url: '' }, checkedAt: new Date().toISOString() });
  await expect(page.getByLabel('模型与额度')).not.toContainText('旧账号');
  await mount({ kind: 'models', provider: 'cursor', ready: true }); await expect.poll(() => count('provider.catalog')).toBe(2);
  await reply('provider.catalog', 1, { models: [{ id: 'new', name: '当前账号模型' }], quota: { windows: [], detail: '当前账号未提供额度', url: '' }, checkedAt: new Date().toISOString() });
  await expect(page.getByLabel('会话模型', { exact: true })).toContainText('当前账号模型');
  await expect(page.getByRole('button', { name: '刷新模型与额度', exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(data, 'model-current-account.png') });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ passed: true, data, cases: ['storage identity late success and failure', 'file selection late response and missing file', 'model account loading reset and stale quota rejection'] }));
} finally { await app.close(); }
