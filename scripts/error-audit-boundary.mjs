import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
const root = process.cwd(), option = key => process.argv.find(a => a.startsWith('--' + key + '='))?.slice(key.length + 3);
const phase = option('phase') || 'after', source = path.resolve(option('source') || root);
const only = option('only')?.split(',');
assert(['before', 'after'].includes(phase));
if (phase === 'before') assert.equal(source, path.join(root, '.test-data/error-audit/baseline'));
const temp = path.join(root, '.test-data/error-audit/boundary-' + phase), shots = path.join(root, 'docs/error-audit/screenshots');
await fs.mkdir(temp, { recursive: true }); await fs.mkdir(shots, { recursive: true });
await fs.writeFile(path.join(temp,'index.html'),'<html><meta charset="UTF-8"><body><div id="root"></div></body></html>');
const { errorMessage } = await import(pathToFileURL(path.join(source, 'src/shared/errors.ts')));
const { preparationErrorMessage } = await import(pathToFileURL(path.join(source, 'src/shared/preparation-error.ts')));
const { publicFailure } = phase === 'after' ? await import(pathToFileURL(path.join(source, 'src/main/public-failures.ts'))) : {};
const definitions = [
  ['boundary-ssh-auth', '连接中央节点', 'SSH拒绝账号验证', 'All configured authentication methods failed', 'connect', '账号和密码'],
  ['boundary-central-refused', '连接中央节点', 'SSH端口拒绝连接', 'connect ECONNREFUSED 192.0.2.1:22', 'connect', '连接中央节点时被拒绝'],
  ['boundary-central-dns', '连接中央节点', '服务器域名解析失败', 'getaddrinfo ENOTFOUND audit.invalid', 'connect', '服务器地址'],
  ['boundary-central-timeout', '连接中央节点', 'SSH握手响应超时，尚不能确定原因', 'Timed out while waiting for handshake', 'connect', '还没连上'],
  ['boundary-reset', '连接中央节点', '登录验证过程中连接中断，需重新核对连接状态', 'socket hang up ECONNRESET', 'remote.connect', '连接中央节点时断开了'],
  ['boundary-password', '首次登录中央节点', '服务器要求先修改初始密码', 'PASSWORD_CHANGE_REQUIRED：首次登录，请设置新密码', 'remote.connect', '设置新密码'],
  ['boundary-unknown', '连接中央节点', '登录过程中出现未分类底层异常，不猜测原因', 'TypeError: unexpected response\n at receive (C:/internal/rpc.ts:22:1)', 'remote.connect', '重试连接'],
  ['boundary-prep-count', '查看成果整理失败', 'AI返回超过本次允许数量的成果，不能误说网络问题', '本次整理超过 5 项，请重新精简整理', 'preparation', '超过 5 项'],
  ['boundary-prep-category', '查看成果整理失败', 'AI返回用户未选择的类别', 'AI 返回了未选择的“项目经验”，请重试整理。', 'preparation', '未选'],
  ['boundary-prep-timeout', '查看成果整理失败', 'CLI初始化超时，此次整理尚未开始，不应断言网络中断或登录过期', 'initialize timeout', 'preparation', '开始'],
];
const imp = file => JSON.stringify(path.join(source, file).replaceAll('\\', '/'));
const exposeModal={name:'expose-production-connection-modal',setup(b){b.onLoad({filter:/[\\/]renderer[\\/]main\.tsx$/},async args=>{let text=await fs.readFile(args.path,'utf8');assert(text.includes('function ConnectModal('));text=text.replace('function ConnectModal(', 'export function ConnectModal(').replace(/^createRoot\(document\.getElementById\('root'\)!\)\.render\(<App\/>\);/m,'');return{contents:text,loader:'tsx'};});}};
await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{ConnectModal}from ${imp('src/renderer/main.tsx')};import{DraftEditor}from ${imp('src/renderer/draft-editor.tsx')};import ${imp('src/renderer/styles.css')};const f=window.fixture;createRoot(document.getElementById('root')).render(f.preparation?<DraftEditor draft={{id:'audit-draft',sessionId:'audit-session',title:'本轮成果整理',generation:'error',generationError:f.message,body:'',files:[],createdAt:'2026-11-16T08:00:00Z',inputDir:'C:/audit',outputPath:'C:/audit/output.md'}} transfers={[]} run={async fn=>await fn()} notice={()=>{}} close={()=>{}} reorganized={()=>{}} viewShared={()=>{}} viewConclusion={()=>{}}/>:<ConnectModal settings={{connections:[],providerPaths:{},trustedServerIdentities:{}}} connections={[]} connection={undefined} fresh={true} nodeOnly={true} close={()=>{window.closedFixture=true}} run={async fn=>await fn()} onConnected={()=>{}}/>);`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(temp, 'ui.js'), loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, plugins:[exposeModal], logLevel: 'silent' });
const browser = await chromium.launch({ channel: 'msedge', headless: true }); const rows = [];
try { for (const [id, entry, condition, raw, action, expected] of definitions) {
  if (only && !only.some(pattern => pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : id === pattern)) continue;
  const page = await browser.newPage({ viewport: { width: 1150, height: 850 }, deviceScaleFactor: 1 });
  const failure = phase === 'after' && action !== 'preparation' ? publicFailure(Error(raw), action) : undefined, message = action === 'preparation' ? preparationErrorMessage(Error(raw)) : failure?.message || errorMessage(Error(raw));
  await page.goto(pathToFileURL(path.join(temp,'index.html')).href); await page.addStyleTag({ path: path.join(temp, 'ui.css') });
  await page.evaluate(fixture => { window.fixture = fixture; window.workbench={call:async(action)=>{if(action==='remote.connect'){if(fixture.failure) {window.postMessage({type:'workbench:failure',failure:fixture.failure},'*');throw{message:fixture.failure.message,code:fixture.failure.code,failure:fixture.failure}}throw Error(fixture.raw);} if(action==='logs.query')return{items:[],coverage:{}};if(action==='logs.status')return{diagnostic:{},workflow:{},traces:{}};return[];},subscribe:()=>()=>{}}; }, { entry, message, raw, failure, preparation: action === 'preparation' }); await page.addScriptTag({ path: path.join(temp, 'ui.js') });
  if(action!=='preparation'){await page.getByLabel('中央节点地址',{exact:true}).fill('audit.invalid');await page.getByLabel('成员账号',{exact:true}).fill('audit_user');await page.getByLabel('登录密码',{exact:true}).fill('fixture-only-password');await page.getByRole('button',{name:'连接并查看项目',exact:true}).click();}
  await page.getByRole('alert').first().waitFor(); const ui = await page.locator('body').innerText();
  if (phase === 'after') { assert(ui.includes(id==='boundary-password'?'首次登录，请先设置新密码':expected), id + ': ' + ui); assert(!/ECONN|ENOSPC|TypeError|PASSWORD_CHANGE_REQUIRED|internal\/rpc/.test(ui)); }
  await assert.doesNotReject(()=>page.getByRole('alert').first().scrollIntoViewIfNeeded());
  const screenshot = `screenshots/${id}-${phase}.png`; await page.screenshot({ path: path.join(root, 'docs/error-audit', screenshot), fullPage: true });
  rows.push({ id, phase, entry, condition, source: action === 'preparation' ? 'src/shared/preparation-error.ts → src/renderer/draft-editor.tsx' : 'src/main/index.ts → src/main/public-failures.ts → src/renderer/main.tsx#ConnectModal', raw, message, ui, screenshot, pass: true, capture: 'production-react-component', fixture: action === 'preparation' ? 'synthetic error, actual preparation formatter and production DraftEditor; viewport 1150×850, full-page capture' : 'synthetic error through actual boundary formatter and production ConnectModal; actual form entry and click, viewport 1150×850, full-page capture' }); await page.close();
} } finally { await browser.close(); }
const file = path.join(root, 'docs/error-audit/boundary-scenarios.json'), existing = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '[]'));
await fs.writeFile(file, JSON.stringify([...existing.filter(e => !(e.phase === phase && rows.some(row => row.id === e.id))), ...rows], null, 2));
console.log(JSON.stringify({ phase, passed: rows.length }));
