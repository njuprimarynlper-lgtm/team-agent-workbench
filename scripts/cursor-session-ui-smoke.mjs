// Headless UI + real Workbench + isolated ACP process. No desktop/account changes.
import { chromium, expect as baseExpect } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Workbench } from '../src/core/workbench.ts';
import { grantTestWorkspace, offlineProjectId } from '../tests/fixtures/offline-workspace.ts';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';

const root = process.cwd(), out = path.join(root, '.test-data', 'cursor-session-ui-' + Date.now());
await fs.mkdir(out, { recursive: true });
const thought = { id: 'thinking_budget', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] };
const fixture = await authLauncher(path.join(out, 'cli'), { status: 'ready', turn: 'success', cursorConfigOptions: [thought], cursorModelsResult: { models: [{ value: 'cursor-fixture', name: 'Cursor Fixture', configOptions: [thought] }, { value: 'other-fixture', name: 'Other Fixture' }] } });
let page, session, holdAuth = false, holdModes = false, holdModeSave = false, failModeSave = false;
const pendingAuth = [], pendingModes = [], pendingModeSaves = [], calls = [], errors = [];
const publish = () => { if (page && session) void page.evaluate(value => window.patchSession?.(value), session).catch(() => {}); };
const wb = new Workbench(path.join(out, 'data'), publish, () => {}, undefined, route => ({ HTTPS_PROXY: route === 'management' ? 'http://127.0.0.1:18001' : '' }));
await wb.store.init(); grantTestWorkspace(wb, out); wb.store.settings.providerPaths.cursor = fixture.launcher;
wb.store.settings.egress = { enabled: true, host: '127.0.0.1', port: 443, certificateFingerprint: 'A'.repeat(64) };
session = await wb.createSession('cursor', out, offlineProjectId, 'work', undefined, undefined, 'inherit', false, 'direct');
const source = name => path.join(root, 'src/renderer', name).replaceAll('\\', '/');
await fs.writeFile(path.join(out, 'entry.tsx'), `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{ComposerMode}from'${source('composer-mode')}';import{ComposerSettings}from'${source('composer-settings')}';
import{ComposerCapabilities}from'${source('composer-capabilities')}';
import{ProviderConnectionSettings}from'${source('provider-connection')}';import'${source('styles.css')}';
function App(){const[session,setSession]=useState(window.initialSession),[text,setText]=useState(''),[network,setNetwork]=useState(false),[route,setRoute]=useState('direct'),[busy,setBusy]=useState(false);window.patchSession=setSession;
const auth={status:'authenticated',detail:'已登录',cwd:session.cwd,networkRoute:session.networkRoute,checkedAt:''};
return <main style={{maxWidth:900,margin:'0 auto',padding:24,height:'100vh',display:'flex',flexDirection:'column'}}><h2>Cursor 会话切换验证</h2><p role="status">会话状态：{session.status}</p><div style={{flex:1,minHeight:0,overflow:'auto'}}>{session.messages.map((m,i)=><p key={i}>{m.userText||m.text}</p>)}</div><div className="composer"><textarea aria-label="任务输入" value={text} onChange={e=>setText(e.target.value)}/><div className="composer-bottom"><ComposerCapabilities session={session} selected={[]} change={()=>{}} text={text} changeText={setText}/><ComposerMode session={session}/><ComposerSettings session={session} openConnection={()=>{setRoute(session.networkRoute);setNetwork(true)}}/><button onClick={()=>{void window.workbench.call('session.send',{id:session.id,text}).catch(()=>{});setText('')}}>发送</button></div></div>{network&&<section aria-label="会话网络面板" style={{position:'fixed',top:60,left:160,right:160,maxHeight:700,overflow:'auto',padding:24,background:'white',zIndex:30,border:'1px solid #ddd'}}><ProviderConnectionSettings provider="cursor" cwd={session.cwd} auth={auth} egress={{enabled:true,hasAccessCode:true,configured:true,running:true,available:true,detail:'管理端连接已保存'}} sessionId={session.id} sessionRoute={route} savedRoute={session.networkRoute} routeChanged={setRoute} activeTaskCount={1} busyChanged={setBusy}/><button disabled={busy} onClick={()=>setNetwork(false)}>返回会话</button></section>}</main>}
createRoot(document.getElementById('root')).render(<App/>);`);
await build({ entryPoints: [path.join(out, 'entry.tsx')], bundle: true, outfile: path.join(out, 'ui.js'), jsx: 'automatic', platform: 'browser', target: 'chrome120' });
await fs.writeFile(path.join(out, 'index.html'), '<html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><div id="root"></div><script src="ui.js"></script></html>');
const browser = await chromium.launch({ channel: 'msedge', headless: true }), expect = baseExpect.configure({ timeout: 15000 });
try {
  page = await browser.newPage({ viewport: { width: 1100, height: 850 } }); page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('backend', async (action, p) => {
    calls.push(action);
    try {
      if (action === 'session.capabilities') return await wb.capabilities(p.id, p.forceRefresh, p.kind);
      if (action === 'session.modes') { if (holdModes) await new Promise(resolve => pendingModes.push(resolve)); return await wb.modes(p.id); }
      if (action === 'session.mode') { if (holdModeSave) await new Promise(resolve => pendingModeSaves.push(resolve)); if (failModeSave) throw Error('fixture mode save failed'); return await wb.changeMode(p.id, p.mode); }
      if (action === 'session.model') return await wb.changeModel(p.id, p.model);
      if (action === 'session.reasoningEffort') return await wb.changeReasoningEffort(p.id, p.effort);
      if (action === 'session.permissions') return await wb.changePermissions(p.id, p.mode);
      if (action === 'session.network') return await wb.changeNetworkRoute(p.id, p.networkRoute);
      if (action === 'session.send') return await wb.send(p.id, p.text);
      if (action === 'provider.catalog') return await wb.catalog('cursor', p.cwd, p.networkRoute);
      if (action === 'provider.permissions') return { warnings: [], approval: 'allowlist' };
      if (action === 'provider.auth') { if (holdAuth) await new Promise(resolve => pendingAuth.push(resolve)); return await wb.accounts.check('cursor', p.cwd, p.networkRoute); }
      if (action === 'egress.test') throw Error('fixture offline probe');
      if (action === 'providers.detect') return [];
      throw Error('Unexpected call: ' + action);
    } finally { publish(); }
  });
  await page.addInitScript(initial => { window.initialSession = initial; window.workbench = { call: (action, p) => window.backend(action, p) }; }, session);
  await page.goto(pathToFileURL(path.join(out, 'index.html')).href);
  const input = page.getByLabel('任务输入'), mode = page.getByLabel('选择对话模式', { exact: true });
  // Typing a built-in command must not initialize Cursor to discover Skills.
  const modeDialog = page.getByRole('dialog', { name: '对话模式', exact: true });
  for (const command of ['plan', 'ask', 'agent']) {
    await input.fill('/'); await expect(page.getByRole('dialog', { name: '添加内容或工具', exact: true })).toBeVisible();
    await input.pressSequentially(command, { delay: 40 });
    assert.equal(calls.includes('session.capabilities'), false, 'built-in modes must not start Skill discovery');
    await input.press('Enter');
    await expect(mode).toContainText(command === 'agent' ? 'Agent' : command === 'plan' ? 'Plan' : 'Ask');
    await expect(input).toHaveValue('');
  }
  // Reading/saving is dismissible; failures stay in this menu and preserve the draft.
  await input.fill('Keep this unsent draft');
  const originalUrl = page.url();
  holdModes = true;
  await mode.click(); await expect(modeDialog).toContainText('读取模式…');
  await mode.click(); await expect(modeDialog).toHaveCount(0);
  await mode.click(); await page.keyboard.press('Escape'); await expect(modeDialog).toHaveCount(0);
  holdModes = false; pendingModes.splice(0).forEach(resolve => resolve());
  await mode.click(); await expect(modeDialog.getByRole('button', { name: /Plan/ })).toBeEnabled();
  failModeSave = true;
  await modeDialog.getByRole('button', { name: /Plan/ }).click();
  await expect(modeDialog.getByRole('alert')).toContainText('fixture mode save failed');
  await expect(mode).toContainText('Agent'); await expect(input).toHaveValue('Keep this unsent draft');
  failModeSave = false; holdModeSave = true;
  await modeDialog.getByRole('button', { name: /Plan/ }).click();
  await expect(modeDialog).toContainText('正在切换为 Plan…');
  await expect(modeDialog).not.toContainText('读取模式…');
  await modeDialog.getByRole('button', { name: '关闭模式选项', exact: true }).click();
  await expect(modeDialog).toHaveCount(0);
  holdModeSave = false; pendingModeSaves.splice(0).forEach(resolve => resolve());
  await expect(mode).toContainText('Plan');
  assert.equal(page.url(), originalUrl); assert.equal(session.messages.length, 0);
  await expect(input).toHaveValue('Keep this unsent draft');
  for (const label of ['Plan', 'Ask', 'Agent']) {
    await mode.click(); await page.getByRole('dialog', { name: '对话模式', exact: true }).getByRole('button', { name: new RegExp(label) }).click();
    await expect(mode).toContainText(label); await expect(input).toHaveValue('Keep this unsent draft');
  }
  assert.equal(session.nativeId, undefined); assert.equal(calls.includes('provider.auth'), false);
  await page.getByLabel('选择模型', { exact: true }).click();
  await page.getByRole('group', { name: '可用模型' }).getByRole('button').first().click();
  await page.getByLabel('选择模型', { exact: true }).click();
  await page.getByRole('group', { name: '思考努力程度' }).getByRole('button', { name: '高', exact: true }).click();
  await expect(page.getByLabel('选择模型', { exact: true })).toContainText('高');
  assert.equal(session.reasoningEffort, 'high');
  await page.getByLabel('选择模型', { exact: true }).click();
  await expect(page.getByRole('group', { name: '思考努力程度' }).getByRole('button', { name: '高', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: path.join(out, 'cursor-reasoning.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('会话状态：idle', { exact: true })).toBeVisible();
  await expect.poll(() => session.messages.filter(m => m.role === 'assistant').length).toBe(1);
  const nativeId = session.nativeId;
  const rpcCalls = (await fs.readFile(path.join(out, 'cli', 'rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert(rpcCalls.some(call => call.method === 'session/set_config_option' && call.params.configId === 'thinking_budget' && call.params.value === 'high'));
  // An unresponsive account lookup must not stop switching or returning to chat.
  holdAuth = true;
  await page.getByLabel('网络与登录设置').click();
  const network = page.getByRole('region', { name: '会话网络面板' });
  await network.getByLabel('通过管理端访问模型服务', { exact: true }).check();
  const catalogCalls = calls.filter(c => c === 'provider.catalog').length;
  await network.getByRole('button', { name: '应用连接方式', exact: true }).click();
  await expect(network).toContainText('已保存：管理端出口，从下一轮生效。');
  await expect(network.getByRole('button', { name: '返回会话', exact: true })).toBeEnabled();
  assert.equal(calls.filter(c => c === 'provider.catalog').length, catalogCalls);
  assert.equal(calls.includes('egress.configure'), false, 'saved connection should be reused even while another task runs');
  await network.getByLabel('通过管理端访问模型服务', { exact: true }).uncheck();
  await network.getByRole('button', { name: '应用连接方式', exact: true }).click();
  await expect(network).toContainText('已保存：本机网络，从下一轮生效。');
  await network.getByRole('button', { name: '返回会话', exact: true }).click();
  holdAuth = false; pendingAuth.splice(0).forEach(resolve => resolve());
  await input.fill('Continue after route switch'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => session.messages.filter(m => m.role === 'assistant').length).toBe(2);
  assert.equal(session.nativeId, nativeId); assert.equal(session.networkRoute, 'direct');
  // A failed metadata startup used to disable all settings indefinitely.
  await wb.changeModel(session.id, 'other-fixture');
  assert.equal(session.reasoningEffort, undefined);
  await page.getByLabel('选择模型', { exact: true }).click();
  await expect(page.getByRole('group', { name: '思考努力程度' })).toContainText('当前模型没有可选的思考强度');
  await page.keyboard.press('Escape');
  await fixture.write({ status: 'ready', turn: 'success', rpcErrors: { authenticate: 'fixture startup failure' } });
  await assert.rejects(wb.capabilities(session.id, true, 'skill'), /fixture startup failure/); publish();
  await expect(mode).toBeEnabled(); await mode.click();
  await page.getByRole('dialog', { name: '对话模式', exact: true }).getByRole('button', { name: /Plan/ }).click();
  await fixture.write({ status: 'ready', turn: 'success' });
  await input.fill('Recovered after startup failure'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => session.messages.filter(m => m.role === 'assistant').length).toBe(3);
  await expect(mode).toContainText('Plan'); await expect(mode).toBeEnabled();
  await page.screenshot({ path: path.join(out, 'cursor-settings.png') }); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['Agent/Plan/Ask', 'local slash modes without CLI startup', 'dismiss slow mode read/save', 'mode save failure preserves view and draft', 'model selection', 'Cursor thinking selection and native parameter submission', 'unsupported model clears old thinking choice', 'direct/management/direct during slow auth', 'saved connection reuse', 'same session resumed', 'startup failure recovery'], screenshot: path.join(out, 'cursor-settings.png') }));
} finally { holdAuth = holdModes = holdModeSave = false; [...pendingAuth.splice(0), ...pendingModes.splice(0), ...pendingModeSaves.splice(0)].forEach(resolve => resolve()); await browser.close(); page = undefined; await wb.close(); }
