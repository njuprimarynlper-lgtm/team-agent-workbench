import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const root = process.cwd(), out = path.join(root, 'artifacts', 'result-classification-validation');
await fs.mkdir(out, { recursive: true });
await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
  import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
  import {ProjectResults} from './src/renderer/project-results';
  import {SharedContentLibrary} from './src/renderer/shared-content'; import {ConclusionLibrary} from './src/renderer/conclusions';
  import {DraftEditor} from './src/renderer/draft-editor'; import './src/renderer/styles.css'; import './src/renderer/result-card.css';
  const fixture = window.fixture;
  function App() {
    const [scope,setScope] = useState('team'), [revision,refresh] = useState(0), [admin,setAdmin] = useState(true), [draft,setDraft] = useState(structuredClone(fixture.draft));
    window.refreshDraft = () => setDraft(structuredClone(fixture.draft));
    const [notice,setNotice] = useState(''); const preparing = new URLSearchParams(location.search).has('prepare');
    return <div style={{height:'100vh', overflow:'auto',background:'#f7faf8'}}><header className="preview-app-header"><b>团队工作台 · 实体抽取优化</b><span>本地用例数据</span><button onClick={() => setAdmin(!admin)}>{admin?'切换普通成员':'切换子管理员'}</button></header>{notice&&<p role="status">{notice}</p>}
    {preparing ? <DraftEditor draft={draft} transfers={[]} run={async fn=>{try{return await fn()}catch(error){setNotice(error.message)}}} notice={setNotice} close={()=>setNotice('已关闭整理预览')} reorganized={()=>{}} sourceTitle="词典增强与误报分析" viewShared={()=>{}} viewConclusion={()=>{}}/> :
    <ProjectResults projectName={fixture.project.name} scope={scope} changeScope={setScope}>{scope==='team' ? <SharedContentLibrary key={'team:'+admin} embedded project={fixture.project} username="alice" admin={admin} aliases={{}} aliasSaved={async()=>{}} attach={async()=>{}} attachSessions={[fixture.session]} notice={setNotice} mergeSessions={[fixture.session]} mergeStarted={()=>setNotice('开始整理')}/> : <ConclusionLibrary embedded project={fixture.project} sessions={[fixture.session]} notice={setNotice} mergeStarted={()=>{}} refreshToken={String(revision)}/>}</ProjectResults>}</div>;
  }
  createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, format: 'iife', platform: 'browser', outfile: path.join(out, 'ui.js'), logLevel: 'silent' });
