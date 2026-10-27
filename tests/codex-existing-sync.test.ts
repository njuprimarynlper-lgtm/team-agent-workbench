import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prepareDesktopRollout } from '../src/core/native-publish';
import { prepareCodexStorage } from '../src/core/codex-storage';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import type { AgentSession, WorkbenchAPI } from '../src/shared/types';
import { CodexDesktopOption, NativeDesktopControls } from '../src/renderer/native-desktop-controls';
import { NativeDesktopStatus } from '../src/renderer/native-desktop-controls';
import { SessionSyncFrame } from '../src/renderer/session-sync-frame';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

const renderSyncFrame = (session: AgentSession, locked = false) => renderToStaticMarkup(React.createElement(SessionSyncFrame, {
  session, locked, api: { call: async () => { throw Error('No IPC during rendering'); } } as unknown as WorkbenchAPI,
  changed: async () => {}, children: React.createElement('textarea', { defaultValue: '未发送的草稿' }),
}));

const history = (id: string) => [
  {type:'session_meta',payload:{id,cwd:'fixture'}},
  {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'原问题'}]}},
  {type:'response_item',payload:{type:'function_call',call_id:'tool-1',name:'shell',arguments:'{"command":"echo evidence"}'}},
  {type:'response_item',payload:{type:'function_call_output',call_id:'tool-1',output:'evidence'}},
  {type:'compacted',payload:{message:'保留项目约定',replacement_history:[{type:'message',role:'user',content:[{type:'input_text',text:'原问题'}]}]}},
].map(item=>JSON.stringify(item)).join('\n')+'\n';

async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-existing-sync-')),desktop=path.join(root,'desktop'),data=path.join(root,'data'),privateHome=path.join(data,'codex-home');
  await fs.mkdir(path.join(privateHome,'sessions'),{recursive:true});await fs.mkdir(desktop,{recursive:true});
  let prepares=0,starts=0,failStart=false,ready=true,opens=0;
  let preflight=async()=>{};
  const service={sourceHome:desktop,readyToPrepare:async()=>ready,prepare:async(s:AgentSession,home:string)=>{prepares++;await preflight();return prepareDesktopRollout(s,home,desktop);},storage:async()=>{throw Error('fixture runtime only');},open:async()=>{opens++;}};
  const wb=new Workbench(data,()=>{},()=>{},undefined,undefined,undefined,service);
  await wb.store.init();grantTestWorkspace(wb,root);
  const session=await wb.createSession('codex',root,offlineProjectId,'work',undefined,undefined,'inherit',false,'direct');
  session.title='已有会话';session.nativeId=randomUUID();session.codexStorage='workbench';session.nativePath=path.join(privateHome,'sessions','rollout-'+session.nativeId+'.jsonl');
  session.messages=[{id:'original',role:'user',text:'原问题',createdAt:new Date().toISOString()}];
  await fs.writeFile(session.nativePath,history(session.nativeId));
  wb.store.inputs[session.id]={text:'未发送的草稿',sourceIds:[],answers:{}};
  const original=structuredClone(session);
  (wb as any).requireAuth=async()=>{};
  (wb as any).createRuntime=async(s:AgentSession)=>{
    if(!s.codexDesktop && s.codexPrivateFork){
      const runtime={session:s,close:async()=>{},ensureStarted:async()=>{
        const nativeId=randomUUID(),file=path.join(privateHome,'sessions','rollout-'+nativeId+'.jsonl');
        const rows=(await fs.readFile(s.nativePath!,'utf8')).trim().split('\n').map(line=>JSON.parse(line));rows[0].payload.id=nativeId;
        await fs.writeFile(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
        s.nativeId=nativeId;s.nativePath=file;delete s.codexPrivateFork;s.status='idle';
      }};(wb as any).runtimes.set(s.id,runtime);return runtime;
    }
    assert.equal(s.codexDesktop,true);
    const runtime={session:s,close:async()=>{},ensureStarted:async()=>{
      starts++;
      const saved=JSON.parse(await fs.readFile(path.join(data,'sessions.json'),'utf8')).find((item:any)=>item.id===s.id);
      assert.equal(saved.codexDesktop,true,'new execution ownership is durable before resuming');
      if(failStart)throw Error('backend temporarily unavailable');
      s.nativeId ||= randomUUID();s.nativeLive=true;s.desktopSyncState='connected';s.status='idle';s.error=undefined;
    }};
    (wb as any).runtimes.set(s.id,runtime);return runtime;
  };
  (wb as any).openCodexDesktopIfClosed=async()=>{opens++;};
  return {wb,session,original,root,desktop,privateHome,service,opened:()=>opens,setReady(value:boolean){ready=value;},counts:()=>({prepares,starts}),setPreflight(fn:()=>Promise<void>){preflight=fn;},setFailure(value:boolean){failStart=value;},async close(){await wb.close();await fs.rm(root,{recursive:true,force:true});}};
}

