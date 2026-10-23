// Actual renderer with local fixtures. No model, account, or central-server traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { makeFixture } from './handbook-ui-fixture.mjs';

const root = process.cwd();
const out = await fs.mkdtemp(path.join(root, '.test-data', 'session-input-queue-'));
const modulePath = file => JSON.stringify(path.join(root, file).replaceAll('\\', '/'));
const data = makeFixture('case-member-questions', 4, 1, { actor: 'Bob', screen: '工作会话', status: '就绪' }, 'answered');
data.snapshot.selectedProjectId = data.project.id;
data.snapshot.sessions[0].status = 'running'; data.snapshot.activeTurns = { [data.session.id]: 'turn-1' };
data.snapshot.inputs[data.session.id] = { text: '', sourceIds: [], answers: {} };
data.snapshot.sessions.push({ ...data.snapshot.sessions[0], id: 'second-session', title: '另一条会话', status: 'idle' });
data.snapshot.inputs['second-session'] = { text: '独立草稿', sourceIds: [], answers: {} };
let app;
try {
  await fs.writeFile(path.join(out, 'entry.tsx'), `
    import { installFixture } from ${modulePath('scripts/handbook-ui-fixture.mjs')};
    const data = ${JSON.stringify(data)}; installFixture(data);
    const original = window.workbench, listeners = [], calls = [];
    const fixture = window.queueFixture = { data, calls, fail: false, delay: false, release: undefined, emit:()=>listeners.forEach(l=>l({type:'state'})),
      complete(){const s=data.snapshot.sessions[0],q=s.inputQueue;if(q?.items.length&&!q.paused){const item=q.items.shift();s.messages.push({id:crypto.randomUUID(),role:'user',text:item.input.text,createdAt:new Date().toISOString()});}this.emit();} };
    window.workbench = {
      subscribe(listener){listeners.push(listener);const off=original.subscribe(listener);return()=>{listeners.splice(listeners.indexOf(listener),1);off();};},
      async call(action,p){action=action.replace(/^personal:/,'');calls.push({action,p});const s=data.snapshot.sessions.find(s=>s.id===p?.id);
        if(action==='session.enqueue'){
          if(fixture.delay)await new Promise(resolve=>{fixture.release=resolve;});
          if(fixture.fail)throw new Error('队列保存失败，输入已保留');
          const q=s.inputQueue||={items:[],paused:false};q.items.push({id:crypto.randomUUID(),input:{text:p.text,sourceIds:p.sourceIds,capabilities:p.capabilities,answers:{}},state:'queued'});fixture.emit();return true;
        }
        if(action.startsWith('session.queue.')){const q=s.inputQueue,item=q.items.find(i=>i.id===p.itemId);
          if(action.endsWith('.pause'))q.paused=true;
          if(action.endsWith('.resume'))q.paused=false;
          if(action.endsWith('.edit'))item.input.text=p.text;
          if(action.endsWith('.remove')||action.endsWith('.steer'))q.items=q.items.filter(i=>i!==item);
          if(action.endsWith('.steer'))s.messages.push({id:crypto.randomUUID(),role:'user',steering:true,text:item.input.text,createdAt:new Date().toISOString()});
          fixture.emit();return true;
        }
        if(action==='session.stop'){s.inputQueue.paused=true;s.status='idle';s.stoppedAt=new Date().toISOString();fixture.emit();return true;}
        return original.call(action,p);
      }
    }; await import(${modulePath('src/renderer/main.tsx')});
  `);
  await build({ entryPoints: [path.join(out, 'entry.tsx')], outdir: out, entryNames: 'renderer', chunkNames: 'chunk-[hash]', bundle: true, splitting: true, platform: 'browser', format: 'esm', target: 'chrome130', loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } });
  await fs.copyFile('src/renderer/index.html', path.join(out, 'index.html'));
  app = await chromium.launch({ channel: 'msedge', headless: true, args: ['--allow-file-access-from-files'] });
  const page = await app.newPage({ viewport: { width: 1300, height: 900 } }), errors = [], requests = [];
  await page.goto(new URL('file:///' + path.join(out, 'index.html').replaceAll('\\', '/')).href);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
  await page.locator(`[data-session-id="${data.session.id}"]`).click();
  const input = page.getByLabel('任务输入', { exact: true }), queue = page.getByRole('region', { name: '待发送消息' });
  const first = '先检查队列是否保持完整内容。'.repeat(30) + '\n第二行仍不能在卡片中换行。';
  for (const text of [first, '把测试范围补充到当前任务', '完成后梳理修改记录']) { await input.fill(text); await input.press('Enter'); await expect(input).toHaveValue(''); }
  await expect(queue.locator('.queue-row')).toHaveCount(3);
  assert.equal(await queue.locator('.queue-text').first().getAttribute('title'), first);
  for (const width of [900, 420, 300]) {
    await queue.evaluate((el, width) => { el.style.width = width + 'px'; el.style.maxWidth = '100%'; }, width);
    const layout = await queue.locator('.queue-row').evaluateAll(rows => rows.map(row => {
      const t=row.querySelector('.queue-text'), c=getComputedStyle(t);
      return {height:row.getBoundingClientRect().height,whiteSpace:c.whiteSpace,ellipsis:c.textOverflow,overflow:c.overflowX,scroll:row.scrollWidth,width:row.clientWidth};
    }));
    for (const row of layout) { assert.equal(row.height,32);assert.equal(row.whiteSpace,'nowrap');assert.equal(row.ellipsis,'ellipsis');assert.equal(row.overflow,'hidden');assert(row.scroll<=row.width+1); }
    if(width===300)await page.screenshot({path:path.join(out,'queue-narrow.png')});
  }
  await queue.evaluate(el=>{el.style.width='';el.style.maxWidth='';});
  await page.screenshot({path:path.join(out,'queue-desktop.png')});
  await queue.getByRole('button',{name:'引导',exact:true}).nth(1).click();await expect(queue.locator('.queue-row')).toHaveCount(2);
  assert.equal(await page.evaluate(()=>window.queueFixture.calls.filter(c=>c.action==='session.queue.steer').length),1);
  await queue.getByRole('button',{name:'编辑第 1 条待发送消息',exact:true}).click();await expect(queue.getByLabel('继续队列')).toBeDisabled();
  await queue.getByLabel('编辑待发送消息').fill('编辑后的第一条');await queue.getByLabel('保存待发送消息').click();await expect(queue.locator('.queue-text').first()).toHaveText('编辑后的第一条');
  await queue.getByLabel('继续队列').click();
  await page.evaluate(()=>window.queueFixture.complete());await expect(queue.locator('.queue-row')).toHaveCount(1);
  await input.fill('保留在下一轮');await input.press('Shift+Enter');await expect(input).toHaveValue('保留在下一轮\n');await expect(queue.locator('.queue-row')).toHaveCount(1);
  await input.press('Enter');await expect(queue.locator('.queue-row')).toHaveCount(2);
  await page.locator('[data-session-id="second-session"]').click();await expect(input).toHaveValue('独立草稿');await expect(queue).toHaveCount(0);
  await page.locator(`[data-session-id="${data.session.id}"]`).click();await expect(queue.locator('.queue-row')).toHaveCount(2);
  await page.getByLabel('停止当前任务',{exact:true}).click();await expect(queue.getByLabel('继续队列')).toBeVisible();
  await page.evaluate(()=>window.queueFixture.complete());await expect(queue.locator('.queue-row')).toHaveCount(2);
  await queue.getByLabel('移除第 2 条待发送消息').click();await expect(queue.locator('.queue-row')).toHaveCount(1);
  await page.evaluate(()=>{window.queueFixture.fail=true;});await input.fill('失败时保留文字');await input.press('Enter');await expect(input).toHaveValue('失败时保留文字');await expect(page.getByText('队列保存失败，输入已保留',{exact:true})).toBeVisible();
  await page.evaluate(()=>{window.queueFixture.fail=false;window.queueFixture.delay=true;});await input.press('Enter');await input.fill('提交期间新写的草稿');await page.evaluate(()=>window.queueFixture.release());await expect(queue.locator('.queue-row')).toHaveCount(2);await expect(input).toHaveValue('提交期间新写的草稿');
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  console.log(JSON.stringify({ok:true,cases:12,screenshots:[path.join(out,'queue-desktop.png'),path.join(out,'queue-narrow.png')]}));
} finally { await app?.close(); }
