import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pruneTeamCache, readTeamCache, refreshTeamCache } from '../src/core/team-cache';
import { teamAccessRevoked } from '../src/shared/team-cache';
import { cachedTeamRead } from '../src/renderer/team-cache';
import { SftpConnection } from '../src/core/sftp';
import type { ConnectionProfile, Settings, WorkspaceAccess } from '../src/shared/types';

const request = { action: 'content.list', projectId: 'p1' } as const;
const profile = (): ConnectionProfile => ({ id: 'test', name: 'test', host: 'fixture.invalid', port: 22, username: 'alice', fingerprint: 'test-key', manifestPath: '', projects: [{ id:'p1', name:'A', groupName:'g1', remoteRoot:'/projects/a', uploadPath:'/projects/a/submissions/alice', historyPath:'/projects/a/trajectories/alice' }] });
async function fixture(run: (host: any) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-cache-'));
  const remote = { connected:true, profile:profile(), workspaces:[{ groupName:'g1', path:'/projects', canonicalPath:'/projects', canCreateProject:false }] as WorkspaceAccess[] };
  const settings: Settings = { connections:[], providerPaths:{codex:'',cursor:'',claude:''}, lastWorkspace:'', workspaceSnapshot:structuredClone({profile:remote.profile, workspaces:remote.workspaces}) };
  try { await run({store:{root,settings},remote}); } finally { await fs.rm(root,{recursive:true,force:true}); }
}
test('team cache persists offline and isolates endpoint, fingerprint, account and project', () => fixture(async host => {
  await refreshTeamCache(host, request, async () => ['cached']);
  assert.deepEqual((await readTeamCache(host, request))?.value, ['cached']);
  host.remote.connected=false; host.remote.profile=undefined;
  assert.deepEqual((await readTeamCache(host, request))?.value, ['cached']);
  host.remote.connected=true;
  for (const changed of [{username:'bob'}, {host:'other.invalid'}, {fingerprint:'other-key'}, {port:2222}]) {
    host.remote.profile={...profile(),...changed}; assert.equal(await readTeamCache(host,request),undefined);
  }
  host.remote.profile=profile(); assert.equal(await readTeamCache(host,{...request,projectId:'other'}),undefined);
}));
test('fresh empty data replaces deleted records; transport failures preserve cache; confirmed revoked access clears it', () => fixture(async host => {
  await refreshTeamCache(host,request,async()=>['old']);
  for (const message of ['network timeout','Permission denied (publickey)','remote helper not found','远端路径不存在，请核对管理员提供的 SFTP 路径','团队成果清单不存在']) {
    await assert.rejects(refreshTeamCache(host,request,async()=>{throw new Error(message);}));
    assert.deepEqual((await readTeamCache(host,request))?.value,['old']);
  }
  await refreshTeamCache(host,request,async()=>[]); assert.deepEqual((await readTeamCache(host,request))?.value,[]);
  await assert.rejects(refreshTeamCache(host,request,async()=>{throw new Error('没有此项目的访问权限');}));
  assert.equal(await readTeamCache(host,request),undefined);
}));
test('late reads never overwrite newer snapshots or cross an account switch', () => fixture(async host => {
  let resolve!:(value:string[])=>void;
  const first=refreshTeamCache(host,request,()=>new Promise<string[]>(done=>{resolve=done;}));
  await refreshTeamCache(host,request,async()=>['new']); resolve(['old']); await first;
  assert.deepEqual((await readTeamCache(host,request))?.value,['new']);
  const second=refreshTeamCache(host,request,()=>new Promise<string[]>(done=>{resolve=done;}));
  host.remote.profile={...profile(),username:'bob'}; resolve(['alice private']); await second;
  assert.equal(await readTeamCache(host,request),undefined);
}));
test('successful membership refresh removes obsolete project and group caches permanently', () => fixture(async host => {
  await refreshTeamCache(host,request,async()=>['project']);
  await refreshTeamCache(host,{action:'group.details',group:'g1'},async()=>({members:['alice']}));
  host.remote.profile.projects=[]; host.remote.workspaces=[];
  await pruneTeamCache(host);
  // An old retained local project snapshot must not resurrect the old cache on restart.
  host.remote.profile=undefined; host.remote.connected=false;
  assert.equal(await readTeamCache(host,request),undefined);
  assert.equal(await readTeamCache(host,{action:'group.details',group:'g1'}),undefined);
}));
test('known team access with unavailable storage preserves its display cache', () => fixture(async host => {
  await refreshTeamCache(host,request,async()=>['retained']);
  host.remote.profile.projects=[]; host.remote.workspaces[0].accessError='远端路径不存在';
  await pruneTeamCache(host);
  assert.deepEqual((await readTeamCache(host,request))?.value,['retained']);
  host.remote.workspaces=[];await pruneTeamCache(host);
  assert.equal(await readTeamCache(host,request),undefined);
}));
test('aggregate member cards are invalidated when known team access changes', () => fixture(async host => {
  await refreshTeamCache(host,{action:'directions.list'},async()=>({members:['private member']}));
  assert.deepEqual((await readTeamCache(host,{action:'directions.list'}))?.value,{members:['private member']});
  host.remote.profile.projects=[]; host.remote.workspaces=[];
  assert.equal(await readTeamCache(host,{action:'directions.list'}),undefined);
  await pruneTeamCache(host); host.remote.profile=undefined;host.remote.connected=false;
  assert.equal(await readTeamCache(host,{action:'directions.list'}),undefined);
}));
test('confirmed role downgrade invalidates privileged group and assignment caches', () => fixture(async host => {
  host.remote.workspaces[0].role='creator';
  const requests=[{action:'group.details',group:'g1'},{action:'group.directory',group:'g1'},{action:'assignment.list',projectId:'p1'},{action:'assignment.members',projectId:'p1'}];
  for(const query of requests)await refreshTeamCache(host,query,async()=>['privileged']);
  host.remote.workspaces[0].role='member';
  for(const query of requests)assert.equal(await readTeamCache(host,query),undefined);
  await pruneTeamCache(host);
  host.remote.workspaces[0].role='creator';
  for(const query of requests)assert.equal(await readTeamCache(host,query),undefined);
}));
test('renderer shows cache before delayed refresh and retains it on transport failure', async () => {
  const updates:any[]=[]; let reject!:(error:Error)=>void;
  const api={call:async<T>(action:string):Promise<T>=> action==='team.cache.read' ? {value:['old'],savedAt:'now'} as T : new Promise<T>((_done,fail)=>{reject=fail;})};
  const loading=cachedTeamRead<string[]>(api,request,(value,cached)=>updates.push({value,cached}));
  await new Promise(done=>setImmediate(done)); assert.deepEqual([...updates],[{value:['old'],cached:true}]);
  reject(new Error('network timeout')); await assert.rejects(loading); assert.equal(updates.length,1);
  const revoked=cachedTeamRead<string[]>(api,request,(value,cached)=>updates.push({value,cached}));
  await new Promise(done=>setImmediate(done)); reject(new Error('没有此项目的访问权限')); await assert.rejects(revoked);
  assert.deepEqual(updates.at(-1),{value:undefined,cached:false});
});
test('manifest refresh retains last project list on transport failure but drops confirmed revoked access', async () => {
  const connection=new SftpConnection(()=>{}); const fake=connection as any;
  fake.profile=profile(); fake.channel=()=>({}); fake.assignedWorkspaces=async()=>{throw new Error('network timeout');};
  await assert.rejects(connection.discoverProjects(),/network/); assert.equal(connection.profile!.projects.length,1);
  fake.assignedWorkspaces=async()=>{throw new Error('当前账号未启用或不属于此团队，请联系管理员');};
  await assert.rejects(connection.discoverProjects(),/未启用/); assert.equal(connection.profile!.projects.length,0);
  assert.equal(teamAccessRevoked(new Error('远端路径不存在')),false);
});