test('existing private history keeps its identity, tools, compaction and draft when attached; repeat clicks do not create another thread',async()=>{
  const f=await fixture();try{
    const s=await f.wb.syncCodexDesktop(f.session.id);
    assert.equal(s.id,f.original.id);assert.equal(s.nativeId,f.original.nativeId);assert.equal(s.title,f.original.title);
    assert.deepEqual(s.messages,f.original.messages);assert.equal(f.wb.store.inputs[s.id].text,'未发送的草稿');
    assert.equal(await fs.readFile(s.nativePath!,'utf8'),history(s.nativeId!));
    assert.equal(await fs.readFile(f.original.nativePath!,'utf8'),history(s.nativeId!));
    assert.equal(s.codexStorage,undefined);assert.equal(s.desktopSyncState,'connected');
    await f.wb.syncCodexDesktop(s.id);assert.deepEqual(f.counts(),{prepares:1,starts:1});
    const copy=new Store(f.wb.store.root);await copy.init();assert.equal(copy.sessions.find(item=>item.id===s.id)?.codexDesktop,true);
  }finally{await f.close();}
});

test('previously imported and previously registered desktop sessions attach in place without copying or forking',async()=>{
  const f=await fixture();try{
    const target=path.join(f.desktop,'sessions','rollout-'+f.session.nativeId+'.jsonl');await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(f.session.nativePath!,target);
    f.session.nativeLive=true;f.session.nativePath=target;delete f.session.codexStorage;
    await f.wb.syncCodexDesktop(f.session.id);assert.equal(f.session.nativePath,target);assert.equal(f.session.nativeId,f.original.nativeId);
    assert.equal((await fs.readdir(path.dirname(target))).length,1);
  }finally{await f.close();}
});

test('missing or inconsistent native history never falls back to a text-only new conversation',async()=>{
  const f=await fixture();try{
    await fs.rm(f.session.nativePath!);
    await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/完整的 Codex 会话记录/);
    assert.equal(f.session.codexDesktop,undefined);assert.deepEqual(f.session.messages,f.original.messages);assert.equal(f.counts().starts,0);
    await fs.writeFile(f.session.nativePath!,history(randomUUID()));
    await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/标识不一致/);
    delete f.session.nativeId;
    await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/缺少完整/);
    assert.equal(f.counts().starts,0);
  }finally{await f.close();}
});

test('a different desktop history with the same native ID is never overwritten; an identical retry is reused',async()=>{
  const f=await fixture();try{
    const target=path.join(f.desktop,'sessions','rollout-'+f.session.nativeId+'.jsonl');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,history(f.session.nativeId!)+JSON.stringify({type:'compacted',payload:{message:'other branch'}})+'\n');
    const before=await fs.readFile(target);
    await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/内容不同/);assert.deepEqual(await fs.readFile(target),before);assert.equal(f.session.codexDesktop,undefined);
    await fs.writeFile(target,history(f.session.nativeId!));await f.wb.syncCodexDesktop(f.session.id);assert.equal(f.session.nativePath,target);
  }finally{await f.close();}
});

