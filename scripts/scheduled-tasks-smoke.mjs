import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { makeFixture } from './handbook-ui-fixture.mjs';

const out = await fs.mkdtemp(path.resolve('.test-data/scheduled-tasks-ui-'));
const data = makeFixture('case-member-questions', 4, 1, { actor: 'Bob', screen: '工作会话', status: '就绪' }, 'answered');
data.snapshot.selectedProjectId = data.project.id;
const modulePath = file => JSON.stringify(path.resolve(file).replaceAll('\\', '/'));
await fs.writeFile(path.join(out, 'entry.tsx'), `
  import { installFixture } from ${modulePath('scripts/handbook-ui-fixture.mjs')};
  const data = ${JSON.stringify(data)}; installFixture(data);
  const original = window.workbench.call; const tasks = []; const runs = [];
  window.taskCalls = []; window.createdTasks = tasks;
  window.workbench.call = async (raw,p={}) => {
    const action = raw.replace(/^personal:/,''); window.taskCalls.push([action,p]);
    if(action==='scheduledTask.list')return structuredClone(tasks);
    if(action==='scheduledTask.runs')return {items:structuredClone(runs),total:runs.length};
    if(action==='scheduledTask.location')return {cwd:data.directory,followsDirectory:true};
    if(action==='scheduledTask.save') { const task={...p.input,id:crypto.randomUUID(),projectName:data.project.name,cwd:data.directory,sources:[],paused:false,nextRunAt:'2026-11-11T01:00:00Z'}; tasks.push(task); return structuredClone(task); }
    if(action==='scheduledTask.runNow') { const task=tasks.find(t=>t.id===p.id); const run={id:crypto.randomUUID(),taskId:task.id,taskName:task.name,projectId:task.projectId,projectName:task.projectName,sessionId:crypto.randomUUID(),scheduledAt:data.at,createdAt:data.at,status:'completed',summary:'检查完成',manual:true,messageCount:350}; runs.push(run); return structuredClone(run); }
    if(action==='scheduledTask.open') { const run=runs.find(r=>r.id===p.id); return {run,session:{...data.snapshot.sessions[0],id:run.sessionId,status:'idle',approvals:[],messages:Array.from({length:160},(_,i)=>({id:'m'+(190+i),role:'user',text:'任务记录-'+(190+i),createdAt:data.at}))},earlierCount:190}; }
    if(action==='scheduledTask.historyPage') { const before=Math.max(0,p.before-p.limit);return {before,messages:Array.from({length:p.before-before},(_,i)=>({id:'m'+(before+i),role:'user',text:'任务记录-'+(before+i),createdAt:data.at}))}; }
    return original(raw,p);
  };
  await import(${modulePath('src/renderer/main.tsx')});
`);
await build({ entryPoints: [path.join(out, 'entry.tsx')], outdir: out, entryNames: 'renderer', bundle: true, splitting: true, platform: 'browser', format: 'esm', loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } });
await fs.copyFile('src/renderer/index.html', path.join(out, 'index.html'));
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--allow-file-access-from-files'] });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 980 } }); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(pathToFileURL(path.join(out, 'index.html')).href);
  const more=page.getByLabel('更多功能',{exact:true}); await more.click();
  await expect(page.getByRole('menuitem',{name:'传输记录',exact:true})).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('menuitem',{name:'传输记录',exact:true})).toBeHidden();
  await more.click(); await page.getByRole('button',{name:'定时任务',exact:true}).click(); await expect(page.getByRole('menuitem',{name:'成员名片',exact:true})).toBeHidden();
  await page.getByRole('button',{name:'新建定时任务',exact:true}).click();
  const dialog=page.getByRole('dialog'); await expect(dialog.getByRole('button',{name:'下一步',exact:true})).toBeDisabled();
  await dialog.getByLabel('新建定时任务所属项目',{exact:true}).selectOption(data.project.id); await dialog.getByRole('button',{name:'下一步',exact:true}).click();
  await dialog.getByLabel('定时任务名称',{exact:true}).fill('每日项目检查');
  await dialog.getByLabel('定时任务说明',{exact:true}).fill('- 检查项目变化'); await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('定时任务说明',{exact:true})).toBeFocused();
  await dialog.getByLabel('定时任务补充资料',{exact:true}).fill('## 额外要求\n只输出需要处理的问题');
  await expect(dialog.getByText('默认引用项目资料，每次使用最新本地版本',{exact:true})).toBeVisible();
  await expect(dialog.getByText('与 Codex 桌面版同步',{exact:false})).toHaveCount(0);
  await page.screenshot({path:path.join(out,'create-task.png')});
  await dialog.getByRole('button',{name:'保存定时任务',exact:true}).click(); await expect(dialog).toHaveCount(0);
  await expect(page.locator('.scheduled-card h2')).toHaveText('每日项目检查');
  const input=await page.evaluate(()=>window.createdTasks[0]); if(!input.supplement.includes('额外要求')||!input.includeBrief)throw Error('task context not saved');
  await page.getByRole('button',{name:'立即执行',exact:true}).click();
  await page.locator('.scheduled-run-entry').click();
  const messages=page.locator('.scheduled-record-messages'); await expect(messages.locator('article.conversation-message.user')).toHaveCount(160);
  await messages.evaluate(el=>el.scrollTop=0); await messages.hover(); await page.mouse.wheel(0,-700);
  await expect(messages.locator('article.conversation-message.user')).toHaveCount(320);
  await page.getByRole('button',{name:'返回定时任务运行记录',exact:true}).click();
  await page.screenshot({path:path.join(out,'task-history.png')});
  if(errors.length)throw Error(errors.join('\n'));
  console.log('Scheduled task creation, Markdown Tab, overflow dismissal and 160-message archived paging verified.'); console.log(out);
} finally { await browser.close(); }
