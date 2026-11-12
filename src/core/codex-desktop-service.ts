import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import * as asar from '@electron/asar';
import { userDesktopAppOpen } from './desktop-app-open';
import { privateBridgeDirectory, installedCodexDesktopExecutable, readBackendRecord } from './codex-shared-backend';
import { processAlive, sameProcess } from './codex-process';
import { sameNativePath } from './native-transcript';
import { findCodexRollout, type CodexStorage } from './codex-storage';
import type { CodexDesktopBridge } from './codex-desktop-bridge';
import type { AgentSession } from '../shared/types';
import { runtimeAssets } from '../shared/runtime-assets';
import { prepareDesktopRollout } from './native-publish';

const run = promisify(execFile), pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export interface CodexDesktopTarget { app: string; executable: string; archive?: string }
export interface CodexDesktopOpenOptions { ifClosed?: boolean }
export function supportsCodexDesktopBridge(archive: string) {
  const scripts = asar.listPackage(archive, { isPack: false })
    .filter(file => /\.[cm]?js$/i.test(file));
  // The desktop build may rename or move the startup bundle between releases.
  // Check the bundled JavaScript for the actual entry point, not one filename.
  scripts.sort((a, b) => Number(/application-network-startup/i.test(b)) - Number(/application-network-startup/i.test(a)));
  return scripts.some(file => asar.extractFile(archive, file.replace(/^[/\\]/, '')).includes('CODEX_APP_SERVER_WS_URL'));
}
export class CodexDesktopRestartRequired extends Error {
  constructor() { super('Codex 当前以普通方式运行。首次联动请保存工作并退出 Codex，再重试；不会自动关闭你的聊天'); }
}
export interface CodexDesktopIntegration {
  readonly sourceHome?: string;
  readyToPrepare(): Promise<boolean>;
  prepare(session: AgentSession, privateHome: string, env: NodeJS.ProcessEnv): Promise<{ nativeId?: string; nativePath?: string }>;
  storage(session: AgentSession, executable: string, env: NodeJS.ProcessEnv): Promise<CodexStorage>;
  open(session: AgentSession, executable: string, env: NodeJS.ProcessEnv, options?: CodexDesktopOpenOptions): Promise<void>;
}
export async function codexDesktopTarget(): Promise<CodexDesktopTarget> {
  if (process.platform !== 'win32') throw new Error('Codex 桌面联动暂仅支持 Windows');
  const { stdout } = await run('powershell.exe', ['-NoProfile','-NonInteractive','-Command', '(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation'], { windowsHide: true, timeout: 15000 });
  const root = stdout.trim();
  if (!root) throw new Error('尚未安装 Codex 桌面版。可点击输入框上的同步标签，关闭“与 Codex 桌面版同步”，使用本机 Codex CLI 继续对话');
  return { app: path.join(root,'app','ChatGPT.exe'), archive: path.join(root,'app','resources','app.asar'), executable: await installedCodexDesktopExecutable(path.join(root,'app','resources','codex.exe')) };
}
function codexDesktopRunning() {
  return userDesktopAppOpen('codex');
}
export function validateManagedBridge(value: CodexDesktopBridge, sourceHome: string, allowExpired = false) {
  let endpoint: URL; try { endpoint = new URL(value.endpoint); } catch { throw new Error('Codex 联动连接记录不可用'); }
  if(value.version!==1||endpoint.protocol!=='ws:'||endpoint.hostname!=='127.0.0.1'||!endpoint.port||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!/^\/rpc\/[a-f0-9]{64}$/.test(endpoint.pathname)||!sameNativePath(value.sourceHome,sourceHome)||!Number.isInteger(value.pid)||value.pid<=0||!Number.isFinite(Date.parse(value.expiresAt))||!allowExpired&&Date.parse(value.expiresAt)<=Date.now())throw new Error('Codex 联动连接已失效，请核对原生客户端后恢复同步');
}
function bridgeRequest(bridge: CodexDesktopBridge, operation: 'readyz' | 'renew') {
  const url = new URL(bridge.endpoint); url.protocol='http:';url.pathname+='/'+operation;
  return new Promise<boolean>(resolve => {
    // These authenticated loopback checks must stay direct even with NODE_USE_ENV_PROXY.
    const request = httpRequest(url, { method: operation === 'renew' ? 'POST' : 'GET', agent: false, signal: AbortSignal.timeout(operation === 'renew' ? 5000 : 2500) }, response => {
      response.on('error', () => resolve(false)); response.resume();
      resolve(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300);
    });
    request.on('error', () => resolve(false)); request.end();
  });
}
function ready(bridge: CodexDesktopBridge) {
  return bridgeRequest(bridge, 'readyz');
}
async function nativeDesktopConnected(bridge: CodexDesktopBridge, pid: number): Promise<boolean | undefined> {
  if (process.platform !== 'win32') return undefined;
  const port = Number(new URL(bridge.endpoint).port);
  // /readyz proves that the shared backend is alive, but not that this desktop
  // connected. Check which process owns the client side of its loopback socket.
  const command = `try { $clients = @(Get-NetTCPConnection -State Established -ErrorAction Stop | Where-Object { $_.RemoteAddress -eq '127.0.0.1' -and $_.RemotePort -eq ${port} -and $_.OwningProcess -eq ${pid} }); if ($clients.Count -gt 0) { 'connected' } else { 'disconnected' } } catch { 'unknown' }`;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 4000 });
    return stdout.trim() === 'connected' ? true : stdout.trim() === 'disconnected' ? false : undefined;
  } catch { return undefined; }
}
const jobs = new Map<string,Promise<CodexDesktopBridge>>();
const desktopJobs = new Map<string,Promise<void>>();
type Options = { sourceHome?: string; parent?: string; workerFile?: string; privateDirectory?: (parent:string) => Promise<string>; discover?: () => Promise<CodexDesktopTarget>; running?: () => Promise<boolean>; launchWorker?: (file:string,env:NodeJS.ProcessEnv) => Promise<void>; launchDesktop?: (target:CodexDesktopTarget,args:string[],env:NodeJS.ProcessEnv) => Promise<number|void>; desktopConnected?: (bridge:CodexDesktopBridge,pid:number) => Promise<boolean|undefined>; desktopConnectionTimeoutMs?: number };