test('first connection failure preserves the ordinary session and can retry; failure after ownership switches recovers only the shared thread',async()=>{
  const f=await fixture();try{
    f.setPreflight(async()=>{throw Error('请保存并退出 Codex');});await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/退出 Codex/);
    assert.equal(f.session.codexDesktop,undefined);assert.equal(f.session.codexStorage,'workbench');assert.equal(f.session.status,'idle');
    f.setPreflight(async()=>{});f.setFailure(true);await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/temporarily/);
    assert.equal(f.session.codexDesktop,true);assert.equal(f.session.desktopSyncState,'disconnected');assert.equal(f.session.nativeId,f.original.nativeId);assert.equal(f.session.codexStorage,undefined);
    const prepared=f.counts().prepares;f.setFailure(false);(f.wb as any).openCodexDesktopIfClosed=async()=>{};
    await f.wb.syncCodexDesktop(f.session.id);assert.equal(f.counts().prepares,prepared);assert.equal(f.session.desktopSyncState,'connected');assert.equal(f.session.nativeId,f.original.nativeId);
  }finally{await f.close();}
});

test('busy, closed, wrong provider and management-routed sessions cannot attach',async()=>{
  const f=await fixture();try{
    for(const status of ['starting','running','approval'] as const){f.session.status=status;await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/结束后再同步/);}f.session.status='idle';
    f.session.closedAt='closed';await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/已关闭/);delete f.session.closedAt;
    f.session.networkRoute='management';await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/管理端访问/);f.session.networkRoute='direct';
    f.session.provider='cursor';await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/只有 Codex/);f.session.provider='codex';
    assert.equal(f.counts().prepares,0);
  }finally{await f.close();}
});

test('failed ownership persistence leaves the private session writable and permits a clean retry without duplicate history',async()=>{
  const f=await fixture();const save=f.wb.store.save.bind(f.wb.store);let fail=true;
  try{
    f.wb.store.save=async()=>{if(fail){fail=false;throw Error('fixture disk unavailable');}return save();};
    await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/disk unavailable/);
    assert.equal(f.session.codexDesktop,undefined);assert.equal(f.session.codexStorage,'workbench');assert.equal(f.counts().starts,0);
    assert.equal(f.session.nativePath,f.original.nativePath);assert.equal(f.wb.store.inputs[f.session.id].text,'未发送的草稿');
    await f.wb.syncCodexDesktop(f.session.id);assert.equal(f.session.codexDesktop,true);assert.equal(f.session.nativeId,f.original.nativeId);
    assert.equal((await fs.readdir(path.join(f.desktop,'sessions'))).length,1);
  }finally{f.wb.store.save=save;await f.close();}
});

test('attachment excludes a competing send, close, stop, settings change and duplicate attachment without losing the draft',async()=>{
  const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  let attaching:Promise<unknown>|undefined;
  try{
    f.setPreflight(()=>gate);attaching=f.wb.syncCodexDesktop(f.session.id);
    await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/结束后再同步/);
    await assert.rejects(f.wb.send(f.session.id,'competing'),/正在运行|正在同步/);
    await assert.rejects(f.wb.closeSession(f.session.id),/正在同步/);
    await assert.rejects(f.wb.stop(f.session.id),/正在同步/);
    await assert.rejects(f.wb.changeModel(f.session.id,'another-model'),/正在启动|切换会话设置/);
    assert.equal(f.wb.store.inputs[f.session.id].text,'未发送的草稿');release();await attaching;
  }finally{release();await attaching?.catch(()=>{});await f.close();}
});

test('empty old sessions can be associated without a text-only synthetic rollout',async()=>{
  const f=await fixture();try{
    f.session.messages=[];delete f.session.nativeId;delete f.session.nativePath;
    await f.wb.syncCodexDesktop(f.session.id);assert.equal(f.session.codexDesktop,true);assert.deepEqual(await fs.readdir(f.desktop),[]);
  }finally{await f.close();}
});

