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
  import {ProjectResults} from './src/renderer/project-results';
  function App(){const [revision,refresh]=useState(0);window.refresh=()=>refresh(value=>value+1);const f=window.fixture;
    const mode=new URLSearchParams(location.search).get('mode');
    const run=async fn=>fn(), notice=()=>{};
    return <div style={{overflow:'auto',height:'100vh',padding:30,background:'#f7faf8',display:'flex',flexDirection:'column'}}><h1>团队工作台 · {f.project.name}</h1>
      {mode==='review'?<DraftEditor draft={f.draft} sourceTitle={f.draft.sourceSessionTitle} sourceSession={f.session} projects={f.projects} transfers={[]} run={run} notice={notice} close={()=>{}} reorganized={()=>{}} viewShared={()=>{}} viewConclusion={()=>{}}/>:
       mode==='activity'?<ContentUpdatesPanel updates={f.updates} aliases={{}} view={()=>{}} changed={async()=>{}}/>:
       mode==='shared'?<ProjectResults projectName={f.project.name} scope="team" changeScope={()=>{}}><SharedContentLibrary embedded project={f.project} username="bob" admin={false} aliases={{}} aliasSaved={async()=>{}} attach={async()=>{}} notice={notice} mergeSessions={[]} mergeStarted={()=>{}} attachSessions={[]}/></ProjectResults>:
       mode==='personal'?<ProjectResults projectName={f.project.name} scope="personal" changeScope={()=>{}}><ConclusionLibrary embedded project={f.project} projects={f.projects} sessions={[]} notice={notice} mergeStarted={()=>{}} refreshToken={String(revision)} focusId={f.focusId} focusHandled={()=>{f.focusId=undefined;window.refresh();}}/></ProjectResults>:
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
    if(action==='conclusion.list')return structuredClone(window.fixture.personal.filter(item=>item.projectId===p.projectId));
    if(action==='conclusion.publish'){window.fixture.personal[0].uploadState={status:'queued',transferId:'upload'};window.refresh();return {id:'upload'};}
    if(action==='conclusion.alias.save'){const item=window.fixture.personal.find(value=>value.id===p.id);item.titleAlias=p.alias;const result=structuredClone(item);delete result.uploadState;return result;}
    if(action==='conclusion.archive'){const item=window.fixture.personal.find(value=>value.id===p.id);item.archived=p.archived;return structuredClone(item);}
    if(action==='conclusion.create'){const item={id:'created-result',projectId:p.projectId,title:p.title,content:p.content,category:p.category,resultStatus:p.resultStatus,version:1,updatedAt:now,sources:[]};window.fixture.personal.push(item);return structuredClone(item);}
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
  const more = page.locator('.result-more > summary').first();
  const openMore = async () => { if (!await more.evaluate(node => node.parentElement.open)) await more.click(); };
  const publishCalls = () => page.evaluate(() => window.calls.filter(call => call.action === 'conclusion.publish').length);
  const checkMoreStyle = async (width, mode) => {
    await page.setViewportSize({width,height:980});
    await page.mouse.move(0,0);
    await page.waitForTimeout(180);
    const styles = await page.locator('.result-card-actions').first().evaluate(node => {
      const read = element => { const style = getComputedStyle(element);return {fontSize:style.fontSize,fontFamily:style.fontFamily,lineHeight:style.lineHeight,padding:style.padding,border:style.border,borderRadius:style.borderRadius,backgroundColor:style.backgroundColor,height:element.getBoundingClientRect().height,y:element.getBoundingClientRect().y}; };
      const button=node.querySelector(':scope > button.secondary') || node.querySelector(':scope > button');
      return {more:read(node.querySelector(':scope > details > summary')),button:read(button),secondary:button.classList.contains('secondary')};
    });
    await fs.writeFile(path.join(out,`more-style-${mode}-${width}.json`),JSON.stringify(styles,null,2));
    for (const key of ['fontSize','fontFamily','lineHeight','padding','borderRadius',...(styles.secondary?['border','backgroundColor']:[])]) expect(styles.more[key],key).toBe(styles.button[key]);
    expect(Math.abs(styles.more.height-styles.button.height)).toBeLessThan(1);
    expect(Math.abs(styles.more.y-styles.button.y)).toBeLessThan(1);
  };
  await openMore();
  await expect(page.getByRole('button',{name:'等待上传',exact:true})).toBeDisabled();
  const once = await publishCalls();
  await page.getByRole('button',{name:'等待上传',exact:true}).evaluate(node=>node.click());
  expect(await publishCalls()).toBe(once);
  checks.push('确认上传后立即显示置灰的等待上传按钮，重复点击不再提交');
  for(const status of ['running','done']) {
    await page.evaluate(status=>{window.fixture.personal[0].uploadState={status,transferId:'upload'};window.refresh();},status);
    await openMore();
    await expect(page.getByRole('button',{name:status==='done'?'已上传':'上传中',exact:true})).toBeDisabled();
  }
  await checkMoreStyle(1440,'personal');
  await checkMoreStyle(900,'personal');
  await page.setViewportSize({width:1440,height:980});
  await page.screenshot({path:path.join(out,'personal-uploaded.png')});
  checks.push('上传中与已上传均不可重复提交；更多与相邻按钮的字号、间距、边框和高度一致');
  await page.getByRole('button',{name:'设置本地别名',exact:true}).click();
  await page.getByRole('dialog').locator('input').fill('仅自己看的别名');
  await page.getByRole('dialog').getByRole('button',{name:'保存本地别名',exact:true}).click();
  await openMore();
  await expect(page.getByRole('button',{name:'已上传',exact:true})).toBeDisabled();
  checks.push('设置本地别名后仍为已上传，不会误开放再次上传');
  await page.evaluate(()=>{window.fixture.personal[0].uploadState={status:'error',transferId:'upload'};window.refresh();});
  await openMore();
  await expect(page.getByRole('button',{name:'重试上传',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'重试上传',exact:true}).click();
  await openMore();
  await expect(page.getByRole('button',{name:'等待上传',exact:true})).toBeDisabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await publishCalls()).toBe(once+1);
  checks.push('失败保留重试入口，重试原成果后立即置灰，无需新建分享确认');
  await page.evaluate(()=>{window.fixture.personal[0].version++;window.fixture.personal[0].uploadState={status:'ready'};window.refresh();});
  await openMore();
  await expect(page.getByRole('button',{name:'分享至团队',exact:true})).toBeEnabled();
  checks.push('新版本允许分享');
  await page.evaluate(()=>{
    const f=window.fixture,base=f.personal[0];
    f.personal.push(
      {...base,id:'history-result',title:'历史探索资料',titleAlias:undefined,archived:true},
      {...base,id:'superseded-result',title:'被替代的探索资料',titleAlias:undefined,archived:true,supersededBy:{scope:'personal',projectId:f.project.id,id:base.id,version:base.version}},
      {...base,id:'completed-todo',title:'已完成的验证任务',titleAlias:undefined,category:'todo',resultStatus:'completed'},
      {...base,id:'other-project-result',projectId:f.other.id,title:'OCR 当前资料',titleAlias:undefined}
    );window.refresh();
  });
  const range=page.getByRole('combobox',{name:'成果范围',exact:true});
  const card=id=>page.locator(`[data-result-id="${id}"]`);
  await page.getByRole('navigation',{name:'个人成果类别'}).getByRole('button',{name:'全部',exact:true}).click();
  await expect(range).toHaveValue('current');
  await expect(page.locator('.result-card')).toHaveCount(2);
  await expect(card('completed-todo')).toHaveClass(/result-completed/);
  await expect(card('history-result')).toHaveCount(0);
  await range.selectOption('all');
  await expect(page.locator('.result-card')).toHaveCount(4);
  await expect(card('history-result')).toContainText('历史成果');
  await range.selectOption('history');
  await expect(page.locator('.result-card')).toHaveCount(2);
  await expect(card('completed-todo')).toHaveCount(0);
  await expect(card('history-result').getByRole('button',{name:'恢复使用',exact:true})).toBeVisible();
  await expect(card('superseded-result')).toContainText('已由新成果替代');
  await expect(page.getByRole('navigation',{name:'个人成果类别'}).getByRole('button',{name:/探索记录/}).locator('span')).toHaveText('2');
  checks.push('成果范围默认当前；全部包含当前和历史；历史仅显示已移入历史的成果，已完成待办仍属当前');
  await page.getByRole('navigation',{name:'个人成果类别'}).getByRole('button',{name:/探索记录/}).click();
  await page.getByRole('textbox',{name:'搜索个人成果',exact:true}).fill('历史探索资料');
  await expect(page.locator('.result-card')).toHaveCount(1);
  await page.getByRole('textbox',{name:'搜索个人成果',exact:true}).fill('');
  await page.getByRole('navigation',{name:'个人成果类别'}).getByRole('button',{name:'全部',exact:true}).click();
  await page.getByRole('button',{name:'批量删除成果',exact:true}).click();
  await page.getByRole('checkbox',{name:'选择删除成果：历史探索资料',exact:true}).check();
  await range.selectOption('current');
  await expect(page.locator('.result-card-selection input:checked')).toHaveCount(0);
  await page.getByRole('button',{name:'取消多选',exact:true}).click();
  await card('00000000-0000-4000-8000-000000000001').locator('.result-card-selection input').check();
  await range.selectOption('history');
  await expect(page.locator('.semantic-merge-bar')).toHaveCount(0);
  checks.push('范围与搜索、类别筛选组合生效；切换范围清空删除和合并多选');
  await card('history-result').getByRole('button',{name:'恢复使用',exact:true}).click();
  await expect(card('history-result')).toHaveCount(0);
  await expect(page.locator('.result-card')).toHaveCount(1);
  await range.selectOption('current');
  await expect(card('history-result')).toBeVisible();
  await card('history-result').getByRole('button',{name:'移入历史',exact:true}).click();
  await expect(card('history-result')).toHaveCount(0);
  await range.selectOption('history');
  await expect(card('history-result')).toBeVisible();
  checks.push('恢复使用后移出历史列表；移入历史后移出当前列表');
  await range.selectOption('current');
  await page.evaluate(()=>{window.fixture.focusId='history-result';window.refresh();});
  await expect(range).toHaveValue('history');
  await expect(card('history-result').locator('.result-card-details')).toBeVisible();
  await page.evaluate(()=>{window.fixture.project=window.fixture.other;window.refresh();});
  await expect(range).toHaveValue('current');
  await expect(card('other-project-result')).toBeVisible();
  await expect(card('history-result')).toHaveCount(0);
  await range.selectOption('history');
  await expect(page.getByRole('heading',{name:'暂无历史成果',exact:true})).toBeVisible();
  await page.evaluate(()=>{window.fixture.project=window.fixture.projects[0];window.refresh();});
  await expect(range).toHaveValue('current');
  checks.push('从外部定位历史成果会自动显示并展开；切换项目恢复当前范围，空历史列表提示准确');
  await range.selectOption('history');
  await page.getByRole('button',{name:'新建成果',exact:true}).click();
  await expect(range).toHaveValue('current');
  await expect(range).toBeDisabled();
  await page.getByRole('combobox',{name:'成果类别',exact:true}).selectOption('exploration');
  await page.getByRole('textbox',{name:'项目成果标题',exact:true}).fill('新增成果');
  await page.getByRole('textbox',{name:'项目成果内容',exact:true}).fill('本次新的探索观察。');
  await page.getByRole('button',{name:'保存成果',exact:true}).click();
  await expect(card('created-result')).toBeVisible();
  await expect(range).toBeEnabled();
  checks.push('历史范围中新建成果会切回当前；编辑期间禁止切换，保存后新成果可见');
  await range.selectOption('all');
  await page.setViewportSize({width:900,height:980});
  await expect(range).toBeVisible();
  await expect(range).toHaveValue('all');
  await page.screenshot({path:path.join(out,'personal-result-ranges.png')});
  checks.push('较窄窗口中成果范围仍然可见可用');
  await page.goto(url+'?mode=shared');
  await page.getByRole('navigation',{name:'团队成果类别'}).getByRole('button',{name:/探索记录/}).click();
  await checkMoreStyle(1440,'team');
  await checkMoreStyle(900,'team');
  await page.screenshot({path:path.join(out,'team-more.png')});
  checks.push('团队成果的更多使用相同按钮样式，在宽窄窗口都与相邻操作对齐');
  if(errors.length)throw Error(errors.join('\n'));
  await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({checks,errors},null,2));console.log(checks.join('\n'));
} finally { await browser.close(); }
