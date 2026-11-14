// Production renderer with synthetic IPC: no model, server, or personal data calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { makeFixture } from './handbook-ui-fixture.mjs';
import { adjustableFontSizes } from './font-size-css.mjs';

const out = await fs.mkdtemp(path.resolve('.test-data/side-composer-ui-'));
const data = makeFixture('side-composer', 4, 1, { actor: 'Bob', screen: '工作会话', status: '就绪' }, 'answered');
data.snapshot.selectedProjectId = data.project.id;
data.session.model = 'gpt-6.1-sol';
const child = { ...structuredClone(data.session), id: 'child-session', title: '比较结果的边界条件', parentId: data.session.id, messages: [], sources: [], fork: { parentId: data.session.id, nativeFork: true, workspaceKind: 'shared-directory' } };
const sideSession = { ...structuredClone(data.session), id: 'side-session', title: '侧边提问', sources: [], messages: [] };
data.snapshot.sessions.push(child);
data.snapshot.sideChats = [{ id: 'side-chat', parentId: data.session.id, parentTitle: data.session.title, projectId: data.project.id, capturedAt: data.at, session: sideSession, draft: '' }];
const modulePath = file => JSON.stringify(path.resolve(file).replaceAll('\\', '/'));
await fs.writeFile(path.join(out, 'entry.tsx'), `
import { installFixture } from ${modulePath('scripts/handbook-ui-fixture.mjs')};
const data = ${JSON.stringify(data)}; installFixture(data);
const base = window.workbench.call, subscribe = window.workbench.subscribe, listeners = [];
window.workbench.subscribe = listener => { listeners.push(listener); const remove = subscribe(listener); return () => { listeners.splice(listeners.indexOf(listener), 1); remove(); }; };
const emit = () => listeners.forEach(listener => listener({ type: 'state' })); window.__emit = emit;
window.__calls = []; window.__failNext = false;
const target = id => data.snapshot.sessions.find(s => s.id === id) || data.snapshot.sideChats.find(c => c.session.id === id)?.session;
const capabilities = { provider: 'codex', checkedAt: data.at, skills: [{ id: 'skill:caveman', kind: 'skill', name: 'Caveman', invocation: 'caveman', description: '精简表达，保留关键事实与完整代码', path: 'C:/skills/caveman/SKILL.md', enabled: true, source: '个人' }], plugins: [{ id: 'plugin:github', kind: 'plugin', name: 'GitHub', invocation: 'github', description: '查看仓库、Issue 与提交', enabled: true, path: 'plugin://github' }] };
window.workbench.call = async (raw, p = {}) => {
 const action = raw.replace(/^personal:/, ''); window.__calls.push({action,p:structuredClone(p)});
 if(action === 'session.capabilities') return structuredClone(capabilities);
 if(action === 'session.completion.read' || action === 'session.input.flush') return true;
 if(action === 'provider.catalog') return { models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', reasoningEfforts: [{ id: 'medium', name: '中' }, { id: 'high', name: '高' }], defaultReasoningEffort: 'medium' }, { id: 'other', name: '禁止切换的模型' }], quota: { windows: [] }, checkedAt: data.at };
 if(action === 'session.modes') return { current: target(p.id).mode || 'default', modes: [{ id: 'default', name: 'Agent', description: '执行任务' }, { id: 'plan', name: 'Plan', description: '制定计划' }] };
 if(action === 'session.mode' || action === 'session.permissions' || action === 'session.reasoningEffort') { target(p.id)[action === 'session.mode' ? 'mode' : action === 'session.permissions' ? 'permissionMode' : 'reasoningEffort'] = p.mode || p.effort; emit(); return true; }
 if(action === 'session.mcp') return { servers: [{ name: 'docs', title: '项目文档', state: 'connected', enabled: true, tools: [{name:'search',description:'检索文档'}], source: '个人配置' }] };
 if(action === 'session.input') { const chat = data.snapshot.sideChats.find(c => c.session.id === p.id); if(chat) { chat.input = structuredClone(p.input); chat.draft = p.input.text; chat.pendingReferences = { sourceIds: p.input.sourceIds, capabilities: p.input.capabilities }; } else data.snapshot.inputs[p.id] = structuredClone(p.input); return true; }
 if(action === 'session.attachLocal') { const file = { id: crypto.randomUUID(), name: '对照记录.md', localPath: 'D:/work/对照记录.md', sourcePath: 'local-path:D:/work/对照记录.md', sha256: '', size: 0, fetchedAt: data.at, referenceKind: 'local-path' }; target(p.id).sources.push(file); emit(); return [file]; }
 if(action === 'session.resultCandidates') return { items: [{ reference: { scope: p.scope, projectId: data.project.id, id: 'result-one', version: 1 }, title: '统一验证基线', content: '两种格式通过正确性验证。', author: 'Bob', category: 'verification', updatedAt: data.at, attachments: [] }], directories: [], available: true, cached: true };
 if(action === 'session.attachResults') { const ref = p.references[0]; target(p.id).sources.push({id:crypto.randomUUID(),name:'统一验证基线 · v1',localPath:'D:/fixture/result.md',sourcePath:'local-conclusion:result-one:v1',sha256:'a'.repeat(64),size:100,fetchedAt:data.at,resultLink:{reference:ref,attachments:[]}}); emit(); return {added:[{reference:ref}],failed:[]}; }
 if(action === 'session.source.preview') return {name:'对照记录.md',path:'D:/work/对照记录.md',type:'text',content:'## 对照记录\\n仅用于此侧聊。',size:100};
 if(action === 'session.detachPendingSource') { target(p.id).sources = target(p.id).sources.filter(s => s.id !== p.sourceId); emit(); return {sourceIds:[p.sourceId]}; }
 if(action === 'sidechat.send') { if(window.__failNext) { window.__failNext=false; return new Promise((_,reject) => window.__rejectSide=() => reject(Error('模拟发送失败'))); } window.__sent=structuredClone(p); return true; }
 if(action === 'session.enqueue') { window.__queued=structuredClone(p); return true; }
 return base(raw,p);
};
await import(${modulePath('src/renderer/main.tsx')});
`);
await build({ entryPoints: [path.join(out, 'entry.tsx')], outdir: out, entryNames: 'renderer', bundle: true, splitting: true, format: 'esm', platform: 'browser', loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, plugins: [{ name: 'production-font-size', setup(api) { api.onLoad({ filter: /\.css$/ }, async args => args.path.startsWith(path.resolve('src') + path.sep) ? { contents: adjustableFontSizes(await fs.readFile(args.path, 'utf8')), loader: 'css' } : undefined); } }] });
await fs.copyFile('src/renderer/index.html', path.join(out, 'index.html'));
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--allow-file-access-from-files'] });
try {
 const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 1.5 });
 const errors = []; page.on('pageerror', e => errors.push(e.message));
 await page.goto(pathToFileURL(path.join(out, 'index.html')).href);
 await page.getByLabel('任务输入', { exact: true }).waitFor();
 await page.getByLabel('展开侧边提问', { exact: true }).click();
 const side = page.locator('.side-chat-conversation'), input = side.getByLabel('侧边提问输入', { exact: true });
 await expect(side.getByLabel('选择模型', { exact: true })).toHaveCount(0);
 await input.fill('$cav');
 await expect(side.getByRole('dialog', { name: '选择 Skill', exact: true })).toBeVisible();
 await input.press('Enter');
 await expect(side.getByLabel('移除能力：Caveman')).toBeVisible(); await expect(input).toHaveValue('');
 await side.getByLabel('添加内容或工具', { exact: true }).click(); await side.getByRole('menuitem', { name: '插件', exact: true }).click();
 await side.getByRole('option', { name: /GitHub/ }).click();
 await expect(side.getByLabel('移除能力：GitHub')).toBeVisible();
 await side.getByLabel('添加内容或工具', { exact: true }).click(); await side.getByRole('menuitem', { name: '本地文件', exact: true }).click();
 await expect(side.getByLabel('查看参考资料：对照记录.md', { exact: true })).toBeVisible();
 await side.getByLabel('添加内容或工具', { exact: true }).click(); await side.getByRole('menuitem', { name: '项目成果', exact: true }).click();
 const results = page.getByRole('dialog', { name: '关联成果', exact: true }); await expect(results).toBeVisible();
 await results.getByRole('checkbox').first().check(); await results.getByRole('button', { name: '关联 1 项成果', exact: true }).click();
 await expect(results).toHaveCount(0);
 await side.getByLabel('添加内容或工具', { exact: true }).click(); await side.getByRole('menuitem', { name: 'MCP 工具', exact: true }).click();
 await expect(page.getByRole('dialog', { name: 'MCP 服务器' }).getByText('项目文档', { exact: true })).toBeVisible();
 await page.getByLabel('关闭 MCP', { exact: true }).click();
 await side.getByLabel('调整思考强度', { exact: true }).click();
 await expect(side.getByRole('group', { name: '可用模型', exact: true })).toHaveCount(0);
 await side.getByRole('group', { name: '思考努力程度' }).getByRole('button', { name: '高', exact: true }).click();
 await side.getByLabel('选择对话模式', { exact: true }).click(); await side.getByRole('button', { name: /Plan.*制定计划/ }).click();
 await input.fill('请结合验证基线解释这组结果，保留关键依据。');
 await page.screenshot({ path: path.join(out, 'side-composer.png'), clip: { x: 860, y: 600, width: 580, height: 325 } });
 await side.getByLabel('添加内容或工具', { exact: true }).click();
 await page.screenshot({ path: path.join(out, 'side-tools.png') });
 await page.keyboard.press('Escape');
 await side.getByLabel('当前执行权限', { exact: true }).click();
 await side.getByRole('group', { name: '权限选项' }).getByRole('button').nth(1).click();
 await side.getByRole('button', { name: '发送任务', exact: true }).click();
 const sent = await page.evaluate(() => window.__sent);
 assert.equal(sent.id, 'side-chat'); assert.deepEqual(sent.references.capabilities.map(c => c.id), ['skill:caveman','plugin:github']); assert.equal(sent.references.sourceIds.length,1);
 await expect(input).toHaveValue(''); await expect(side.getByLabel('下一条消息使用的能力', { exact: true })).toHaveCount(0);
 await page.getByLabel('任务输入', { exact: true }).fill('主会话草稿保留');
 await input.fill('/plan'); await input.press('Enter');
 await expect(input).toHaveValue('');
 await input.fill('失败时的侧聊草稿');
 await side.getByLabel('添加内容或工具', { exact: true }).click(); await side.getByRole('menuitem', { name: 'Skills', exact: true }).click(); await side.getByRole('option', {name:/Caveman/}).click();
 await page.evaluate(() => window.__failNext = true); await side.getByRole('button', {name:'发送任务',exact:true}).click();
 await expect.poll(() => page.evaluate(() => !!window.__rejectSide)).toBe(true);
 await input.fill('失败前继续编辑的新草稿'); await page.evaluate(() => window.__rejectSide());
 await expect(side.getByRole('alert').first()).toContainText('模拟发送失败'); await expect(input).toHaveValue('失败前继续编辑的新草稿');
 await side.getByRole('button', {name:'恢复未发送消息到输入框',exact:true}).click(); await expect(input).toHaveValue('失败前继续编辑的新草稿');
 await input.fill(''); await side.getByRole('button', {name:'恢复未发送消息到输入框',exact:true}).click();
 await expect(input).toHaveValue('失败时的侧聊草稿'); await expect(side.getByLabel('移除能力：Caveman')).toBeVisible();
 await page.getByRole('tab', {name:'子会话',exact:true}).click();
 await page.getByLabel('展开会话菜单：'+data.session.title,{exact:true}).click();
 await page.locator('.session-row[data-session-id="child-session"]').click();
 const childPanel=page.locator('.subsession-chat:not(.side-chat-conversation)'), childInput=childPanel.getByLabel('子会话输入',{exact:true});
 await childInput.fill('$cav'); await childInput.press('Enter'); await expect(childPanel.getByLabel('移除能力：Caveman')).toBeVisible();
 await expect(childPanel.getByLabel('选择模型',{exact:true})).toHaveCount(0);
 await childInput.fill('进一步检查大输入时的边界条件。');
 await page.screenshot({path:path.join(out,'child-composer.png'),clip:{x:860,y:600,width:580,height:325}});
 await childPanel.getByLabel('添加内容或工具',{exact:true}).click(); await page.screenshot({path:path.join(out,'child-tools.png')}); await page.keyboard.press('Escape');
 await page.getByRole('tab',{name:'侧边提问',exact:true}).click(); await expect(input).toHaveValue('失败时的侧聊草稿'); await expect(side.getByLabel('移除能力：Caveman')).toBeVisible();
 await expect(page.getByLabel('任务输入',{exact:true})).toHaveValue('主会话草稿保留');
 await page.evaluate(() => { const data=window.__handbook.data; data.snapshot.sideChats[0].session.status='running'; data.snapshot.activeTurns={'side-session':'side-turn'}; window.__emit(); });
 await input.fill('运行中排队，继续使用 Caveman'); await side.getByRole('button',{name:'加入队列',exact:true}).click();
 const queued=await page.evaluate(()=>window.__queued); assert.equal(queued.id,'side-session'); assert.equal(queued.capabilities[0].id,'skill:caveman');
 const calls=await page.evaluate(()=>window.__calls); assert.equal(calls.filter(c=>c.action==='session.model').length,0); assert(calls.some(c=>c.action==='session.reasoningEffort'&&c.p.id==='side-session'&&c.p.effort==='high'));
 await page.setViewportSize({width:1100,height:800}); await page.evaluate(()=>document.documentElement.style.setProperty('--workbench-font-step','3px'));
 await expect(side.getByLabel('添加内容或工具',{exact:true})).toBeVisible();
 if(errors.length)throw Error(errors.join('\n'));
 console.log(JSON.stringify({passed:true,skillsAndPlugins:true,slashCommands:true,localFilesAndResults:true,mcp:true,fixedModel:true,effortAndPermissions:true,independentDrafts:true,failedSendRecovery:true,queue:true,screenshots:out}));
} finally { await browser.close(); }