test('deferred synchronization keeps latest history but leaves the desktop closed until an explicit open',async()=>{
  const f=await fixture();let closed=0;
  try{
    f.setReady(false);const privateRuntime={session:f.session,close:async()=>{closed++;}};(f.wb as any).runtimes.set(f.session.id,privateRuntime);
    await f.wb.syncCodexDesktop(f.session.id);
    assert(f.session.codexSyncRequest);assert.equal(f.session.codexDesktop,undefined);assert.equal(f.session.status,'idle');assert.equal(closed,0);
    assert.equal((f.wb as any).runtimes.get(f.session.id),privateRuntime);assert.equal((f.wb as any).sending.has(f.session.id),false);
    assert.deepEqual(await fs.readdir(f.desktop),[]);assert.deepEqual(f.counts(),{prepares:0,starts:0});assert.equal(f.opened(),0);
    const saved=new Store(f.wb.store.root);await saved.init();assert.deepEqual(saved.sessions.find(s=>s.id===f.session.id)?.codexSyncRequest,f.session.codexSyncRequest);
    await (f.wb as any).drainDeferredCodexSync();assert.equal(closed,0);assert.equal(f.counts().prepares,0);
    const newTurn=JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'排队后继续了工作'}]}})+'\n';
    await fs.appendFile(f.session.nativePath!,newTurn);f.setReady(true);f.session.status='running';
    await (f.wb as any).drainDeferredCodexSync();assert.equal(closed,0);assert.equal(f.counts().prepares,0);
    f.session.status='idle';await (f.wb as any).drainDeferredCodexSync();
    assert.equal(closed,1);assert.equal(f.opened(),0);assert.equal(f.session.codexDesktop,true);assert.equal(f.session.codexSyncRequest,undefined);
    assert.equal(await fs.readFile(f.session.nativePath!,'utf8'),history(f.original.nativeId!)+newTurn);assert.equal(f.session.nativeId,f.original.nativeId);
    assert.equal(f.wb.store.inputs[f.session.id].text,'未发送的草稿');
    await (f.wb as any).drainDeferredCodexSync();await f.wb.syncCodexDesktop(f.session.id);assert.equal(f.opened(),0);
    f.wb.store.settings.providerPaths.codex=process.execPath;
    await f.wb.openCodexDesktop(f.session.id);assert.equal(f.opened(),1);
  }finally{await f.close();}
});

test('cancelled or closed requests never migrate when the desktop exits; reopening can complete the saved request',async()=>{
  const f=await fixture();try{
    f.setReady(false);await f.wb.syncCodexDesktop(f.session.id);await f.wb.cancelCodexSync(f.session.id);f.setReady(true);
    await (f.wb as any).drainDeferredCodexSync();assert.equal(f.session.codexSyncRequest,undefined);assert.equal(f.counts().starts,0);
    f.setReady(false);await f.wb.syncCodexDesktop(f.session.id);await f.wb.closeSession(f.session.id);f.setReady(true);
    await (f.wb as any).drainDeferredCodexSync();assert(f.session.codexSyncRequest);assert.equal(f.counts().starts,0);
    await f.wb.reopenSession(f.session.id);await (f.wb as any).drainDeferredCodexSync();assert.equal(f.session.codexDesktop,true);assert.equal(f.opened(),0);
  }finally{await f.close();}
});

test('a cancelled request cannot be revived by a late readiness response',async()=>{
  const f=await fixture();let release!:()=>void;let job:Promise<void>|undefined;
  try{
    f.setReady(false);await f.wb.syncCodexDesktop(f.session.id);
    f.service.readyToPrepare=async()=>{await new Promise<void>(resolve=>{release=resolve;});return true;};
    job=(f.wb as any).drainDeferredCodexSync();await f.wb.cancelCodexSync(f.session.id);release();await job;
    assert.equal(f.counts().starts,0);assert.equal(f.opened(),0);assert.equal(f.session.codexSyncRequest,undefined);
  }finally{release?.();await job;await f.close();}
});

