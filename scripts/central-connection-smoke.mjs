import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { makeFixture } from './handbook-ui-fixture.mjs';

const root = process.cwd(), out = await fs.mkdtemp(path.join(root, '.test-data', 'project-connections-ui-'));
const modulePath = name => JSON.stringify(path.join(root, name).replaceAll('\\', '/'));
const data = makeFixture('case-first-session', 6, 1, { actor: 'Bob', screen: '工作会话', status: '就绪' });
const a = data.project, b = { ...a, id: 'second-project', name: '软件开发项目', remoteRoot: a.remoteRoot + '-b' };
data.profile.projects.push(b);
for (const [key,value] of Object.entries(data.snapshot.settings.projectDirectories)) data.snapshot.settings.projectDirectories[key.replace(a.id,b.id)] = value;
data.snapshot.connection.profile.projects = data.profile.projects;
data.snapshot.settings.workspaceSnapshot.profile.projects = data.profile.projects;
data.snapshot.projectConnections = { [a.id]: { connected: true }, [b.id]: { connected: false } };
data.snapshot.selectedProjectId = a.id;
let browser;
try {
  await fs.writeFile(path.join(out, 'entry.tsx'), `
    import { installFixture } from ${modulePath('scripts/handbook-ui-fixture.mjs')};
    import { accountIdentity } from ${modulePath('src/shared/account-data')};
    const data = ${JSON.stringify(data)};
    data.snapshot.reusableConnections = [{key:accountIdentity(data.profile),profile:data.profile}];
    installFixture(data);
    const original=window.workbench,listeners=[],calls=[];
    const fixture=window.centralFixture={data,calls,fail:false,emit:()=>listeners.forEach(fn=>fn({type:'state'})),
      offline(){data.snapshot.connection.connected=false;data.snapshot.reusableConnections=[];Object.values(data.snapshot.projectConnections).forEach(s=>s.connected=false);this.emit();}};
    window.workbench={subscribe(fn){listeners.push(fn);const off=original.subscribe(fn);return()=>{listeners.splice(listeners.indexOf(fn),1);off();};},async call(action,p){
      calls.push({action,p});
      if(action==='project.connection.open'||action==='remote.connect'){
        if(fixture.fail)throw new Error(action==='remote.connect'?'Authentication failed':'中央节点连接已断开，请重新连接');
        data.snapshot.connection.connected=true;data.snapshot.projectConnections[p.projectId]={connected:true};
        data.snapshot.reusableConnections=[{key:accountIdentity(data.profile),profile:data.profile}];fixture.emit();
        return action==='remote.connect'?{...data.profile,selectedProjectId:p.projectId}:{newWindow:false,projectId:p.projectId};
      }
      if(action==='project.connection.disconnect'){data.snapshot.projectConnections[p.projectId]={connected:false};fixture.emit();return true;}
      if(action==='project.directory.impact')return {following:0,fixed:0,pending:0,failed:0};
      return original.call(action,p);
    }};
    await import(${modulePath('src/renderer/main.tsx')});
  `);
  await build({entryPoints:[path.join(out,'entry.tsx')],outdir:out,entryNames:'renderer',chunkNames:'chunk-[hash]',splitting:true,bundle:true,platform:'browser',format:'esm',target:'chrome130',loader:{'.woff2':'file','.woff':'file','.ttf':'file'}});
  await fs.copyFile('src/renderer/index.html',path.join(out,'index.html'));
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--allow-file-access-from-files']});
  const page=await browser.newPage({viewport:{width:1300,height:900}}),errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
  await page.goto(new URL('file:///'+path.join(out,'index.html').replaceAll('\\','/')).href);
  await page.locator('.sidebar').waitFor();
  const row=id=>page.locator('.workgroup-project-item').filter({has:page.locator('[data-project-id="'+id+'"]')});
  const settings=page.getByRole('dialog',{name:/项目设置/});
  await expect(page.locator('.topbar').getByRole('button',{name:/中央节点/})).toHaveCount(0);
  await expect(row(a.id).locator('.project-connection-entry')).toContainText('已连接');
  await expect(row(b.id).locator('.project-connection-entry')).toHaveCount(0);
  await page.locator('[data-project-id="'+b.id+'"]').click();
  await expect(row(b.id).locator('.project-connection-entry')).toContainText('未连接');
  await row(b.id).locator('.project-connection-entry').click();
  const central=page.getByLabel('项目中央节点',{exact:true});
  await expect(central).toContainText('未连接');
  await central.getByRole('button',{name:'连接',exact:true}).click();
  const modal=page.locator('.modal').filter({has:page.getByRole('heading',{name:'项目中央节点',exact:true})});
  await expect(modal.getByLabel('选择中央节点连接')).toBeVisible();
  await expect(modal.getByLabel('登录密码',{exact:true})).toHaveCount(0);
  await page.evaluate(()=>window.centralFixture.fail=true);
  await modal.getByRole('button',{name:'使用此连接',exact:true}).click();
  await expect(modal.getByRole('alert')).toContainText('连接已断开');
  await page.evaluate(()=>window.centralFixture.fail=false);
  await modal.getByRole('button',{name:'使用此连接',exact:true}).click();
  await expect(modal).toHaveCount(0); await expect(row(b.id).locator('.project-connection-entry')).toContainText('已连接');
  await page.locator('[data-project-id="'+a.id+'"]').click();await row(a.id).locator('.project-connection-entry').click();
  await central.getByRole('button',{name:'断开本项目',exact:true}).click();
  await expect(central).toContainText('未连接');
  assert.equal(await page.evaluate(id=>window.centralFixture.data.snapshot.projectConnections[id].connected,b.id),true);
  assert.equal(await page.evaluate(()=>window.centralFixture.data.snapshot.connection.connected),true);
  await settings.getByRole('button',{name:'关闭窗口',exact:true}).click();
  await expect(page.locator('[data-session-id="'+data.session.id+'"]').first()).toBeVisible();
  await page.evaluate(()=>window.centralFixture.offline());
  await row(a.id).locator('.project-connection-entry').click();await central.getByRole('button',{name:'连接',exact:true}).click();
  await expect(modal.getByLabel('中央节点地址',{exact:true})).toHaveValue(data.profile.host);
  await expect(modal.getByLabel('成员账号',{exact:true})).toHaveValue(data.profile.username);
  await expect(modal.getByLabel('登录密码',{exact:true})).toHaveValue('');
  await modal.getByLabel('登录密码',{exact:true}).fill('fixture-password');
  await page.evaluate(()=>window.centralFixture.fail=true);
  await modal.getByRole('button',{name:'连接',exact:true}).click();await expect(modal.getByRole('alert')).toContainText('账号或密码');
  await page.evaluate(()=>window.centralFixture.fail=false);
  await modal.getByRole('button',{name:'连接',exact:true}).click();await expect(modal).toHaveCount(0);
  const calls=await page.evaluate(()=>window.centralFixture.calls);
  assert.equal(calls.filter(c=>c.action==='remote.disconnect').length,0);
  for(const c of calls.filter(c=>c.action==='project.connection.open'))assert.equal(c.p.projectId,b.id);
  for(const c of calls.filter(c=>c.action==='remote.connect'))assert.equal(c.p.projectId,a.id);
  assert.equal(await page.evaluate(id=>window.centralFixture.data.snapshot.projectConnections[id].connected,b.id),false);
  await page.screenshot({path:path.join(out,'project-connection.png')});
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  console.log('PASS: per-project entry, reuse without password, independent disconnect, preserved local session, scoped reconnection and failure feedback. '+out);
} finally { await browser?.close(); }