/** Lazy, per-personal-profile service. Ordinary Workbench startup never calls ensure(). */
export class CodexDesktopService implements CodexDesktopIntegration {
  private recovery?: { directory: string; bridge: CodexDesktopBridge };
  readonly sourceHome: string;
  readonly parent: string;
  constructor(private options: Options = {}) {
    this.sourceHome = path.resolve(options.sourceHome || process.env.CODEX_HOME || path.join(os.homedir(),'.codex'));
    const base = path.join(process.env.LOCALAPPDATA || os.tmpdir(),'TeamAgentWorkbench','codex-desktop-beta');
    // Reuse the already verified legacy Beta backend for the default personal profile.
    this.parent = options.parent || (sameNativePath(this.sourceHome,path.join(os.homedir(),'.codex')) ? base : path.join(base,createHash('sha256').update(this.sourceHome.toLowerCase()).digest('hex').slice(0,24)));
  }
  private desktopConnected(bridge: CodexDesktopBridge, pid: number) {
    return (this.options.desktopConnected || nativeDesktopConnected)(bridge, pid);
  }
  private async waitForDesktop(bridge: CodexDesktopBridge, launchedPid: number, attachedPid?: number) {
    const deadline = Date.now() + (this.options.desktopConnectionTimeoutMs ?? 12000);
    let checked = false;
    do {
      if (processAlive(launchedPid) === true) {
        const connected = await this.desktopConnected(bridge, launchedPid);
        if (connected === true) return launchedPid;
        if (connected === undefined) return undefined;
        checked = true;
      }
      // Electron may forward a deep link to an existing linked window and exit.
      if (attachedPid && processAlive(attachedPid) === true) {
        const priorConnection = await this.desktopConnected(bridge, attachedPid);
        if (priorConnection === true) return attachedPid;
        if (priorConnection === undefined && processAlive(launchedPid) !== true) return undefined;
      }
      if (processAlive(launchedPid) !== true) break;
      await pause(250);
    } while (Date.now() < deadline);
    if (!checked && processAlive(launchedPid) !== true) {
      if (attachedPid) throw new Error('新的 Codex 窗口已退出，原窗口仍未连接本机共享后端。请退出 Codex 桌面版后重新点击“在 Codex 中打开”；共享会话已保留');
      throw new Error('Codex 桌面版启动后立即退出。共享会话已保留，请检查桌面版安装与启动日志后重试');
    }
    throw new Error('Codex 桌面版已启动，但未连接本机共享后端。请检查本机代理或网络软件对 127.0.0.1 的拦截，退出 Codex 桌面版后重新点击“在 Codex 中打开”；共享会话已保留');
  }
  private async active() {
    const activeFile = path.join(this.parent,'active.json');
    let record: {file:string; managed?: boolean};
    try { record=JSON.parse(await fs.readFile(activeFile,'utf8')); }
    catch(e:any){if(e.code==='ENOENT')return;throw new Error('Codex 联动后台记录不可用，请保留记录后检查');}
    const relative=typeof record.file==='string' ? path.relative(this.parent,record.file) : '..';
    if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Codex 联动后台记录不属于当前用户');
    let descriptor:CodexDesktopBridge;
    try { descriptor=JSON.parse(await fs.readFile(record.file,'utf8')); }
    catch(e:any){if(e.code==='ENOENT')return;throw new Error('Codex 联动后台记录不可用');}
    validateManagedBridge(descriptor,this.sourceHome,true);
    let healthy = await ready(descriptor);
    if (!healthy) for (const delay of [150, 350]) { await pause(delay); if (await ready(descriptor)) { healthy = true; break; } }
    if (!healthy) {
      const managerAlive = descriptor.process ? await sameProcess(descriptor.process) : processAlive(descriptor.pid);
      if (managerAlive !== false) throw new Error('连接暂时中断，请恢复同步；会话和输入已保留，不会重复发送任务');
      if (!record.managed) throw new Error('无法核对原后台，已保留会话与连接记录');
      await readBackendRecord(path.dirname(record.file),descriptor);
      this.recovery = { directory: path.dirname(record.file), bridge: descriptor }; return;
    }
    if (descriptor.approvalRoutingVersion !== 1) throw new Error('联动后台需要更新。请结束当前任务、保存并退出 Codex，再从工作台恢复同步');
    if (Date.parse(descriptor.expiresAt) <= Date.now()) {
      if (!await bridgeRequest(descriptor, 'renew')) throw new Error('连接已到期，请恢复同步；原会话和正在运行的任务保留');
      descriptor=JSON.parse(await fs.readFile(record.file,'utf8')); validateManagedBridge(descriptor,this.sourceHome);
    }
    this.recovery = undefined; return descriptor;
  }
  async ensure(env:NodeJS.ProcessEnv={}):Promise<CodexDesktopBridge> {
    const key=path.resolve(this.parent).toLowerCase();
    const previous=jobs.get(key);if(previous)return previous;
    const job=this.establish(env);jobs.set(key,job);
    try{return await job;}finally{if(jobs.get(key)===job)jobs.delete(key);}
  }
  /** Readiness only: never launches, closes, or writes a native conversation. */
  async readyToPrepare() {
    const existing = await this.active();
    if (!await (this.options.running || codexDesktopRunning)()) return true;
    if (!existing) return false;
    const record = JSON.parse(await fs.readFile(path.join(this.parent, 'active.json'), 'utf8'));
    const attachment = await fs.readFile(path.join(path.dirname(record.file), 'desktop.json'), 'utf8').then(JSON.parse).catch(() => undefined);
    if (attachment?.endpointHash !== createHash('sha256').update(existing.endpoint).digest('hex') || processAlive(attachment.pid) !== true) return false;
    return await this.desktopConnected(existing, attachment.pid) !== false;
  }
  private async establish(env:NodeJS.ProcessEnv) {
    const existing=await this.active();if(existing)return existing;
    await fs.mkdir(this.parent,{recursive:true});
    const lockFile=path.join(this.parent,'launch.lock'),nonce=randomUUID(),deadline=Date.now()+45000;
    let lock;
    while(Date.now()<deadline){
      try{lock=await fs.open(lockFile,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,nonce,at:Date.now()}));break;}
      catch(e:any){
        if(e.code!=='EEXIST')throw e;
        const current=await this.active();if(current)return current;
        try{
          const saved=JSON.parse(await fs.readFile(lockFile,'utf8'));let alive=true;try{process.kill(saved.pid,0);}catch{alive=false;}
          // Once a worker might exist, only its published registry or an explicit
          // failed-start record can justify recovery. A dead UI is not proof.
          const relative=saved.directory&&path.relative(this.parent,saved.directory);
          const owned=relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);
          const failed=owned&&await fs.stat(path.join(saved.directory,'failed.txt')).catch(()=>undefined);
          if(!alive&&Date.now()-saved.at>5000&&(!saved.directory||failed)) {
            const reaperFile=lockFile+'.reap';let reaper;
            try{reaper=await fs.open(reaperFile,'wx',0o600);
              const latest=JSON.parse(await fs.readFile(lockFile,'utf8'));
              if(latest.nonce===saved.nonce)await fs.rm(lockFile,{force:true});
            }catch(e:any){if(e.code!=='EEXIST'&&e.code!=='ENOENT')throw e;}
            finally{if(reaper){await reaper.close();await fs.rm(reaperFile,{force:true});}}
            continue;
          }
        }catch{}
        await pause(150);
      }
    }
    if(!lock)throw new Error('Codex 后台仍在启动，请稍后重试；输入已保留');
    try {
      const prior=await this.active();if(prior)return prior;
      // Never close a user's desktop or create another writer beside its ordinary backend.
      const recovery=this.recovery;
      if(await (this.options.running||codexDesktopRunning)()) {
        const attachment=recovery&&await fs.readFile(path.join(recovery.directory,'desktop.json'),'utf8').then(JSON.parse).catch(()=>undefined);
        if(!attachment || attachment.endpointHash!==createHash('sha256').update(recovery!.bridge.endpoint).digest('hex') || processAlive(attachment.pid)!==true) throw new CodexDesktopRestartRequired();
      }
      const target=await (this.options.discover||codexDesktopTarget)();
      const directory=recovery?.directory||await(this.options.privateDirectory||privateBridgeDirectory)(this.parent),inputFile=path.join(directory,'input.json');
      if(recovery)await fs.rm(path.join(directory,'failed.txt'),{force:true});
      await fs.writeFile(lockFile,JSON.stringify({pid:process.pid,nonce,at:Date.now(),directory}),{mode:0o600});
      await fs.writeFile(inputFile,JSON.stringify({executable:target.executable,sourceHome:this.sourceHome,cwd:this.sourceHome,stateDirectory:directory,registryFile:path.join(this.parent,'active.json'),...(recovery?{recover:true}: {})}),{mode:0o600});
      await fs.mkdir(this.sourceHome,{recursive:true});
      const worker=this.options.workerFile || path.join(__dirname,runtimeAssets,'codex-desktop-worker.cjs');
      if(this.options.launchWorker)await this.options.launchWorker(inputFile,env);
      else {
        await fs.access(worker);
        const child=spawn(process.execPath,[worker,inputFile],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,...env,ELECTRON_RUN_AS_NODE:process.versions.electron?'1':undefined,CODEX_APP_SERVER_WS_URL:undefined,WORKBENCH_CODEX_DESKTOP_BRIDGE:undefined}});
        await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
      }
      const file=path.join(directory,'bridge.json');
      while(Date.now()<deadline){
        if(await fs.stat(path.join(directory,'failed.txt')).catch(()=>undefined))throw new Error('Codex 共享后台启动失败，请检查安装与本机网络；输入已保留');
        let bridge:CodexDesktopBridge|undefined;
        try{bridge=JSON.parse(await fs.readFile(file,'utf8'));}catch{}
        if(bridge){
          if (recovery && bridge.pid === recovery.bridge.pid && bridge.process?.startedAt === recovery.bridge.process?.startedAt) { await pause(150); continue; }
          validateManagedBridge(bridge,this.sourceHome);if(!await ready(bridge)){await pause(150);continue;}
          const temp=path.join(this.parent,'active.'+nonce+'.tmp');await fs.writeFile(temp,JSON.stringify({file,managed:true}),{mode:0o600});await fs.rename(temp,path.join(this.parent,'active.json'));return bridge;
        }
        await pause(150);
      }
      throw new Error('Codex 共享后台启动超时，请稍后重试；输入已保留');
    }finally{await lock.close();const saved=await fs.readFile(lockFile,'utf8').then(JSON.parse).catch(()=>undefined);if(saved?.nonce===nonce)await fs.rm(lockFile,{force:true});}
  }
  async prepare(session: AgentSession, privateHome: string, env: NodeJS.ProcessEnv) {
    // A desktop attached to our existing shared backend may remain open.
    if (!await this.readyToPrepare()) throw new CodexDesktopRestartRequired();
    await this.ensure(env);
    return prepareDesktopRollout(session, privateHome, this.sourceHome);
  }
  async storage(session:AgentSession,_executable:string,env:NodeJS.ProcessEnv) {
    if(session.provider!=='codex'||session.purpose!=='work'||!session.codexDesktop||session.networkRoute==='management')throw new Error('此会话不能使用 Codex 桌面联动；当前联动仅支持本机网络');
    const bridge=await this.ensure(env);
    const resumePath=session.nativeId&&await findCodexRollout(this.sourceHome,session.nativeId);
    if(session.nativeId&&!resumePath)throw new Error('原 Codex 会话记录未找到，已保留会话与输入；不会另建会话');
    return {home:this.sourceHome,sourceHome:this.sourceHome,args:[],env:{CODEX_HOME:this.sourceHome,CODEX_SQLITE_HOME:this.sourceHome},resumePath,sharedEndpoint:bridge.endpoint,sharedApprovalRouting:bridge.approvalRoutingVersion===1};
  }
  async open(session:AgentSession,_executable:string,env:NodeJS.ProcessEnv,options:CodexDesktopOpenOptions={}) {
    const key=path.resolve(this.parent).toLowerCase(),previous=desktopJobs.get(key)||Promise.resolve();
    const job=previous.catch(()=>{}).then(()=>this.openWindow(session,env,options));desktopJobs.set(key,job);
    try{await job;}finally{if(desktopJobs.get(key)===job)desktopJobs.delete(key);}
  }
  private async openWindow(session:AgentSession,env:NodeJS.ProcessEnv,options:CodexDesktopOpenOptions) {
    if(!session.codexDesktop||session.provider!=='codex'||session.networkRoute==='management')throw new Error('请先创建启用桌面联动的 Codex 会话');
    const bridge=await this.ensure(env);
    const record=await fs.readFile(path.join(this.parent,'active.json'),'utf8').then(JSON.parse);
    const attachment=record.managed&&await fs.readFile(path.join(path.dirname(record.file),'desktop.json'),'utf8').then(JSON.parse).catch(()=>undefined);
    const attachedPid=attachment?.endpointHash===createHash('sha256').update(bridge.endpoint).digest('hex')&&processAlive(attachment.pid)===true ? attachment.pid as number : undefined;
    const running=await(this.options.running||codexDesktopRunning)();
    if(record.managed&&running&&!attachedPid)throw new CodexDesktopRestartRequired();
    const attachedConnection=attachedPid ? await this.desktopConnected(bridge,attachedPid) : undefined;
    if(attachedPid&&attachedConnection===false&&attachment?.connectionFailureAt)throw new Error('Codex 桌面版仍在运行，但没有连上本机共享后端。请先退出 Codex 桌面版，再点击“在 Codex 中打开”；共享会话和输入已保留');
    if(options.ifClosed&&attachedPid&&attachedConnection!==false)return;
    const target=await(this.options.discover||codexDesktopTarget)();
    if(target.archive&&!supportsCodexDesktopBridge(target.archive))throw new Error('当前 Codex 桌面版未检测到联动入口。请更新桌面版后重试；也可在输入框同步标签关闭“与 Codex 桌面版同步”，继续使用本机 Codex CLI');
    // The desktop connects to our loopback WebSocket. With NODE_USE_ENV_PROXY,
    // inherited corporate proxies can intercept that upgrade and return 504.
    const noProxy=[process.env.NO_PROXY,process.env.no_proxy,env.NO_PROXY,env.no_proxy,'127.0.0.1','localhost','::1'].filter(Boolean).join(',');
    const environment={...process.env,...env,NO_PROXY:noProxy,no_proxy:noProxy,CODEX_APP_SERVER_WS_URL:bridge.endpoint,CODEX_APP_SERVER_FORCE_CLI:undefined,ELECTRON_RUN_AS_NODE:undefined};
    const args=session.nativeId?['codex://threads/'+session.nativeId]:[];
    let launchedPid:number|void;
    if(this.options.launchDesktop)launchedPid=await this.options.launchDesktop(target,args,environment);
    else {const child=spawn(target.app,args,{detached:true,windowsHide:true,stdio:'ignore',env:environment});await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();launchedPid=child.pid;}
    let pid=attachedPid||launchedPid;
    if(typeof launchedPid==='number') {
      let verifiedPid: number | undefined;
      try { verifiedPid=await this.waitForDesktop(bridge,launchedPid,attachedPid); }
      catch(error) {
        await fs.writeFile(path.join(path.dirname(record.file),'desktop.json'),JSON.stringify({pid:launchedPid,endpointHash:createHash('sha256').update(bridge.endpoint).digest('hex'),connectionFailureAt:Date.now()}),{mode:0o600});
        throw error;
      }
      pid=verifiedPid||pid;
    }
    if(pid)await fs.writeFile(path.join(path.dirname(record.file),'desktop.json'),JSON.stringify({pid,endpointHash:createHash('sha256').update(bridge.endpoint).digest('hex')}),{mode:0o600});
  }
}