test('unavailable history pauses the request with an explanation instead of retrying forever; manual retry recovers',async()=>{
  const f=await fixture();try{
    f.setReady(false);await f.wb.syncCodexDesktop(f.session.id);f.setReady(true);await fs.rm(f.session.nativePath!);
    await (f.wb as any).drainDeferredCodexSync();assert.match(f.session.codexSyncRequest!.error!,/完整的 Codex/);
    const before=f.counts().prepares;await (f.wb as any).drainDeferredCodexSync();assert.equal(f.counts().prepares,before);
    await fs.writeFile(f.original.nativePath!,history(f.original.nativeId!));await f.wb.syncCodexDesktop(f.session.id);
    assert.equal(f.session.codexDesktop,true);assert.equal(f.session.codexSyncRequest,undefined);assert.equal(f.opened(),0);
  }finally{await f.close();}
});

test('deferred UI distinguishes waiting from actual sync and keeps its enabled switch and retry action',()=>{
  const s={provider:'codex',purpose:'work',status:'idle',codexSyncRequest:{requestedAt:'now'}} as AgentSession;
  const status=()=>renderToStaticMarkup(React.createElement(NativeDesktopStatus,{session:s}));
  const menu=()=>renderToStaticMarkup(React.createElement(NativeDesktopControls,{session:s,run(){},showStatus:false}));
  assert.match(status(),/等待 Codex 退出后同步/);assert.doesNotMatch(status(),/>同步中</);
  assert.match(renderSyncFrame(s),/aria-checked="true"/);assert.match(renderSyncFrame(s),/可继续工作/);assert.match(menu(),/完成同步/);assert.doesNotMatch(menu(),/完成同步并打开|自动.*重新打开/);
  s.codexSyncRequest!.error='原记录缺失';assert.match(renderSyncFrame(s),/原记录缺失/);assert.match(menu(),/重试同步/);assert.match(status(),/同步待处理/);
});

test('sync is an ordinary per-session option; existing and imported composers expose the same switch and restrictions',()=>{
  const option=(route:'direct'|'management')=>renderToStaticMarkup(React.createElement(CodexDesktopOption,{checked:true,networkRoute:route,changed(){}}));
  assert.match(option('direct'),/aria-checked="true"/);assert.doesNotMatch(option('direct'),/Beta|disabled/);assert.match(option('management'),/disabled=""/);assert.match(option('management'),/管理端访问/);
  const s={provider:'codex',purpose:'work',status:'idle',nativeId:randomUUID()} as AgentSession;
  const render=()=>renderSyncFrame(s);
  assert.match(render(),/aria-checked="false"/);assert.doesNotMatch(render(),/恢复同步/);s.nativeLive=true;assert.match(render(),/aria-checked="false"/);
  s.status='running';assert.match(render(),/disabled=""/);assert.match(render(),/当前操作结束后/);
  s.status='idle';s.networkRoute='management';assert.match(render(),/管理端访问/);
  s.networkRoute='direct';s.codexDesktop=true;assert.doesNotMatch(render(),/Beta/);assert.match(render(),/aria-checked="true"/);
  const menu=renderToStaticMarkup(React.createElement(NativeDesktopControls,{session:s,run(){},showStatus:false}));
  assert.match(menu,/在 Codex 中打开/);assert.doesNotMatch(menu,/role="switch"/);
});


test('missing desktop installation can be disabled after creation without starting any CLI or desktop; draft and settings survive reload',async()=>{
  const f=await fixture();try{
    const s=f.session;s.messages=[];delete s.nativeId;delete s.nativePath;delete s.codexStorage;
    s.codexDesktop=true;s.status='error';s.error='尚未安装 Codex 桌面版';s.desktopSyncState='disconnected';s.desktopSyncError=s.error;
    s.model='chosen-model';s.permissionMode='full';
    f.service.readyToPrepare=async()=>{throw Error('must not discover desktop');};
    (f.wb as any).requireAuth=async()=>{throw Error('must not authenticate to disable');};
    await f.wb.disableCodexDesktop(s.id);
    assert.equal(s.codexDesktop,undefined);assert.equal(s.status,'idle');assert.equal(s.error,undefined);
    assert.equal(s.desktopSyncError,undefined);assert.equal(s.desktopSyncState,undefined);
    assert.equal(s.model,'chosen-model');assert.equal(s.permissionMode,'full');
    assert.deepEqual(f.counts(),{prepares:0,starts:0});assert.equal(f.opened(),0);
    assert.equal(f.wb.store.inputs[s.id].text,'未发送的草稿');
    const saved=new Store(f.wb.store.root);await saved.init();assert.equal(saved.sessions.find(item=>item.id===s.id)?.codexDesktop,undefined);
    const storage=await prepareCodexStorage(f.wb.store.root,s,f.desktop);
    assert.equal(storage.sharedEndpoint,undefined);assert.notEqual(storage.home,f.desktop);
    await f.wb.disableCodexDesktop(s.id);assert.deepEqual(f.counts(),{prepares:0,starts:0});
  }finally{await f.close();}
});

