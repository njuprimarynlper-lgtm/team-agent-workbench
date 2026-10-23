import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron, expect } from '@playwright/test';

const root = process.cwd(), require = createRequire(import.meta.url);
await fs.mkdir(path.join(root, '.test-data'), { recursive: true });
const out = await fs.mkdtemp(path.join(root, '.test-data', 'question-composer-'));
const modulePath = name => JSON.stringify(path.join(root, name).replaceAll('\\', '/'));
let app;
try {
  await fs.writeFile(path.join(out, 'entry.tsx'), `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { QuestionPanel } from ${modulePath('src/renderer/team-questions')};
    import { questionCommandSchema } from ${modulePath('src/shared/questions')};
    import ${modulePath('src/renderer/styles.css')};
    import ${modulePath('src/renderer/team-questions.css')};
    window.calls = []; window.failSend = false; window.pickFiles = [];
    window.workbench = { async call(action, payload) {
      window.calls.push({action, payload});
      if (action === 'question.members') return [{username:'bob',name:'张三'},{username:'carol',name:'李四'}];
      if (action === 'question.files.stage') return window.pickFiles;
      if (action === 'question.files.remove') return true;
      if (action === 'question.create') {
        questionCommandSchema.parse({...payload.question, kind:'create', sessionId:payload.sessionId});
        if(window.failSend) throw Error('发送失败，请重试');
        return {...payload.question, projectId:'p'};
      }
      throw Error('Unexpected action: '+action);
    }};
    function App() {
      const [version, reset] = useState(0), [ai, setAi] = useState(false);
      window.resetComposer = () => reset(value => value + 1); window.setAi = setAi;
      const session = {id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',purpose:'work',status:'idle',binding:{project:{id:'p'}},messages:ai?[{id:'a',role:'assistant',text:'[[继续提问]]\\n请确认样本版本。',createdAt:''}]:[]};
      return <div style={{height:'100vh',display:'flex',justifyContent:'center'}}><QuestionPanel key={version} selectedId="" session={session} username="alice" sessions={[session]} connected select={()=>{}} close={()=>{}} changed={async()=>{}}/></div>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `);
  await build({ entryPoints: [path.join(out, 'entry.tsx')], outdir: out, entryNames: 'renderer', chunkNames: 'chunk-[hash]', bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'chrome130', loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } });
  await fs.writeFile(path.join(out, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script></html>');
  await fs.writeFile(path.join(out, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(out, 'profile'))});app.whenReady().then(()=>{const window=new BrowserWindow({show:false,width:900,height:900,webPreferences:{sandbox:true,contextIsolation:true}});window.loadFile(${JSON.stringify(path.join(out, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: require('electron'), args: [path.join(out, 'main.cjs')], env, timeout: 20000 });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const composer = page.getByRole('region', { name: '发起提问' });
  const title = composer.getByLabel('问题标题', { exact: true }), body = composer.getByLabel('问题内容', { exact: true });
  const context = composer.getByLabel('补充资料（选填）', { exact: true });
  const send = composer.getByRole('button', { name: /^发送提问/ });
  const selectBob = async () => {
    await composer.getByRole('button', { name: '选择成员', exact: true }).click();
    await composer.getByLabel('搜索成员').fill('bob');
    await expect(composer.getByRole('checkbox')).toHaveCount(1);
    await composer.getByRole('checkbox', { name: '张三 bob' }).check();
    await composer.getByRole('button', { name: '完成选择' }).click();
  };
  await expect(composer).toBeVisible(); await expect(context).toBeHidden();
  await expect(composer.getByRole('checkbox')).toHaveCount(0);
  await expect(composer.getByRole('button', { name: '填入 AI 建议' })).toHaveCount(0);
  await selectBob(); await body.fill('请确认这轮使用哪个样本版本？');
  await expect(title).toHaveValue(''); await expect(send).toBeDisabled();
  await title.fill('样本版本确认'); await expect(send).toBeEnabled();
  await composer.getByRole('button', { name: '添加附件' }).click();
  await expect(composer.locator('.team-question-file-chip')).toHaveCount(0);
  await page.screenshot({ path: path.join(out, 'compact.png') });
  await send.click();
  let created = await page.evaluate(() => window.calls.filter(item => item.action === 'question.create'));
  assert.equal(created.length, 1); assert.equal(created[0].payload.question.context, '');
  assert.equal(created[0].payload.question.title, '样本版本确认');
  await page.evaluate(() => window.setAi(true));
  await composer.getByRole('button', { name: '填入 AI 建议' }).click();
  await expect(body).toHaveValue('请确认这轮使用哪个样本版本？\n\n请确认样本版本。');
  await expect(title).toHaveValue('样本版本确认');
  await composer.getByRole('button', { name: '撤销填入' }).click();
  await expect(body).toHaveValue('请确认这轮使用哪个样本版本？');
  await composer.locator('.team-question-extra summary').click();
  await context.fill('参考资料：https://example.invalid/dataset');
  await composer.locator('.team-question-extra summary').click();
  await expect(context).toBeHidden(); await expect(composer.locator('.team-question-extra summary')).toContainText('已填写');
  await page.evaluate(() => { window.pickFiles = [{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'样本说明.txt',size:128}]; window.failSend = true; });
  await composer.getByRole('button', { name: '添加附件' }).click();
  await expect(composer.locator('.team-question-file-chip')).toContainText('样本说明.txt');
  await send.click(); await expect(composer.getByRole('alert')).toContainText('发送失败');
  await expect(title).toHaveValue('样本版本确认'); await expect(body).toHaveValue('请确认这轮使用哪个样本版本？');
  await page.evaluate(() => { window.failSend = false; });
  await send.click();
  created = await page.evaluate(() => window.calls.filter(item => item.action === 'question.create'));
  assert.equal(created[1].payload.question.id, created[2].payload.question.id);
  assert.equal(created[2].payload.question.context, '参考资料：https://example.invalid/dataset');
  assert.deepEqual(created[2].payload.question.fileIds, ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
  await composer.getByRole('button', { name: '移除接收人 bob' }).click(); await expect(send).toBeDisabled();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, output: out, cases: ['manual title required', 'optional context hidden by default and empty submission succeeds', 'search/select/remove recipients', 'cancel attachment selection does nothing', 'AI append and undo preserve user text and title', 'collapsed supplementary text is submitted', 'failed send keeps inputs and retry identity'] }));
} finally { await app?.close(); }
