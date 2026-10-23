// Real renderer, isolated fixture: no server, provider or model traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron, expect } from '@playwright/test';
import { makeFixture } from './handbook-ui-fixture.mjs';

const root = process.cwd(), require = createRequire(import.meta.url);
const out = await fs.mkdtemp(path.join(root, '.test-data', 'question-reply-draft-'));
const modulePath = file => JSON.stringify(path.join(root, file).replaceAll('\\', '/'));
const data = makeFixture('case-member-questions', 4, 1, { actor: 'Bob', screen: '工作会话', status: '就绪' }, 'answered');
data.snapshot.selectedProjectId = data.project.id;
data.snapshot.inputs[data.session.id].text = '我尚未发送的问题';
data.snapshot.inputs[data.session.id].answers = { pending: '保留我的选择' };
data.snapshot.inputs[data.session.id].capabilities = [{ id: 'test-skill', name: '测试 Skill', type: 'skill' }];
let app, page;
try {
  await fs.writeFile(path.join(out, 'entry.tsx'), `
    import { installFixture } from ${modulePath('scripts/handbook-ui-fixture.mjs')};
    import { visibleImportedReply } from ${modulePath('src/shared/questions')};
    const data = ${JSON.stringify(data)};
    installFixture(data);
    const original = window.workbench, listeners = [], calls = [];
    const fixture = window.replyFixture = { data, calls, fail: false, delay: false, release: undefined,
      emit:()=>listeners.forEach(listener=>listener({type:'state'})) };
    window.workbench = {
      subscribe(listener) { listeners.push(listener); const unsubscribe = original.subscribe(listener); return () => { listeners.splice(listeners.indexOf(listener), 1); unsubscribe(); }; },
      async call(action, payload) {
        action = action.replace(/^personal:/, ''); calls.push({action,payload});
        if(action === 'question.import') {
          if(fixture.delay) await new Promise(resolve=>{fixture.release=resolve;});
          if(fixture.fail) throw new Error('回复暂时无法读取，请重试');
          const q = data.snapshot.questions.items.find(q=>q.id===payload.id);
          const r = q.recipients.find(r=>r.answers.some(a=>a.id===payload.answerId));
          const a = r.answers.find(a=>a.id===payload.answerId);
          return visibleImportedReply(false,q.title,r.name,a.body,a.files);
        }
        if(action === 'session.send') return true;
        return original.call(action,payload);
      }
    };
    await import(${modulePath('src/renderer/main.tsx')});
  `);
  await build({ entryPoints: [path.join(out, 'entry.tsx')], outdir: out, entryNames: 'renderer', chunkNames: 'chunk-[hash]', bundle: true, splitting: true, platform: 'browser', format: 'esm', target: 'chrome130', loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } });
  await fs.copyFile('src/renderer/index.html', path.join(out, 'index.html'));
  await fs.writeFile(path.join(out, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(out, 'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});win.loadFile(${JSON.stringify(path.join(out, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: require('electron'), args: [path.join(out, 'main.cjs')], env, timeout: 20000 });
  page = await app.firstWindow(); const errors = [], network = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await page.locator(`[data-session-id="${data.session.id}"]`).click();
  await page.getByRole('button', { name: '提问', exact: true }).click();
  await page.locator('.team-question-card').filter({ hasText: data.question.title }).click();
  const fill = page.getByRole('button', { name: '填入对话框', exact: true });
  const input = page.getByLabel('任务输入', { exact: true });
  const reply = '问题：' + data.question.title + '\n回复人：Carol\n' + data.question.recipients[0].answers[0].body;
  const draft = '我尚未发送的问题\n\n' + reply;
  const noAutoSend = async () => {
    assert.deepEqual(await page.evaluate(() => window.replyFixture.calls.filter(c => /session\.(send|steer|resume|stop)$/.test(c.action))), []);
    assert.deepEqual(await page.evaluate(() => window.replyFixture.data.snapshot.questions.jobs), []);
    assert.deepEqual(await page.evaluate(() => window.replyFixture.data.snapshot.sessions[0].messages), data.session.messages);
    await expect(page.locator('.message-pending')).toHaveCount(0);
  };
  await expect(input).toHaveValue('我尚未发送的问题'); await fill.click(); await expect(input).toHaveValue(draft);
  await expect(page.getByText('回复已填入对话框，确认后发送。', { exact: true })).toBeVisible();
  const saved = await page.evaluate(() => window.replyFixture.data.snapshot.inputs['work-session']);
  assert.deepEqual(saved.sourceIds, ['project-brief']); assert.deepEqual(saved.answers, { pending: '保留我的选择' });
  assert.deepEqual(saved.capabilities, data.snapshot.inputs[data.session.id].capabilities); assert.equal(saved.nextTurnOnly, true);
  await noAutoSend(); await fill.click(); await expect(input).toHaveValue(draft);
  await input.fill(''); await fill.click(); await expect(input).toHaveValue(reply); await noAutoSend();
  await input.fill('保留失败前的草稿'); await page.evaluate(() => { window.replyFixture.fail = true; });
  await fill.click(); await expect(page.getByText('回复暂时无法读取，请重试', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('保留失败前的草稿'); await noAutoSend();
  await page.evaluate(() => { window.replyFixture.fail = false; window.replyFixture.delay = true; });
  await fill.click(); await expect(fill).toBeDisabled(); await input.fill('读取期间我继续输入的文字');
  await page.evaluate(() => { window.replyFixture.release(); window.replyFixture.delay = false; });
  await expect(input).toHaveValue('读取期间我继续输入的文字\n\n' + reply); await noAutoSend();
  await page.evaluate(() => {
    const fixture = window.replyFixture, snapshot = fixture.data.snapshot;
    snapshot.sessions.push({ ...snapshot.sessions[0], id: 'other-session', title: '另一条工作会话' });
    snapshot.inputs['other-session'] = { text: '另一条会话的草稿', sourceIds: [], answers: {} }; fixture.emit();
  });
  await page.locator('[data-session-id="other-session"]').click(); await expect(input).toHaveValue('另一条会话的草稿');
  await page.locator('.team-question-card').filter({ hasText: data.question.title }).click(); await fill.click();
  await expect(page.locator('[data-session-id="work-session"]')).toHaveClass(/selected/);
  await expect(input).toHaveValue('读取期间我继续输入的文字\n\n' + reply);
  assert.equal(await page.evaluate(() => window.replyFixture.data.snapshot.inputs['other-session'].text), '另一条会话的草稿');
  await noAutoSend();
  await page.evaluate(() => { window.replyFixture.data.snapshot.sessions[0].status = 'running'; window.replyFixture.data.snapshot.activeTurns = { 'work-session': 'active-turn' }; window.replyFixture.emit(); });
  await input.fill('正在执行时的草稿'); await fill.click(); await expect(input).toHaveValue('正在执行时的草稿\n\n' + reply);
  await expect(page.getByRole('button', { name: '等待本轮结束' })).toBeDisabled(); await noAutoSend();
  await page.evaluate(() => { window.replyFixture.data.snapshot.sessions[0].status = 'idle'; window.replyFixture.emit(); });
  await input.fill('确认后的回答\n\n' + reply);
  await page.screenshot({ path: path.join(out, 'reply-in-composer.png') });
  await page.getByRole('button', { name: '发送任务', exact: true }).click(); await expect(input).toHaveValue('');
  const sends = await page.evaluate(() => window.replyFixture.calls.filter(c => c.action === 'session.send'));
  assert.equal(sends.length, 1); assert.equal(sends[0].payload.text, '确认后的回答\n\n' + reply);
  assert.deepEqual(errors, []); assert.deepEqual(network, []);
  console.log(JSON.stringify({ passed: true, output: out, cases: ['reply fills composer without a model turn or chat bubble', 'preserves text and selected references/capabilities/answers', 'duplicate click does not duplicate draft', 'delete then refill', 'failure retains draft', 'edits while loading survive', 'fills the originating session when another session is open', 'running turn is not interrupted or steered', 'only explicit Send invokes model'] }));
} catch (error) { await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw error; }
finally { await app?.close(); }