test('disabling an existing desktop session freezes complete history and ignores stale private copies and the legacy bridge',async()=>{
  const f=await fixture(),bridge=process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE;
  try{
    await f.wb.syncCodexDesktop(f.session.id);const s=f.session,nativePath=s.nativePath!;
    const content=await fs.readFile(nativePath);
    s.inputQueue={items:[],paused:true,error:'保留排队状态'};
    await f.wb.disableCodexDesktop(s.id);
    assert.equal(s.codexDesktop,undefined);assert.equal(s.nativeLive,false);assert.equal(s.codexPrivateFork,true);
    assert.equal(s.id,f.original.id);assert.equal(s.nativeId,f.original.nativeId);
    assert.deepEqual(s.messages,f.original.messages);assert.equal(s.inputQueue.error,'保留排队状态');
    assert.deepEqual(await fs.readFile(s.nativePath!),content);assert.deepEqual(await fs.readFile(nativePath),content);
    assert.equal((f.wb as any).nativeSyncState.size,0);
    await fs.appendFile(nativePath,JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'仅桌面继续'}})+'\n');
    process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE='unused';
    const storage=await prepareCodexStorage(f.wb.store.root,s,f.desktop);
    assert.equal(storage.sharedEndpoint,undefined);assert.equal(storage.resumePath,s.nativePath);
    assert.notEqual(storage.resumePath,f.original.nativePath);assert.deepEqual(await fs.readFile(storage.resumePath!),content);
    assert.equal(f.opened(),0);
  }finally{if(bridge===undefined)delete process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE;else process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE=bridge;await f.close();}
});

test('turning sync back on publishes the frozen branch without overwriting later desktop work or opening a window',async()=>{
  const f=await fixture();try{
    await f.wb.syncCodexDesktop(f.session.id);const desktopPath=f.session.nativePath;
    await f.wb.disableCodexDesktop(f.session.id);
    await fs.appendFile(desktopPath!,JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'desktop only'}})+'\n');
    await f.wb.syncCodexDesktop(f.session.id);
    assert.equal(f.session.codexDesktop,true);assert.equal(f.session.codexPrivateFork,undefined);
    assert.notEqual(f.session.nativePath,desktopPath);assert.notEqual(f.session.nativeId,f.original.nativeId);assert.equal(f.opened(),0);
    assert.match(await fs.readFile(desktopPath!,'utf8'),/desktop only/);assert.doesNotMatch(await fs.readFile(f.session.nativePath!,'utf8'),/desktop only/);
    assert.equal(await fs.readFile(f.session.nativePath!,'utf8'),history(f.session.nativeId!));
  }finally{await f.close();}
});

test('busy or remote sessions cannot be detached, and pending sync can be cancelled through the same setting',async()=>{
  const f=await fixture();try{
    f.session.codexDesktop=true;
    for(const status of ['starting','running','approval'] as const){f.session.status=status;await assert.rejects(f.wb.disableCodexDesktop(f.session.id),/结束后再关闭/);assert.equal(f.session.codexDesktop,true);}
    f.session.status='idle';f.session.codexRemote={hostId:'remote',hostName:'remote',cwd:'/work',nativePath:'/file',home:'/home'};
    await assert.rejects(f.wb.disableCodexDesktop(f.session.id),/本机 Codex/);delete f.session.codexRemote;delete f.session.codexDesktop;
    f.setReady(false);await f.wb.syncCodexDesktop(f.session.id);await f.wb.disableCodexDesktop(f.session.id);f.setReady(true);
    await (f.wb as any).drainDeferredCodexSync();assert.equal(f.session.codexSyncRequest,undefined);assert.equal(f.counts().starts,0);
  }finally{await f.close();}
});

