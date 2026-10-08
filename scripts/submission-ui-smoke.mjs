import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const root = process.cwd(), out = path.join(root, 'artifacts', 'submission-ui-validation');
await fs.mkdir(out, { recursive: true });
await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
  import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
  import {DraftEditor} from './src/renderer/draft-editor'; import {TransferRecords} from './src/renderer/transfer-records';
  import {ContentUpdatesPanel} from './src/renderer/content-updates'; import {SharedContentLibrary} from './src/renderer/shared-content';
  import {ConclusionLibrary} from './src/renderer/conclusions'; import './src/renderer/styles.css'; import './src/renderer/result-card.css';
  function App(){const [revision,refresh]=useState(0);window.refresh=()=>refresh(value=>value+1);const f=window.fixture;
    const mode=new URLSearchParams(location.search).get('mode');
    const run=async fn=>fn(), notice=()=>{};
    return <div style={{overflow:'auto',height:'100vh',padding:30,background:'#f7faf8'}}><h1>团队工作台 · {f.project.name}</h1>
      {mode==='review'?<DraftEditor draft={f.draft} sourceTitle={f.draft.sourceSessionTitle} sourceSession={f.session} projects={f.projects} transfers={[]} run={run} notice={notice} close={()=>{}} reorganized={()=>{}} viewShared={()=>{}} viewConclusion={()=>{}}/>:
       mode==='activity'?<ContentUpdatesPanel updates={f.updates} aliases={{}} view={()=>{}} changed={async()=>{}}/>:
       mode==='shared'?<SharedContentLibrary project={f.project} username="bob" admin={false} aliases={{}} aliasSaved={async()=>{}} attach={async()=>{}} notice={notice} mergeSessions={[]} mergeStarted={()=>{}} attachSessions={[]}/>:
       mode==='personal'?<ConclusionLibrary project={f.project} projects={f.projects} sessions={[]} notice={notice} mergeStarted={()=>{}}/>:
       <><h2>传输记录</h2><TransferRecords transfers={f.transfers} retry={id=>window.calls.push({action:'transfer.retry',id})}/></>}
    </div>;
  }createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, format: 'iife', platform: 'browser', outfile: path.join(out, 'ui.js'), logLevel: 'silent' });
