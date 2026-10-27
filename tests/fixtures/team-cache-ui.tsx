import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SharedContentLibrary } from '../../src/renderer/shared-content';
import { TeamGroupDialog } from '../../src/renderer/team-groups';
import '../../src/renderer/styles.css';
const project = {id:'p1',name:'缓存项目',groupName:'g1',remoteRoot:'/projects/a',uploadPath:'/projects/a/upload',historyPath:'/projects/a/history'};
const result = {id:'11111111-1111-4111-8111-111111111111',kind:'contribution',title:'【探索记录】缓存成果',description:'缓存正文可以立即阅读',author:'alice',state:'submitted',category:'exploration',revision:1,updatedAt:'2026-10-27T01:00:00Z',createdAt:'2026-10-27T01:00:00Z',path:'/projects/a/result.md'};
const group = {id:'g1',label:'缓存项目',revision:'a'.repeat(64),creator:'alice',role:'member',members:[{username:'alice',name:'缓存成员',enabled:true,role:'creator'}],projects:[project],bytes:0};
let pending: {key:string;resolve:(value:any)=>void;reject:(error:Error)=>void}[]=[];
let cache=true;
const cached = (action:string) => action==='content.list' ? [result] : action==='content.history' ? [] : action==='group.details' ? group : undefined;
const api = {call:async(action:string,payload:any) => {
  if(action==='team.cache.read') { const value=cached(payload.action); return cache && value !== undefined ? {value,savedAt:'2026-10-27T01:00:00Z'} : undefined; }
  if(action==='conclusion.list') return [];
  if(action==='content.list'||action==='content.history'||action==='group.control') return new Promise((resolve,reject)=>pending.push({key:action==='group.control'?'group.'+payload.action:action,resolve,reject}));
  return true;
},subscribe:()=>()=>{}};
window.workbench=api as any;
(window as any).teamFixture={
  pending:()=>pending.map(item=>item.key),
  finish:(mode:'success'|'failure'|'revoked'|'deleted')=>{const items=pending;pending=[]; for(const item of items) { if(mode==='failure')item.reject(new Error('网络暂时不可用'));else if(mode==='revoked')item.reject(new Error('没有此项目的访问权限'));else item.resolve(mode==='deleted'&&item.key.startsWith('content.')?[]:cached(item.key)); }},
};
function App(){
  const [key,setKey]=useState(0),[members,setMembers]=useState(false);
  return <main style={{padding:20}}><div className="row"><button onClick={()=>setMembers(true)}>打开成员窗口</button><button onClick={()=>{cache=false;setKey(value=>value+1);}}>首次无缓存</button><button onClick={()=>{cache=true;setKey(value=>value+1);}}>使用缓存</button></div>
    <SharedContentLibrary key={key} project={project} username="alice" admin={false} aliases={{}} aliasSaved={async()=>{}} attach={async()=>{}} attachSessions={[]} notice={()=>{}} mergeSessions={[]} mergeStarted={()=>{}}/>
    {members&&<TeamGroupDialog groupId="g1" call={command=>api.call('group.control',command)} close={()=>setMembers(false)} changed={async()=>{}}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