test('missing, partial, mismatched or active native records prevent detaching without discarding history',async()=>{
  const f=await fixture();try{
    await f.wb.syncCodexDesktop(f.session.id);const file=f.session.nativePath!,content=await fs.readFile(file,'utf8');
    await fs.rm(file);await assert.rejects(f.wb.disableCodexDesktop(f.session.id),/完整的 Codex/);
    for(const [invalid,pattern] of [[content+'{',/尚未完整保存/],[history(randomUUID()),/标识不一致/],[content+JSON.stringify({type:'event_msg',payload:{type:'task_started'}})+'\n',/回复尚未结束/]] as const){
      await fs.writeFile(file,invalid);await assert.rejects(f.wb.disableCodexDesktop(f.session.id),pattern);
      assert.equal(f.session.codexDesktop,true);assert.equal(f.session.nativePath,file);assert.deepEqual(f.session.messages,f.original.messages);
    }
    await fs.writeFile(file,content);await f.wb.disableCodexDesktop(f.session.id);assert.equal(f.session.codexDesktop,undefined);
  }finally{await f.close();}
});

test('failed disable persistence restores the sync preference and retains drafts for retry',async()=>{
  const f=await fixture(),save=f.wb.store.save.bind(f.wb.store);let fail=true;
  try{
    await f.wb.syncCodexDesktop(f.session.id);const file=f.session.nativePath;
    f.wb.store.save=async()=>{if(fail){fail=false;throw Error('disk unavailable');}return save();};
    await assert.rejects(f.wb.disableCodexDesktop(f.session.id),/disk unavailable/);
    assert.equal(f.session.codexDesktop,true);assert.equal(f.session.nativePath,file);assert.equal(f.session.codexPrivateFork,undefined);
    assert.equal(f.wb.store.inputs[f.session.id].text,'未发送的草稿');
    await f.wb.disableCodexDesktop(f.session.id);assert.equal(f.session.codexDesktop,undefined);
  }finally{f.wb.store.save=save;await f.close();}
});

test('desktop sync switch stays available after missing-desktop errors and is disabled during a reply',()=>{
  const s={provider:'codex',purpose:'work',status:'error',codexDesktop:true,error:'尚未安装 Codex 桌面版'} as AgentSession;
  const render=()=>renderSyncFrame(s);
  assert.match(render(),/role="switch"[^>]*aria-checked="true"/);assert.doesNotMatch(render().match(/<button[^>]*role="switch"[^>]*>/)![0],/disabled/);
  s.status='running';assert.match(render().match(/<button[^>]*role="switch"[^>]*>/)![0],/disabled/);assert.match(render(),/当前操作结束后/);
  s.status='idle';delete s.codexDesktop;assert.match(render(),/aria-checked="false"/);
  s.desktopSyncState='connecting';assert.match(render().match(/<button[^>]*role="switch"[^>]*>/)![0],/disabled/);delete s.desktopSyncState;
  assert.match(renderSyncFrame(s,true).match(/<button[^>]*role="switch"[^>]*>/)![0],/disabled/);
  s.codexRemote={hostId:'remote'} as any;assert.doesNotMatch(render(),/role="switch"/);
});