await fs.writeFile(path.join(out, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"><style>body{margin:0}.preview-app-header{height:60px;display:flex;align-items:center;gap:24px;padding:0 30px;border-bottom:1px solid #dae4dc;background:white}.preview-app-header span{margin-left:auto;color:#758879}.draft-editor{max-width:1260px;margin:24px auto}.project-results-page{padding:30px;max-width:1440px;margin:auto}</style></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1540, height: 1050 } });
const errors=[]; page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  const now = '2026-09-30T03:00:00.000Z', project={ id:'project_'+'a'.repeat(32), name:'实体抽取优化', remoteRoot:'/p',uploadPath:'/p/submissions/alice',historyPath:'/p/trajectories/alice' };
  const body={project_goal:'长尾召回达到 88%，整体精确率达到 95%。使用固定验证集 v2。',capability:'已支持离线批处理与词典增强。\n\n验证集 v2 已覆盖；在线接口仍需验证。',exploration:'词典增强提高长尾召回，也增加了误匹配。\n\n验证集 v2：召回从 83.6% 到 86.4%，精确率从 95.8% 到 95.3%。',todo:'补充同名实体样本，并验证误匹配阈值。'};
  const rows=[['project_goal','提高长尾实体识别效果','confirmed'],['capability','离线批处理与词典增强','limited'],['exploration','词典增强的效果与适用范围',undefined],['exploration','误匹配样本复盘',undefined],['todo','补充同名实体样本','in_progress'],['todo','统一验证集版本','completed']];
  const items=rows.map(([category,title,resultStatus],i)=>({ id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),category,title,description:body[category],resultStatus,kind:'contribution',state:'submitted',author:i===2?'bob':'alice',updatedBy:'alice',revision:i===1?3:1,createdAt:now,updatedAt:now,path:'/p/'+i+'.md',sha256:'a'.repeat(64),size:100}));
  const history=[{...items[1],revision:1,description:'单文件离线处理。'},{...items[1],revision:2,description:'新增目录批处理，尚未接入词典增强。'}];
  const personal=items.map(item=>({...item,projectId:project.id,version:item.revision,content:item.description,sources:[],versions:history.filter(entry=>entry.id===item.id).map(entry=>({...entry,version:entry.revision,content:entry.description,sources:[]}))}));
  const session={ id:'00000000-0000-4000-8000-999999999999',title:'词典增强与误报分析',provider:'codex',purpose:'work',messages:[],sources:[],approvals:[],binding:{project,username:'alice'},status:'idle'};
  const draft={id:'10000000-0000-4000-8000-000000000001',sessionId:session.id,binding:{project,username:'alice'},title:'检查整理结果',body:'body',files:[],generation:'ready',createdAt:now,snapshot:{capturedAt:now,messageCount:4,conversationHash:'a'.repeat(64)},resultRules:{contract:4,categories:['project_goal','capability','exploration','todo']},artifacts:[{id:'a1',category:'capability',title:'离线评测支持词典增强',body:body.capability,selected:true,fields:{},target:'/p/capabilities',updateTarget:{scope:'personal',projectId:project.id,id:items[1].id,version:3}},{id:'a2',category:'exploration',title:'词典增强改善召回但引入误匹配',body:body.exploration,selected:true,fields:{},target:'/p/explorations'},{id:'a3',category:'todo',title:'补充重名样本并验证阈值',body:body.todo,selected:true,fields:{},target:'/p/todos'}]};
  window.fixture={project,session,draft,items,personal,history};window.calls=[];
  window.workbench={subscribe:()=>()=>{},call:async(action,p={})=>{
    window.calls.push({action,p:structuredClone(p)});
    if(action==='content.list')return structuredClone(items);
    if(action==='content.history')return structuredClone(history);
    if(action==='conclusion.list')return structuredClone(personal);
    if(action==='content.edit') {const item=items.find(item=>item.id===p.change.id);history.push(structuredClone(item));Object.assign(item,p.change,{revision:item.revision+1,updatedAt:now});return structuredClone(item);}
    if(action==='conclusion.save'){const item=personal.find(item=>item.id===p.id);item.versions.push(structuredClone({...item,versions:undefined}));Object.assign(item,p,{version:item.version+1});return structuredClone(item);}
    if(action==='draft.artifact.edit'){Object.assign(draft.artifacts.find(item=>item.id===p.artifactId),p);window.refreshDraft?.();return structuredClone(draft);}
    if(action==='draft.artifactSelection'){draft.artifacts.find(item=>item.id===p.artifactId).selected=p.selected;window.refreshDraft?.();return structuredClone(draft);}
    if(action==='draft.category'){const item=draft.artifacts.find(item=>item.id===p.artifactId);item.category=p.category;item.classificationVersion=(item.classificationVersion||0)+1;delete item.updateTarget;window.refreshDraft?.();return structuredClone(draft);}
    if(action==='draft.supplement'){Object.assign(draft,p);return draft;}
    if(action==='draft.personal.save'||action==='draft.submit')return [];
    if(action==='copy')return;
    throw Error('Unexpected test API '+action);
  }};
});
const url = pathToFileURL(path.join(out, 'index.html')).href, checks=[];
try {
  await page.goto(url);
  await expect(page.getByRole('navigation',{name:'团队成果类别'})).toBeVisible();
  await page.getByRole('navigation',{name:'团队成果类别'}).getByRole('button',{name:/已有能力/}).click();
  await expect(page.locator('.result-card')).toHaveCount(1);
  await page.screenshot({path:path.join(out,'team-capabilities.png')});
  await page.getByRole('button',{name:'历史版本 · 2'}).click();
  await expect(page.getByRole('dialog',{name:'历史版本'})).toBeVisible();
  await page.screenshot({path:path.join(out,'capability-history.png')});
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  checks.push('当前能力只显示当前版本；历史侧栏可打开并用 Escape 关闭');
  await page.getByRole('navigation',{name:'团队成果类别'}).getByRole('button',{name:/待办事项/}).click();
  await expect(page.locator('.result-completed')).toHaveCount(1);await page.screenshot({path:path.join(out,'team-todos.png')});
  await page.getByRole('button',{name:'重新打开',exact:true}).click();await expect(page.locator('.result-completed')).toHaveCount(0);
  checks.push('已完成待办仍显示且可以重新打开');
  await page.evaluate(() => { window.fixture.items[5].linkedAssignments=[{id:'task',title:'验证固定集',status:'pending_review',assignee:'alice'}]; });
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  const linkedTodo = page.locator('.result-card').filter({hasText:'统一验证集版本'});
  await expect(linkedTodo.locator('.result-state-badge')).toHaveText('待验收');
  await expect(linkedTodo.getByRole('button',{name:'标记完成',exact:true})).toHaveCount(0);
  await expect(linkedTodo.getByRole('button',{name:'修改分类',exact:true})).toBeDisabled();
  await page.evaluate(() => { window.fixture.items[5].linkedAssignments[0].status='completed'; });
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(linkedTodo).toHaveClass(/result-completed/);
  checks.push('关联项目任务的待办显示真实验收状态，不能绕过验收直接完成，验收后置灰保留');
  await page.getByRole('navigation',{name:'团队成果类别'}).getByRole('button',{name:'全部',exact:true}).click();
  await page.getByRole('button',{name:'合并整理',exact:true}).click();
  await page.getByRole('checkbox',{name:'选择合并：词典增强的效果与适用范围'}).check();
  await expect(page.getByRole('checkbox',{name:'选择合并：离线批处理与词典增强'})).toBeDisabled();
  await expect(page.getByRole('checkbox',{name:'选择合并：误匹配样本复盘'})).toBeEnabled();
  await expect(page.getByRole('navigation',{name:'团队成果类别'}).getByRole('button',{name:/待办事项/})).toBeDisabled();
  await page.getByRole('button',{name:'退出多选'}).click();
  checks.push('合并选择锁定同一类别，跨分类条目和切换入口禁用');
  await page.getByRole('navigation',{name:'团队成果类别'}).getByRole('button',{name:/探索记录/}).click();
  await page.getByRole('button',{name:'修改分类',exact:true}).first().click();
  await expect(page.getByRole('dialog',{name:'修改分类'})).toBeVisible();await page.screenshot({path:path.join(out,'reclassify.png')});
  await page.getByRole('dialog').getByRole('radio',{name:/待办事项/}).check();await page.getByRole('button',{name:'确认修改',exact:true}).click();
  await expect(page.locator('.result-card')).toHaveCount(1);checks.push('分类修改使用独立窗口，保存后条目移到对应分类');
  await page.getByRole('button',{name:'切换普通成员'}).click();await expect(page.getByRole('button',{name:'合并整理',exact:true})).toHaveCount(0);checks.push('普通成员无法进入团队合并入口');
  await page.getByRole('tab',{name:'个人',exact:true}).click();await page.getByRole('navigation',{name:'个人成果类别'}).getByRole('button',{name:/待办事项/}).click();await expect(page.locator('.result-completed')).toHaveCount(1);checks.push('个人库同样保留完成待办');
  await page.goto(url+'?prepare=1');await expect(page.getByRole('region',{name:'检查整理结果'})).toBeVisible().catch(()=>expect(page.locator('.preparation-review')).toBeVisible());
  await expect(page.getByLabel('已有能力更新目标')).toHaveValue('00000000-0000-4000-8000-000000000002');
  await page.getByLabel('整理成果正文').fill('用户补充：目前只覆盖离线环境。');
  await page.screenshot({path:path.join(out,'preparation-review.png')});
  await page.getByRole('button',{name:'修改分类',exact:true}).click();await page.getByRole('dialog').getByRole('radio',{name:/探索记录/}).check();await page.getByRole('button',{name:'确认修改'}).click();
  await expect(page.getByLabel('整理成果正文')).toHaveValue('用户补充：目前只覆盖离线环境。');await expect(page.getByLabel('已有能力更新目标')).toHaveCount(0);
  checks.push('整理预览支持已有能力更新目标、正文编辑；改类保留人工编辑并清除旧更新目标');
  await page.getByLabel('整理成果正文').fill('改类后补充：还需验证在线接口。');
  await page.getByRole('button',{name:'修改分类',exact:true}).click();await page.getByRole('dialog').getByRole('radio',{name:/已有能力/}).check();await page.getByRole('button',{name:'确认修改'}).click();
  await expect(page.getByLabel('整理成果正文')).toHaveValue('改类后补充：还需验证在线接口。');
  await expect(page.getByLabel('已有能力更新目标')).toHaveValue('');
  checks.push('连续改类并改回原分类，保留最新编辑且不恢复过时的更新目标');
  await page.getByRole('button',{name:'关闭',exact:true}).click();await expect(page.getByText('已关闭整理预览',{exact:true})).toBeVisible();checks.push('整理预览具备明确关闭入口');
  await page.setViewportSize({width:1000,height:760});
  await expect(page.getByRole('button',{name:'关闭',exact:true})).toBeVisible();
  if (await page.locator('.preparation-review').evaluate(element => element.scrollWidth > element.clientWidth + 1)) throw Error('窄窗口整理预览出现横向溢出');
  checks.push('较窄窗口中整理内容没有横向溢出，关闭入口保持可见');
  await page.setViewportSize({width:1540,height:1050});
  await page.evaluate(() => {
    window.fixture.draft = {...window.fixture.draft,id:'10000000-0000-4000-8000-000000000002',artifacts:[],mergeProjectId:window.fixture.project.id,resultCategory:'todo',title:'统一验证集版本',body:'核对验证集版本，保留唯一的执行事项。',mergeSources:window.fixture.items.slice(4,6).map(item=>({id:item.id,revision:item.revision,title:item.title,category:'todo',author:item.author,updatedAt:item.updatedAt}))};
    window.refreshDraft();
  });
  await expect(page.getByRole('button',{name:'提交为团队成果',exact:true})).toBeDisabled();
  await expect(page.getByLabel('合并成果类别')).toBeDisabled();
  await page.getByRole('checkbox',{name:/这些待办是同一事项的重复记录/}).check();
  await expect(page.getByRole('button',{name:'提交为团队成果',exact:true})).toBeEnabled();
  await page.screenshot({path:path.join(out,'todo-merge-preview.png')});
  checks.push('待办合并必须人工确认是重复事项，预览禁止更换合并分类');
  if(errors.length)throw Error(errors.join('\n'));
  await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({checks,errors},null,2));console.log(checks.join('\n'));
} finally { await browser.close(); }
