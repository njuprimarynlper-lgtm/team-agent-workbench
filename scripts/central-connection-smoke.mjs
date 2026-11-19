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
data.snapshot.projectConnections = { [a.id]: { connected: true, syncStatus: 'synced' }, [b.id]: { connected: true, syncStatus: 'unsynced', failure: { version: 1, code: 'CENTRAL_CONNECTION_RESET', message: '读取项目共享成果没有返回结果。后台会重试，也可以点“立即重试”。' } } };
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
      offline(){data.snapshot.connection.connected=false;data.snapshot.reusableConnections=[];Object.values(data.snapshot.projectConnections).forEach(s=>{s.connected=false;s.syncStatus='unsynced';delete s.failure;});this.emit();}};
    window.workbench={subscribe(fn){listeners.push(fn);const off=original.subscribe(fn);return()=>{listeners.splice(listeners.indexOf(fn),1);off();};},async call(action,p){
      calls.push({action,p});
      if(action==='project.connection.open'||action==='remote.connect'||action==='project.connection.retry'){
        if(fixture.fail)throw new Error(action==='remote.connect'?'Authentication failed':'中央节点连接已断开，请重新连接');
        data.snapshot.connection.connected=true; if(action==='remote.connect'){Object.keys(data.snapshot.projectConnections).forEach(id=>data.snapshot.projectConnections[id]={connected:true,syncStatus:'synced'});} else data.snapshot.projectConnections[p.projectId]={connected:true,syncStatus:'synced'};
        data.snapshot.reusableConnections=[{key:accountIdentity(data.profile),profile:data.profile}];fixture.emit();
        return action==='remote.connect'?{...data.profile,selectedProjectId:p.projectId}:{newWindow:false,projectId:p.projectId};
      }
      if(action==='project.connection.disconnect'){data.snapshot.projectConnections[p.projectId]={connected:false,syncStatus:'paused'};fixture.emit();return true;}
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
  await expect(page.locator('.topbar').getByRole('button',{name:/中央节点/})).toHaveCount(1);
  await expect(row(a.id).locator('.project-connection-entry')).toHaveText('已同步');
  await expect(row(b.id).locator('.project-connection-entry')).toHaveText('未同步');
  await page.screenshot({path:path.join(out,'automatic-sync-status.png')});
  // Status is visible even when a different project is selected.
  await row(b.id).locator('.project-connection-entry').click();
  const central=page.getByLabel('项目中央节点',{exact:true});
  await expect(central).toContainText('未同步');
  await expect(central.getByRole('alert')).toContainText('读取项目共享成果');
  await page.screenshot({path:path.join(out,'automatic-sync-failure.png')});
  await page.evaluate(()=>window.centralFixture.fail=true);
  await central.getByRole('button',{name:'立即重试',exact:true}).click();
  await expect(central.getByRole('alert').last()).toContainText('连接已断开');
  await page.evaluate(()=>window.centralFixture.fail=false);
  await central.getByRole('button',{name:'立即重试',exact:true}).click();
  await expect(row(b.id).locator('.project-connection-entry')).toHaveText('已同步');
  await expect(central.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('dialog',{name:'项目中央节点',exact:true})).toHaveCount(0);
  await central.getByRole('button',{name:'暂停本项目同步',exact:true}).click();
  await expect(central).toContainText('已暂停');
  await expect(row(a.id).locator('.project-connection-entry')).toHaveText('已同步');
  await central.getByRole('button',{name:'恢复同步',exact:true}).click();
  await expect(row(b.id).locator('.project-connection-entry')).toHaveText('已同步');
  await settings.getByRole('button',{name:'关闭窗口',exact:true}).click();
  await page.screenshot({path:path.join(out,'automatic-sync-recovered.png')});
  await page.evaluate(()=>window.centralFixture.offline());
  await expect(row(a.id).locator('.project-connection-entry')).toHaveText('未同步');
  await expect(row(b.id).locator('.project-connection-entry')).toHaveText('未同步');
  const calls=await page.evaluate(()=>window.centralFixture.calls);
  assert.equal(calls.filter(c=>c.action==='remote.disconnect').length,0);
  assert.equal(calls.filter(c=>c.action==='project.connection.open').length,0);
  assert.equal(calls.filter(c=>c.action==='project.connection.retry').length,3);
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  console.log('PASS: all project status badges remain visible; failed synchronization retries on the current authenticated connection, recovers without a login dialog, and pauses independently. '+out);
} finally { await browser?.close(); }