test('composer ring distinguishes actual sync from enabled, queued, disconnected and independent sessions without changing its draft',()=>{
  const s={provider:'codex',purpose:'work',status:'idle'} as AgentSession;
  const render=()=>{const html=renderSyncFrame(s);assert.match(html,/<textarea>未发送的草稿<\/textarea>/);return html;};
  assert.match(render(),/非同步会话/);
  s.nativeLive=true;assert.match(render(),/非同步会话/); // A native import alone is not a shared connection.
  s.codexDesktop=true;assert.match(render(),/同步待连接/);assert.doesNotMatch(render(),/data-state="connected"/);
  s.desktopSyncState='connecting';assert.match(render(),/同步连接中/);
  s.desktopSyncState='connected';assert.match(render(),/data-state="connected"/);assert.match(render(),/同步会话/);
  s.desktopSyncPending=true;assert.match(render(),/补齐记录中/);assert.doesNotMatch(render(),/data-state="connected"/);
  s.desktopSyncState='disconnected';assert.match(render(),/同步已断开/);delete s.desktopSyncPending;
  delete s.codexDesktop;s.codexSyncRequest={requestedAt:'now'};assert.match(render(),/同步待连接/);
  s.codexSyncRequest.error='退出桌面版后重试';assert.match(render(),/同步待处理/);
  delete s.codexSyncRequest;s.desktopSyncState='connected';assert.match(render(),/非同步会话/);
  s.codexRemote={hostName:'远程主机'} as any;assert.match(render(),/data-state="connected"/);assert.match(render(),/远程主机/);
  delete s.codexRemote;s.provider='cursor';s.cursorNative={managed:true,descriptorFile:'fixture'};assert.match(render(),/仅查看/);assert.doesNotMatch(render(),/data-state="connected"/);
  s.cursorNative.transport='ide-files-v1';assert.match(render(),/同步会话/);
  s.closedAt='closed';assert.equal(render(),'<textarea>未发送的草稿</textarea>');
});

test('composer ring replaces repeated sync status while preserving remote host and authorization reminders',()=>{
  const s={provider:'codex',purpose:'work',status:'idle',codexDesktop:true,desktopSyncState:'connected'} as AgentSession;
  const render=()=>renderToStaticMarkup(React.createElement(NativeDesktopStatus,{session:s,detailsOnly:true}));
  assert.equal(render(),'');s.desktopWaitingApproval=true;assert.match(render(),/发起任务的窗口/);assert.doesNotMatch(render(),/同步中/);
  s.codexRemote={hostName:'远程主机',cwd:'/work'} as any;assert.match(render(),/远程主机/);
});

test('a native turn starting during detachment keeps its live state instead of being rolled back to idle',async()=>{
  const f=await fixture();try{
    await f.wb.syncCodexDesktop(f.session.id);
    Object.defineProperty(f.service,'sourceHome',{get(){f.session.status='running';return f.desktop;}});
    await assert.rejects(f.wb.disableCodexDesktop(f.session.id),/回复尚未结束/);
    assert.equal(f.session.status,'running');assert.equal(f.session.codexDesktop,true);
    assert((f.wb as any).runtimes.has(f.session.id));
  }finally{await f.close();}
});

test('persisting a sync change excludes concurrent sends and close while retaining the input queue',async()=>{
  const f=await fixture(),save=f.wb.store.save.bind(f.wb.store);
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let job:Promise<unknown>|undefined;
  try{
    await f.wb.syncCodexDesktop(f.session.id);
    const input={text:'排队内容',sourceIds:[],answers:{}};
    f.session.inputQueue={items:[{id:randomUUID(),input,state:'queued'}],paused:false};
    f.wb.store.save=async()=>{entered();await gate;await save();};
    job=f.wb.disableCodexDesktop(f.session.id);await started;
    await assert.rejects(f.wb.send(f.session.id,'不能抢占'),/正在同步/);
    await assert.rejects(f.wb.closeSession(f.session.id),/正在同步/);
    await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/结束后再同步/);
    f.wb.store.inputs[f.session.id].text='切换时编辑的草稿';
    release();await job;
    assert.equal(f.session.inputQueue.items[0].input.text,'排队内容');assert.equal(f.session.inputQueue.items[0].state,'queued');
    assert.equal(f.wb.store.inputs[f.session.id].text,'切换时编辑的草稿');
  }finally{release();await job?.catch(()=>{});f.wb.store.save=save;await f.close();}
});