await fs.writeFile(path.join(out,'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } }), errors=[], checks=[];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  const now = '2026-10-08T01:00:00.000Z', project = { id:'project_competition',name:'优化项目',groupName:'competition',groupLabel:'竞赛组',remoteRoot:'/competition/project',uploadPath:'/competition/project/submissions/bob',historyPath:'/competition/project/trajectories/bob' };
  const other = {...project,id:'project_ocr',groupName:'ocr',groupLabel:'OCR组',remoteRoot:'/ocr/project',uploadPath:'/ocr/project/submissions/bob',historyPath:'/ocr/project/trajectories/bob'};
  const binding={connectionId:'server',host:'server.internal',port:22,username:'bob',fingerprint:'SHA256:fixture',project};
  const record={version:1,submittedBy:'bob',submittedAt:now,destination:{projectId:project.id,projectName:project.name,groupName:project.groupName,groupLabel:project.groupLabel},sources:[{kind:'session',id:'private-session',title:'量化误差分析',capturedAt:now,snapshotHash:'a'.repeat(64)}]};
  const content={id:'00000000-0000-4000-8000-000000000001',title:'误差评估',description:'在固定验证集上，词典增强提高了长尾召回；同名样本仍需补充。',kind:'contribution',category:'exploration',author:'bob',updatedBy:'alice',revision:2,state:'curated',createdAt:now,updatedAt:now,sha256:'a'.repeat(64),size:100,path:project.remoteRoot+'/curated/report.md',submission:record};
  const transfer={id:'transfer-1',kind:'upload',name:'generated-internal-name.zip',metadata:{...content,title:'误差评估'},submission:record,binding,target:project.uploadPath+'/hidden-target.zip',status:'done',bytes:100,total:100,createdAt:now,projectName:project.name};
  const update={eventId:'event-1',projectId:project.id,projectName:project.name,id:content.id,title:content.title,author:content.author,updatedBy:'alice',revision:2,change:'updated',occurredAt:now,detectedAt:now,category:'exploration',submission:record};
  const session={id:'session-1',title:'后来更名的会话',provider:'codex',purpose:'work',messages:[],sources:[],approvals:[],binding,status:'idle'};
  const draft={id:'draft-1',sessionId:session.id,sourceSessionTitle:'量化误差分析',binding,title:'整理草稿',body:'',files:[],generation:'ready',createdAt:now,preparationVersion:3,snapshot:{capturedAt:now,messageCount:4,conversationHash:'a'.repeat(64)},resultRules:{contract:4,categories:['exploration']},artifacts:[{id:'result-1',category:'exploration',title:'误差评估',fields:{},body:'观察依据',target:project.uploadPath+'/explorations',selected:true}]};
  const personal={...content,submission:undefined,projectId:project.id,version:3,content:content.description,sources:[],derivedFrom:[],versions:[]};
  window.fixture={project,projects:[project,other],other,record,content,items:[content],personal:[personal],session,draft,transfer,transfers:[transfer],update,updates:[update]};window.calls=[];
  window.workbench={subscribe:()=>()=>{},call:async(action,p={})=>{
    window.calls.push({action,p:structuredClone(p)});
    if(action==='content.list')return structuredClone(window.fixture.items);
    if(action==='content.history')return [];
    if(action==='conclusion.list')return structuredClone(window.fixture.personal);
    if(action==='conclusion.publish')return {id:'upload'};
    if(action==='draft.submit'){window.fixture.draft.submitted='upload';window.refresh();return {id:'upload'};}
    if(action==='draft.supplement')return window.fixture.draft;
    throw Error('Unexpected fixture API '+action);
  }};
});
const url = pathToFileURL(path.join(out,'index.html')).href;
try {
  await page.goto(url+'?mode=review');
  await expect(page.getByRole('button',{name:'提交到 竞赛组 / 优化项目',exact:true})).toBeVisible();
  await expect(page.locator('.preparation-source')).toContainText('量化误差分析');
  await expect(page.locator('.preparation-source')).not.toContainText('后来更名');
  await page.screenshot({path:path.join(out,'upload-review.png')});
  await page.getByRole('button',{name:'提交到 竞赛组 / 优化项目',exact:true}).click();
  expect(await page.evaluate(()=>window.calls.filter(call=>call.action==='draft.submit').map(call=>call.p.id))).toEqual(['draft-1']);
  checks.push('上传按钮直接显示项目，同名项目用工作组区分；来源只显示冻结时的会话名');

  await page.goto(url+'?mode=transfers');
  await expect(page.getByText('上传 · 误差评估',{exact:true})).toBeVisible();
  await expect(page.getByText('提交人',{exact:true})).not.toBeVisible();
  await expect(page.getByText('/competition/project/submissions/bob/hidden-target.zip',{exact:true})).not.toBeVisible();
  await expect(page.getByText('generated-internal-name.zip',{exact:false})).toHaveCount(0);
  await page.screenshot({path:path.join(out,'transfer-collapsed.png')});
  await page.getByText('查看详情',{exact:true}).click();
  await expect(page.getByText('会话“量化误差分析” · 整理时的对话快照',{exact:true})).toBeVisible();
  await expect(page.getByText('竞赛组 / 优化项目',{exact:true})).toBeVisible();
  checks.push('单项目传输默认显示成果和状态；账号、快照来源和远端位置仅展开后可见');
  await page.evaluate(()=>{const f=window.fixture;const binding={...f.transfer.binding,project:f.other};const record={...f.record,destination:{projectId:f.other.id,projectName:f.other.name,groupName:f.other.groupName,groupLabel:f.other.groupLabel},sources:[{kind:'personal_result',title:'同名样本复盘',version:3}]};f.transfers.push({...f.transfer,id:'transfer-2',metadata:{title:'同名样本复盘'},submission:record,binding,status:'error',error:'连接中断，可重试',target:f.other.uploadPath+'/report.zip'});window.refresh();});
  await expect(page.getByText('OCR组 / 优化项目',{exact:true}).first()).toBeVisible();
  await page.getByRole('button',{name:'重试',exact:true}).click();
  expect(await page.evaluate(()=>window.calls.find(call=>call.action==='transfer.retry').id)).toBe('transfer-2');
  checks.push('跨组聚合记录显示对应项目；重试绑定原记录，不跟随当前页面项目');

  await page.goto(url+'?mode=activity');
  await expect(page.getByRole('heading',{name:'alice 更新了《误差评估》',exact:true})).toBeVisible();
  await expect(page.getByText('来源',{exact:true})).not.toBeVisible();
  await page.screenshot({path:path.join(out,'activity-collapsed.png')});
  await page.getByText('来源与历史',{exact:true}).click();
  await expect(page.locator('.submission-details')).toContainText('bob');
  await expect(page.locator('.submission-details')).toContainText('最近维护');
  await expect(page.locator('.submission-details')).toContainText('alice');
  checks.push('动态默认用“谁做了什么”表达；展开区分原提交人和管理员维护人');
  await page.evaluate(()=>{const f=window.fixture;f.updates.push({...f.update,eventId:'event-2',projectId:f.other.id,submission:{...f.record,destination:{projectId:f.other.id,projectName:f.other.name,groupName:f.other.groupName,groupLabel:f.other.groupLabel}}});window.refresh();});
  await expect(page.locator('.update-entry').last()).toContainText('OCR组 / 优化项目');
  checks.push('跨项目动态显示项目，同名项目继续区分工作组');

  await page.goto(url+'?mode=shared');
  await page.getByRole('navigation',{name:'团队成果类别'}).getByRole('button',{name:/探索记录/}).click();
  await page.locator('.result-card-toggle').click();
  await expect(page.getByText('提交人',{exact:true})).not.toBeVisible();
  await page.getByText('来源与历史',{exact:true}).click();
  await expect(page.locator('.submission-details')).toContainText('量化误差分析');
  await expect(page.locator('.submission-details')).toContainText('竞赛组 / 优化项目');
  await page.screenshot({path:path.join(out,'shared-origin-expanded.png')});
  checks.push('成果默认保留作者和版本；来源、目标、维护人放在详情，无私人会话跳转');

  await page.goto(url+'?mode=personal');
  await page.getByRole('navigation',{name:'个人成果类别'}).getByRole('button',{name:/探索记录/}).click();
  await page.locator('.result-more > summary').click();
  await page.getByRole('button',{name:'分享至团队',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'提交到 竞赛组 / 优化项目',exact:true}).click();
  expect(await page.evaluate(()=>window.calls.find(call=>call.action==='conclusion.publish').p)).toEqual({id:'00000000-0000-4000-8000-000000000001',version:3,disclose:[]});
  checks.push('个人分享使用同一目标按钮，提交审阅版本，私人祖先来源不默认公开');
  if(errors.length)throw Error(errors.join('\n'));
  await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({checks,errors},null,2));console.log(checks.join('\n'));
} finally { await browser.close(); }
