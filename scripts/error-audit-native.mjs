// Launch only a synthetic native error dialog, never the user's workbench.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url), root = process.cwd();
const phase = process.argv.find(a => a.startsWith('--phase='))?.slice(8) || 'after';
const id = process.argv.find(a => a.startsWith('--case='))?.slice(7) || 'user-start';
const source = phase === 'before' ? path.join(root, '.test-data/error-audit/baseline') : root;
const temp = path.join(root, '.test-data/error-audit/native-' + id + '-' + phase); await fs.mkdir(temp, { recursive: true });
const raw = '本地会话资料无法读取：C:/audit/sessions.json\nError: EIO: read failed';
const file = path.join(source, id === 'admin-start' ? 'src/admin/main.ts' : 'src/main/index.ts');
const text = await fs.readFile(file, 'utf8');
let body;
if (id === 'close-save' && phase === 'before') {
  body = /dialog\.showErrorBox\('未保存的编辑',[^;]+;/.exec(text)?.[0];
  if (!body) throw Error('Production close failure dialog not found');
} else if (phase === 'before') {
  const title = id === 'admin-start' ? '管理员版启动失败' : '工作台启动失败';
  body = new RegExp(`dialog\\.showErrorBox\\('${title}',[^;]+;`).exec(text)?.[0];
  if (!body) throw Error('Production startup dialog not found');
} else body = id === 'close-save' ? `await showRecordSaveFailure(${JSON.stringify(temp)});` : id === 'logs-open-failure' ? `const real=dialog.showMessageBox.bind(dialog);let calls=0;dialog.showMessageBox=(...args)=>++calls===1?Promise.resolve({response:1}):real(...args);const fsp=await import('node:fs/promises');fsp.default.lstat=async()=>{throw Object.assign(Error('EACCES: isolated log directory denied'),{code:'EACCES'});};await showStartupFailure('工作台启动失败',error,${JSON.stringify(temp)});` : `await showStartupFailure(${JSON.stringify(id === 'admin-start' ? '管理员版启动失败' : '工作台启动失败')},error,${JSON.stringify(temp)});`;
const prelude = phase === 'after' ? `import{showStartupFailure,showRecordSaveFailure}from${JSON.stringify(path.join(source, 'src/main/startup-failure.ts').replaceAll('\\', '/'))};` : '';
await build({ stdin: { contents: `import{app,dialog,BrowserWindow}from'electron';${prelude}const error=new Error(${JSON.stringify(raw)});const errorMessage=e=>e.message;app.whenReady().then(async()=>{const host=new BrowserWindow({width:640,height:400,title:'报错隔离验证'});await host.loadURL('data:text/html,<title>报错隔离验证</title><h2>Native error audit</h2>');console.log('Native audit dialog ready');${body}host.destroy();app.quit();});`, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(temp, 'main.cjs'), logLevel: 'silent' });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(temp, 'main.cjs')], { env, stdio: 'inherit', windowsHide: true });
await new Promise((resolve, reject) => { child.once('exit', code => code ? reject(Error('Native fixture exit ' + code)) : resolve()); child.once('error', reject); });
console.log(JSON.stringify({ id: 'native-' + id, phase, pass: true, fixture: 'production native dialog code with synthetic local IO error' }));
