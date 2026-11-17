import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Module, { createRequire } from 'node:module';

test('startup log recovery reports filesystem and shell failures without losing the error window', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-startup-errors-')),dialogs:any[]=[],opened:string[]=[];
  const host={errors:[] as unknown[],dialog:{showMessageBox:async(options:any)=>{dialogs.push(options);return{response:dialogs.length===1?1:0};}},shell:{openPath:async(value:string)=>{opened.push(value);return'';}}};
  (globalThis as any).__startupErrorHost=host;
  try {
    const originalLoad=(Module as any)._load;
    (Module as any)._load=function(request:string,...args:unknown[]){
      if(request==='electron')return host;
      if(request==='../core/logging')return{logsFor:()=>({record(...values:unknown[]){host.errors.push(values);}}),accountLogScope:()=>({})};
      return originalLoad.call(this,request,...args);
    };
    let startup:typeof import('../src/main/startup-failure');
    try {startup=createRequire(import.meta.url)('../src/main/startup-failure.ts');}finally{(Module as any)._load=originalLoad;}
    for(const mode of ['read-denied','mkdir-denied','shell-failed','success']){
      dialogs.length=0;opened.length=0;
      const taskRoot=path.join(root,mode);await fs.mkdir(taskRoot);
      let mock:any;
      if(mode==='read-denied')mock=t.mock.method(fs,'lstat',async()=>{throw Object.assign(Error('EACCES: private path'),{code:'EACCES'});});
      if(mode==='mkdir-denied')mock=t.mock.method(fs,'mkdir',async()=>{throw Object.assign(Error('EACCES: private path'),{code:'EACCES'});});
      host.shell.openPath=async(value:string)=>{opened.push(value);return mode==='shell-failed'?'EACCES: shell raw diagnostic':'';};
      try { await assert.doesNotReject(()=>startup.showStartupFailure('工作台启动失败',Error('本地会话资料无法读取：EIO'),taskRoot)); }
      finally {mock?.mock.restore();}
      if(mode==='success'){assert.equal(dialogs.length,1);assert.equal(opened[0],path.join(taskRoot,'logs'));assert((await fs.stat(opened[0])).isDirectory());}
      else {assert.equal(dialogs.length,2);assert.equal(dialogs[1].title,'日志文件夹没有打开');assert.doesNotMatch(dialogs[1].message,/EACCES|private path|shell raw/);}
      if(mode!=='success')assert(host.errors.length>0);
    }
    assert.match(startup.startupFailureOptions('管理员版启动失败',Error('本地会话资料无法读取：EIO')).message,/管理配置/);
  } finally {t.mock.restoreAll();delete (globalThis as any).__startupErrorHost;assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('wb-startup-errors-'));await fs.rm(root,{recursive:true,force:true});}
});
