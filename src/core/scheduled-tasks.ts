import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentSession } from '../shared/types';
import { activeScheduledRun, nextScheduledTime, scheduledTaskInputSchema, type ScheduledTask, type ScheduledTaskInput, type ScheduledRun, type ScheduledRunSession } from '../shared/scheduled-task';
import { transcriptPageSize, type TranscriptPage } from '../shared/transcript-page';
import { atomicJson } from './store';
import { freezeFile, hashFile } from './artifacts';
import { processAlive, processIdentity, sameProcess, type ProcessIdentity } from './codex-process';
import { mentionedFiles } from './session-files';

interface Host {
  resolve(projectId: string, taskId: string): Promise<{ cwd: string; projectName: string; followsDirectory: boolean }>;
  prepare(task: ScheduledTask, run: ScheduledRun): Promise<AgentSession>;
  execute(task: ScheduledTask, run: ScheduledRun, session: AgentSession): Promise<void>;
  session(id: string): AgentSession | undefined;
  unload(session: AgentSession): Promise<void>;
  restore(session: AgentSession): Promise<AgentSession>;
  stop(id: string): Promise<void>;
  changed(): void;
  notice(text: string): void;
}

/** A single, account-local writer. Schedules and histories never enter account sync. */
export class ScheduledTasks {
  private tasks: ScheduledTask[] = [];
  private records: ScheduledRun[] = [];
  private serial: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private suspended = false;
  private running?: Promise<void>;
  private lastTick: number;
  private lockNonce?: string;
  private started = false;
  private staged = new Map<string, import('../shared/types').SourceFile>();
  private stopping = new Set<string>();
  readonly root: string;
  constructor(root: string, private host: Host, private now = Date.now) { this.root = path.join(root, 'scheduled-tasks'); this.lastTick = now(); }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> { const job = this.serial.catch(() => {}).then(fn); this.serial = job; return job; }
  private stamp() { return new Date(this.now()).toISOString(); }
  private runDir(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('运行记录标识无效'); return path.join(this.root, 'runs', id); }
  private task(id: string) { const task = this.tasks.find(item => item.id === id && !item.deletedAt); if (!task) throw Error('定时任务已不存在'); return task; }
  private record(id: string) { const run = this.records.find(item => item.id === id); if (!run) throw Error('运行记录已不存在'); return run; }
  private async save() { await atomicJson(path.join(this.root, 'index.json'), { version: 1, tasks: this.tasks, runs: this.records }); this.host.changed(); }
  async init(startTimer = true) {
    await fs.mkdir(this.root, { recursive: true });
    const lock = path.join(this.root, 'scheduler.lock');
    const claim = async () => { const handle = await fs.open(lock, 'wx', 0o600); this.lockNonce = randomUUID(); try { const identity = await processIdentity(process.pid).catch(() => undefined); await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: this.lockNonce, process: identity })); } finally { await handle.close(); } };
    try { await claim(); }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      let prior: { pid: number; nonce: string; process?: ProcessIdentity };
      try { prior = JSON.parse(await fs.readFile(lock, 'utf8')); } catch { throw Error('定时任务锁无法核对，请检查本机后台进程'); }
      if ((prior.process ? await sameProcess(prior.process) : processAlive(prior.pid)) !== false) throw Error('此账号已有定时任务后台正在运行');
      const reap = await fs.open(lock + '.recover', 'wx', 0o600);
      try { if (JSON.parse(await fs.readFile(lock, 'utf8')).nonce !== prior.nonce) throw Error('定时任务后台已改变'); await fs.unlink(lock); await claim(); }
      finally { await reap.close(); await fs.unlink(lock + '.recover').catch(() => {}); }
    }
    try {
      let data: { version: number; tasks: ScheduledTask[]; runs: ScheduledRun[] };
      try { data = JSON.parse(await fs.readFile(path.join(this.root, 'index.json'), 'utf8')); }
      catch (error: any) { if (error.code !== 'ENOENT') throw Error('定时任务记录无法读取，原文件已保留'); data = { version: 1, tasks: [], runs: [] }; }
      if (data.version !== 1 || !Array.isArray(data.tasks) || !Array.isArray(data.runs)) throw Error('定时任务记录格式无效');
      for (const task of data.tasks) { scheduledTaskInputSchema.parse(task); if (!/^[a-f0-9-]{36}$/.test(task.id)) throw Error('定时任务标识无效'); }
      for (const run of data.runs) { this.runDir(run.id); if (!/^[a-f0-9-]{36}$/.test(run.sessionId)) throw Error('运行会话标识无效'); }
      this.tasks = data.tasks; this.records = data.runs;
      for (const run of this.records.filter(activeScheduledRun)) {
        run.status = 'interrupted'; run.error = '工作台退出时任务未完成，未自动重放；可核对已有结果后立即执行。'; run.finishedAt = this.stamp();
        const session = this.host.session(run.sessionId);
        if (session) { session.status = 'error'; session.error = run.error; await this.snapshot(run, session); await this.host.unload(session); }
      }
      // A crash after the terminal receipt but before unloading must not restore
      // a second, ordinary copy of the completed automatic conversation.
      for (const run of this.records.filter(run => !activeScheduledRun(run) && !run.continued)) {
        const session = this.host.session(run.sessionId);
        if (session?.scheduledRun?.managed) { await this.snapshot(run, session); await this.host.unload(session); }
      }
      for (const task of this.tasks) task.nextRunAt = !task.paused && !task.deletedAt ? nextScheduledTime(task.schedule, this.now()) : undefined;
      this.lastTick = this.now(); this.started = true; await this.save();
      if (startTimer) { this.timer = setInterval(() => void this.tick().catch(error => this.host.notice('定时任务后台：' + error.message)), 1000); this.timer.unref(); }
    } catch (error) { await this.release(); throw error; }
  }
  list(projectId?: string) { return structuredClone(this.tasks.filter(task => !task.deletedAt && (!projectId || task.projectId === projectId)).map(task => { const run = this.records.find(run => run.taskId === task.id && activeScheduledRun(run)); return { ...task, activeRun: run ? { id: run.id, status: run.status } : undefined }; })); }
  ownsTask(id: string) { return this.tasks.some(task => task.id === id); }
  ownsRun(id: string) { return this.records.some(run => run.id === id); }
  ownsSession(id: string) { return this.records.some(run => run.sessionId === id); }
  async sessionForFiles(id: string) { const run = this.records.find(run => run.sessionId === id); if (!run) throw Error('任务会话已不存在'); return (await this.open(run.id)).session; }
  get activeCount() { return this.records.filter(activeScheduledRun).length; }
  async saveTask(input: ScheduledTaskInput, id?: string) { return this.enqueue(async () => {
    const parsed = scheduledTaskInputSchema.parse(input), prior = id ? this.task(id) : undefined;
    if (prior && prior.projectId !== parsed.projectId) throw Error('已有任务不能更换项目，请在目标项目新建');
    if (parsed.schedule.kind === 'once' && Date.parse(parsed.schedule.at) <= this.now() && (!prior || JSON.stringify(parsed.schedule) !== JSON.stringify(prior.schedule))) throw Error('单次任务请选择未来时间');
    const taskId = prior?.id || randomUUID(), location = await this.host.resolve(parsed.projectId, taskId);
    const available = new Map([...(prior?.sources || []), ...this.staged.values()].map(source => [source.id, source]));
    const sources = parsed.sourceIds.map(id => { const source = available.get(id); if (!source) throw Error('附件已不可用，请重新添加'); return source; });
    for (const source of sources) if (await hashFile(source.localPath) !== source.sha256) throw Error('附件已变化，请重新添加：' + source.name);
    const task: ScheduledTask = { ...parsed, ...location, id: taskId, createdAt: prior?.createdAt || this.stamp(), updatedAt: this.stamp(), paused: prior?.paused || false, sources };
    task.nextRunAt = task.paused ? undefined : nextScheduledTime(task.schedule, this.now());
    if (prior) this.tasks.splice(this.tasks.indexOf(prior), 1, task); else this.tasks.unshift(task);
    await this.save(); return structuredClone(task);
  }); }
  async stage(files: string[]) {
    const sources = [];
    for (const file of files) { const source = await freezeFile(file, path.join(this.root, 'attachments', randomUUID())); this.staged.set(source.id, source); sources.push(source); }
    return sources;
  }
  async attachments(id: string, files: string[], removeId?: string) { return this.enqueue(async () => {
    const task = this.task(id);
    const additions = [];
    for (const file of files) additions.push(await freezeFile(file, path.join(this.root, 'attachments', id)));
    task.sources = [...task.sources.filter(source => source.id !== removeId), ...additions]; task.updatedAt = this.stamp(); await this.save(); return structuredClone(task);
  }); }
  async pause(id: string, paused: boolean) { return this.enqueue(async () => { const task = this.task(id); task.paused = paused; task.nextRunAt = paused ? undefined : nextScheduledTime(task.schedule, this.now()); task.updatedAt = this.stamp(); await this.save(); }); }
  async remove(id: string, deleteHistory = false) { return this.enqueue(async () => {
    const task = this.task(id);
    if (deleteHistory && this.records.some(run => run.taskId === id && activeScheduledRun(run))) throw Error('请先停止正在运行的记录');
    if (deleteHistory) await this.removeRecords(this.records.filter(run => run.taskId === id).map(run => run.id));
    for (const run of this.records.filter(run => run.taskId === id && run.status === 'queued')) { run.status = 'stopped'; run.finishedAt = this.stamp(); }
    task.deletedAt = this.stamp(); task.paused = true; task.nextRunAt = undefined; await this.save();
  }); }
  runs(projectId?: string, taskId?: string, offset = 0, limit = 30) {
    const records = this.records.filter(run => (!projectId || run.projectId === projectId) && (!taskId || run.taskId === taskId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { items: structuredClone(records.slice(offset, offset + limit)), total: records.length };
  }
  private async queue(task: ScheduledTask, manual: boolean, scheduledAt: string) {
    if (this.records.some(run => run.taskId === task.id && activeScheduledRun(run))) throw Error('此任务已有排队、运行或等待处理的记录');
    const run: ScheduledRun = { id: randomUUID(), sessionId: randomUUID(), taskId: task.id, taskName: task.name, projectId: task.projectId, projectName: task.projectName, scheduledAt, manual, createdAt: this.stamp(), status: 'queued' };
    this.records.unshift(run); await this.save(); return structuredClone(run);
  }
  async runNow(id: string) { const run = await this.enqueue(() => { if (this.stopped) throw Error('工作台正在退出'); return this.queue(this.task(id), true, this.stamp()); }); this.pump(); return run; }
  async tick() {
    if (!this.started || this.stopped || this.suspended) return;
    await this.enqueue(async () => {
      const now = this.now(), missed = now - this.lastTick > 60000 || now < this.lastTick; this.lastTick = now;
      for (const task of this.tasks) {
        if (task.paused || task.deletedAt || !task.nextRunAt || Date.parse(task.nextRunAt) > now) continue;
        const scheduledAt = task.nextRunAt; task.nextRunAt = nextScheduledTime(task.schedule, now);
        if (!missed && !this.records.some(run => run.taskId === task.id && activeScheduledRun(run))) await this.queue(task, false, scheduledAt);
        else await this.save();
      }
      for (const run of this.records.filter(activeScheduledRun)) {
        const session = this.host.session(run.sessionId);
        if (session && run.status !== 'queued') {
          const status = session.status === 'approval' ? 'waiting' : 'running';
          if (run.status !== status) { run.status = status; await this.save(); }
        }
      }
    });
    // Retry a failed archival write after storage recovers, without replaying a turn.
    if (!this.running) for (const run of this.records.filter(activeScheduledRun)) {
      const session = this.host.session(run.sessionId);
      if (run.status !== 'queued' && session && ['idle', 'error'].includes(session.status)) await this.complete(session.id);
    }
    this.pump();
  }
  private pump() {
    if (this.stopped || this.suspended || this.running || !this.started || this.records.some(run => ['running', 'waiting'].includes(run.status))) return;
    const run = [...this.records].reverse().find(run => run.status === 'queued'); if (!run) return;
    const job = this.execute(run).catch(error => this.host.notice('定时任务执行记录未保存：' + error.message)).finally(() => { if (this.running === job) this.running = undefined; }); this.running = job;
  }
  private async execute(run: ScheduledRun) {
    let session: AgentSession | undefined;
    try {
      const task = structuredClone(this.task(run.taskId)); run.status = 'running'; run.startedAt = this.stamp(); await this.enqueue(() => this.save());
      for (const source of task.sources) if (await hashFile(source.localPath) !== source.sha256) throw Error('任务附件已变化：' + source.name);
      session = await this.host.prepare(task, run);
      run.context = { briefRevision: session.projectBrief?.revision, sources: session.sources.map(({ id, sha256, name }) => ({ id, sha256, name })) }; await this.enqueue(() => this.save());
      if (this.stopping.has(run.id)) session.stoppedAt = this.stamp();
      if (this.stopped || this.stopping.has(run.id) || run.status !== 'running') throw Error('任务启动已取消');
      await this.host.execute(task, run, session);
    } catch (error: any) {
      session ||= this.host.session(run.sessionId);
      if (session) { session.status = 'error'; session.error = error.message; }
      await this.complete(run.sessionId, error.message);
    }
  }
  async complete(sessionId: string, failure?: string) { await this.enqueue(async () => {
    const run = this.records.find(item => item.sessionId === sessionId && activeScheduledRun(item)); if (!run) return;
    const session = this.host.session(sessionId);
    const prior = structuredClone(run), finished = { ...run };
    finished.status = this.stopped ? 'interrupted' : session?.stoppedAt ? 'stopped' : failure || session?.error ? 'failed' : 'completed';
    finished.finishedAt = this.stamp(); finished.error = failure || session?.error;
    const replies = session?.messages.filter(message => message.role === 'assistant' && message.text.trim()) || [];
    finished.summary = (replies.filter(message => message.phase === 'final_answer').at(-1) || replies.at(-1))?.text.replace(/\s+/g, ' ').slice(0, 220);
    if (session) await this.snapshot(finished, session);
    Object.assign(run, finished);
    try { await this.save(); } catch (error) { for (const key of Object.keys(run)) delete (run as any)[key]; Object.assign(run, prior); throw error; }
    if (session) await this.host.unload(session);
    this.host.notice(`定时任务${run.status === 'completed' ? '完成' : '结束'}：${run.taskName}`);
  }); }
  private async snapshot(run: ScheduledRun, session: AgentSession) {
    const directory = this.runDir(run.id), { messages, ...metadata } = session;
    for (let i = 0; i < messages.length; i += transcriptPageSize) await atomicJson(path.join(directory, Math.floor(i / transcriptPageSize) + '.json'), messages.slice(i, i + transcriptPageSize));
    await atomicJson(path.join(directory, 'session.json'), { session: { ...metadata, outputFiles: mentionedFiles(session) }, count: messages.length }); run.messageCount = messages.length;
  }
  async open(id: string): Promise<ScheduledRunSession> {
    const run = this.record(id), active = this.host.session(run.sessionId);
    if (active) return { run: structuredClone(run), session: structuredClone(active), earlierCount: 0 };
    let snapshot: { session: Omit<AgentSession, 'messages'>; count: number };
    try { snapshot = JSON.parse(await fs.readFile(path.join(this.runDir(id), 'session.json'), 'utf8')); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; throw Error(run.error || '本次任务尚未创建会话'); }
    const page = await this.page(id, snapshot.count, transcriptPageSize);
    return { run: structuredClone(run), session: { ...snapshot.session, messages: page.messages }, earlierCount: page.before };
  }
  async page(id: string, before: number, limit = transcriptPageSize): Promise<TranscriptPage> {
    this.record(id); const directory = this.runDir(id);
    const snapshot = JSON.parse(await fs.readFile(path.join(directory, 'session.json'), 'utf8')) as { count: number };
    const end = Math.min(Math.max(0, before), snapshot.count), start = Math.max(0, end - Math.min(transcriptPageSize, limit));
    const messages = [];
    for (let chunk = Math.floor(start / transcriptPageSize); chunk * transcriptPageSize < end; chunk++) {
      const page: AgentSession['messages'] = JSON.parse(await fs.readFile(path.join(directory, chunk + '.json'), 'utf8'));
      messages.push(...page.slice(Math.max(0, start - chunk * transcriptPageSize), Math.min(page.length, end - chunk * transcriptPageSize)));
    }
    return { messages, before: start };
  }
  async continueRun(id: string) { return this.enqueue(async () => {
    const run = this.record(id);
    if (activeScheduledRun(run)) throw Error('请先完成或停止本次自动执行');
    const existing = this.host.session(run.sessionId);
    if (existing && (run.continued || existing.scheduledRun?.managed === false)) { run.continued = true; await this.save(); return existing; }
    if (run.continued) throw Error('对应工作会话已删除，未重新创建副本');
    const { session } = await this.open(id);
    const messages: AgentSession['messages'] = [];
    for (let end = run.messageCount || 0; end > 0;) { const page = await this.page(id, end); messages.unshift(...page.messages); end = page.before; }
    session.messages = messages; if (session.scheduledRun) session.scheduledRun.managed = false;
    const restored = await this.host.restore(session); run.continued = true; await this.save(); return restored;
  }); }
  async stop(id: string) { const run = this.record(id); if (!activeScheduledRun(run)) return;
    this.stopping.add(id);
    if (run.status === 'queued') { await this.enqueue(async () => { run.status = 'stopped'; run.finishedAt = this.stamp(); await this.save(); }); return; }
    if (this.host.session(run.sessionId)) await this.host.stop(run.sessionId);
    else { await this.running; await this.complete(run.sessionId, '任务已停止'); }
  }
  private async removeRecords(ids: string[]) {
    const runs = ids.map(id => this.record(id));
    if (runs.some(activeScheduledRun)) throw Error('请先停止正在运行的记录');
    this.records = this.records.filter(run => !ids.includes(run.id)); await this.save();
    for (const run of runs) await fs.rm(this.runDir(run.id), { recursive: true, force: true });
  }
  async deleteRuns(ids: string[]) { return this.enqueue(() => this.removeRecords(ids)); }
  suspend() { this.suspended = true; }
  async resumeAfterSleep() {
    if (!this.started || this.stopped) return;
    await this.enqueue(async () => {
      for (const task of this.tasks) task.nextRunAt = !task.paused && !task.deletedAt ? nextScheduledTime(task.schedule, this.now()) : undefined;
      this.lastTick = this.now(); await this.save(); this.suspended = false;
    });
    this.pump();
  }
  private async release() {
    if (!this.lockNonce) return;
    const lock = path.join(this.root, 'scheduler.lock');
    if (await fs.readFile(lock, 'utf8').then(text => JSON.parse(text).nonce === this.lockNonce).catch(() => false)) await fs.unlink(lock);
    this.lockNonce = undefined;
  }
  async close() {
    this.stopped = true; clearInterval(this.timer); await this.running; await this.serial.catch(() => {});
    for (const run of this.records.filter(activeScheduledRun)) {
      const session = this.host.session(run.sessionId); run.status = 'interrupted'; run.finishedAt = this.stamp(); run.error = '工作台已退出，未自动重放。';
      if (session) { session.status = 'error'; session.error = run.error; await this.snapshot(run, session); await this.host.unload(session); }
    }
    if (this.started) await this.save(); await this.release(); this.started = false; this.staged.clear(); this.stopping.clear();
  }
}
