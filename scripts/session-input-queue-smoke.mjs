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
data.snapshot.sessions.push({ ...data.snapshot.sessions[0], id: 'child-session', title: '子会话队列测试', parentId: data.session.id, fork: { parentId: data.session.id, capturedAt: new Date().toISOString(), inheritedSourceIds: [], workspaceKind: 'shared-directory' } });
data.snapshot.activeTurns['child-session']='child-turn';
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
        if(action==='session.input.flush')return true;
        if(action==='settings.agent.save'){Object.assign(data.snapshot.settings,p);fixture.emit();return true;}
        if(action==='session.editLast'){
          const index=s.messages.findIndex(m=>m.id===p.messageId);
          if(index<0||s.status!=='idle')throw Error('会话已变化');
          s.messages.splice(index,s.messages.length-index,{id:'native:edited',role:'user',text:p.text,createdAt:new Date().toISOString()});
          fixture.emit();return true;
        }
        if(action==='session.enqueue'){
          if(p.expectedTurnId){s.messages.push({id:crypto.randomUUID(),role:'user',steering:true,text:p.text,createdAt:new Date().toISOString()});fixture.emit();return true;}
          if(fixture.delay)await new Promise(resolve=>{fixture.release=resolve;});
          if(fixture.fail)throw new Error('队列保存失败，输入已保留');
          const q=s.inputQueue||={items:[],paused:false};q.items.push({id:crypto.randomUUID(),input:{text:p.text,sourceIds:p.sourceIds,capabilities:p.capabilities,answers:{}},state:'queued'});fixture.emit();return true;
        }
        if(action.startsWith('session.queue.')){const q=s.inputQueue,item=q.items.find(i=>i.id===p.itemId);
          if(action.endsWith('.pause'))q.paused=true;
          if(action.endsWith('.resume'))q.paused=false;
          if(action.endsWith('.beginEdit')){q.editing={itemId:item.id,previousDraft:p.draft};const d={...item.input,editingQueueItemId:item.id};data.snapshot.inputs[s.id]=d;fixture.emit();return d;}
          if(action.endsWith('.saveEdit')||action.endsWith('.cancelEdit')){if(action.endsWith('.saveEdit')){const {editingQueueItemId,...rest}=p.draft;item.input=rest;}const d=q.editing.previousDraft;delete q.editing;data.snapshot.inputs[s.id]=d;fixture.emit();return d;}
          if(action.endsWith('.remove'))q.removed=[{item,index:q.items.indexOf(item)}];
          if(action.endsWith('.undo')){const r=q.removed.pop();q.items.splice(r.index,0,r.item);}
          if(action.endsWith('.remove')||action.endsWith('.steer'))q.items=q.items.filter(i=>i!==item);
          if(action.endsWith('.steer'))s.messages.push({id:crypto.randomUUID(),role:'user',steering:true,text:item.input.text,createdAt:new Date().toISOString()});
          fixture.emit();return true;
        }
        if(action==='session.stop'){s.inputQueue.paused=true;s.status='idle';delete data.snapshot.activeTurns[s.id];s.stoppedAt=new Date().toISOString();fixture.emit();return true;}
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
  await input.fill('还在写的草稿');
  const editFirst = queue.getByRole('button',{name:'编辑第 1 条待发送消息',exact:true});
  await editFirst.click();await expect(input).toHaveValue(first);await expect(queue.locator('.queue-row')).toHaveCount(1);
  await input.fill('放弃的编辑');await input.press('Escape');await expect(input).toHaveValue('还在写的草稿');
  await expect(queue.locator('.queue-text').first()).toHaveText(first);
  await editFirst.click();await input.fill('编辑后的第一条');await input.press('Enter');await expect(queue.locator('.queue-text').first()).toHaveText('编辑后的第一条');await expect(input).toHaveValue('还在写的草稿');
  await input.fill('引导快捷键');await input.press('Control+Enter');await expect(input).toHaveValue('');
  assert.equal(await page.evaluate(()=>window.queueFixture.calls.filter(c=>c.p?.expectedTurnId==='turn-1'&&c.p?.text==='引导快捷键').length),1);
  await queue.getByLabel('待发送消息操作').first().click();await page.getByText('关闭排队模式',{exact:true}).click();
  await input.fill('默认直接引导');await input.press('Enter');await expect(input).toHaveValue('');await expect(queue.locator('.queue-row')).toHaveCount(2);
  await queue.getByLabel('待发送消息操作').first().click();await page.getByText('启用排队模式',{exact:true}).click();
  await page.evaluate(()=>window.queueFixture.complete());await expect(queue.locator('.queue-row')).toHaveCount(1);
  await input.fill('保留在下一轮');await input.press('Shift+Enter');await expect(input).toHaveValue('保留在下一轮\n');await expect(queue.locator('.queue-row')).toHaveCount(1);
  await input.press('Enter');await expect(queue.locator('.queue-row')).toHaveCount(2);
  await page.locator('[data-session-id="second-session"]').click();await expect(input).toHaveValue('独立草稿');await expect(queue).toHaveCount(0);
  await page.locator(`[data-session-id="${data.session.id}"]`).click();await expect(queue.locator('.queue-row')).toHaveCount(2);
  await input.press('Escape');await expect(page.getByText('再按 Esc 停止')).toBeVisible();await input.press('Escape');await expect(queue.getByLabel('继续队列')).toBeVisible();
  await page.evaluate(()=>window.queueFixture.complete());await expect(queue.locator('.queue-row')).toHaveCount(2);
  await queue.getByLabel('移除第 2 条待发送消息').click();await expect(queue.locator('.queue-row')).toHaveCount(1);
  await queue.getByRole('button',{name:'撤销删除'}).click();await expect(queue.locator('.queue-row')).toHaveCount(2);
  await queue.getByLabel('移除第 2 条待发送消息').click();await expect(queue.locator('.queue-row')).toHaveCount(1);
  await page.evaluate(()=>{window.queueFixture.fail=true;});await input.fill('失败时保留文字');await input.press('Enter');await expect(input).toHaveValue('失败时保留文字');await expect(page.getByRole('alert').filter({hasText:'队列保存失败，输入已保留'})).toBeVisible();
  await page.evaluate(()=>{window.queueFixture.fail=false;window.queueFixture.delay=true;});await input.press('Enter');await input.fill('提交期间新写的草稿');await page.evaluate(()=>window.queueFixture.release());await expect(queue.locator('.queue-row')).toHaveCount(2);await expect(input).toHaveValue('提交期间新写的草稿');
  await page.evaluate(()=>{const f=window.queueFixture,s=f.data.snapshot.sessions[0];f.delay=false;s.messages.push({id:'native:test-edit',role:'user',text:'原始版本',createdAt:new Date().toISOString()});s.nativeId='native-thread';s.inputQueue.items=[];s.status='idle';f.emit();});
  const pencil=page.getByRole('button',{name:'编辑上一条消息',exact:true});
  await pencil.click();let history=page.getByRole('textbox',{name:'编辑上一条消息'});await expect(history).toHaveValue('原始版本');
  await history.fill('临时编辑');await history.press('Escape');await expect(history).toHaveCount(0);
  await pencil.click();await history.fill('修订版本');await page.getByRole('button',{name:'重新发送',exact:true}).click();
  await expect(page.getByText('修订版本',{exact:true})).toBeVisible();
  await expect(input).toHaveValue('提交期间新写的草稿');
  if (!await page.locator('[data-session-id="child-session"]').isVisible()) await page.getByRole('button',{name:'展开会话菜单：'+data.snapshot.sessions[0].title,exact:true}).click();
  await page.locator('[data-session-id="child-session"]').click();
  const childInput=page.getByRole('textbox',{name:'子会话输入'}), childQueue=page.locator('.subsession-composer').getByRole('region',{name:'待发送消息'});
  await childInput.fill('子会话排队');await childInput.press('Enter');await expect(childQueue.locator('.queue-text')).toHaveText('子会话排队');
  await childInput.fill('子会话草稿');await childQueue.getByLabel('编辑第 1 条待发送消息').click();await expect(childInput).toHaveValue('子会话排队');
  await childInput.fill('子会话新内容');await childInput.press('Escape');await expect(childInput).toHaveValue('子会话草稿');
  await childInput.press('Control+Enter');await expect(childInput).toHaveValue('');
  assert.equal(await page.evaluate(()=>window.queueFixture.calls.filter(c=>c.p?.expectedTurnId==='child-turn'&&c.p?.id==='child-session').length),1);
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  console.log(JSON.stringify({ok:true,screenshots:[path.join(out,'queue-desktop.png'),path.join(out,'queue-narrow.png')]}));
} finally { await app?.close(); }
