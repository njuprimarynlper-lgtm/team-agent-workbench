import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
export const logContext = new AsyncLocalStorage<import('../shared/logs').LogScope>();
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { runtimeAssets } from '../shared/runtime-assets';
import type { LogCategory, LogRecord, LogScope, LogStatus } from '../shared/logs';
import packageJson from '../../package.json';
import { traceFiles } from './trace-reader';
import fsSync from 'node:fs';

export const logVersion = packageJson.version;
const MiB = 1024 * 1024;
export function redactLogText(value: unknown, maximum = 4000): string {
  const text = value instanceof Error ? value.message : String(value ?? '');
  return text.slice(0, 32768)
    .replace(/TAE[12]\.[A-Za-z0-9_-]+/g, '[接入码]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [凭据]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[令牌]')
    .replace(/((?:password|passwd|passphrase|access[_-]?code|api[_-]?key|token|secret|authorization|cookie)["']?\s*[:=]\s*)["']?[^\s,;"'}]+/gi, '$1[凭据]')
    .replace(/https?:\/\/[^\s)"']+/gi, url => { try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}/[路径]`; } catch { return '[网址]'; } })
    .replaceAll(os.homedir(), '%USERPROFILE%').slice(0, maximum);
}
const opaque = (value?: string) => value ? createHash('sha256').update(value).digest('hex').slice(0, 24) : undefined;
const identifier = (value: unknown) => typeof value === 'string' && /^[\w.:-]{1,128}$/.test(value) ? value : undefined;
const roots = new Map<string, LogService>();
export function configureLogs(root: string) { const key = path.resolve(root); let value = roots.get(key); if (!value) { value = new LogService(key); roots.set(key, value); } return value; }
export function logsFor(root: string) {
  const absolute = path.resolve(root);
  for (const [key, service] of [...roots].sort((a, b) => b[0].length - a[0].length)) { const relative = path.relative(key, absolute); if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) return service; }
  return configureLogs(absolute);
}
export function accountLogScope(root: string, scope: LogScope = {}): LogScope { return { ...scope, account: opaque(path.resolve(root).toLowerCase()) }; }

type TraceJob = { directory: string; line: string; bytes: number; resolve(): void; reject(error: Error): void };
export class LogService extends EventEmitter {
  readonly instance = randomUUID();
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private records: LogRecord[] = [];
  private bytes = 0;
  private traces: TraceJob[] = [];
  private traceBytes = 0;
  private pumping?: Promise<void>;
  private timer: NodeJS.Timeout;
  private cleanupTimer: NodeJS.Timeout;
  private repeats = new Map<string, { record: LogRecord; count: number; lastAt: string; until: number }>();
  private progress = new Map<string, number>();
  private tokens = 100;
  private refilled = Date.now();
  private cooldown = 0;
  private pressure = false;
  private suppressed = 0;
  private unreported = 0;
  private lastSuppression = 0;
  private lastWrite?: string;
  private error?: string;
  private traceError?: string;
  private migrating = new Set<string>();
  private disposed = false;
  private startupBytes = 0;
  private emergencyWritten = false;
  private readGates = new Map<string, number>();
  exporting = false;
  exportPending = false;
  constructor(readonly root: string) {
    super(); this.setMaxListeners(100); this.timer = setInterval(() => { this.flushRepeats(); void this.flush(); }, 1000); this.timer.unref();
    this.cleanupTimer = setInterval(() => { void this.request({ action: 'cleanup' }).catch(error => this.failed(error)); }, 3600000); this.cleanupTimer.unref();
  }
  private failed(error: unknown, trace = false) {
    const message = redactLogText(error); this.error = message; if (trace) this.traceError = message;
    if (Date.now() >= this.cooldown) { this.cooldown = Date.now() + 60000; this.emit('storage-error', message); }
  }
  private request(message: object): Promise<any> {
    if (!this.worker) {
      const worker = this.worker = new Worker(path.join(__dirname, runtimeAssets, 'log-storage.cjs'), { workerData: { root: this.root } });
      worker.on('message', ({ id, value, error }) => { const item = this.pending.get(id); if (!item) return; this.pending.delete(id); error ? item.reject(Error(error)) : item.resolve(value); if (!this.pending.size) worker.unref(); });
      const failure = (error: Error) => { for (const item of this.pending.values()) item.reject(error); this.pending.clear(); if (this.worker === worker) this.worker = undefined; this.failed(error); };
      worker.on('error', failure); worker.on('exit', () => failure(Error('日志写入线程已退出'))); worker.unref();
    }
    const id = ++this.sequence; this.worker.ref();
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker!.postMessage({ ...message, id }); });
  }
  record(category: LogCategory, name: string, scope: LogScope = {}, fields: Partial<Pick<LogRecord, 'outcome' | 'level' | 'durationMs' | 'code' | 'detail' | 'stack' | 'count'>> = {}) {
    if (this.disposed) return;
    scope = { ...logContext.getStore(), ...Object.fromEntries(Object.entries(scope).filter(([, value]) => value !== undefined)) };
    const now = Date.now();
    const record: LogRecord = { schema: 1, id: randomUUID(), at: new Date(now).toISOString(), version: logVersion, instance: this.instance, category, name: /^[A-Za-z][A-Za-z0-9_./:-]{0,119}$/.test(name) ? name : 'invalid.operation',
      account: identifier(scope.account), projectId: identifier(scope.projectId), sessionId: identifier(scope.sessionId), turnId: identifier(scope.turnId), operationId: identifier(scope.operationId), origin: scope.origin || 'background', provider: identifier(scope.provider), route: identifier(scope.route),
      entityId: typeof scope.entityId === 'string' && /^[a-f0-9-]{36}$/i.test(scope.entityId) ? scope.entityId : undefined,
      relatedIds: Array.isArray(scope.relatedIds) ? [...new Set(scope.relatedIds.filter(value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value)))].slice(0, 50) : undefined,
      outcome: fields.outcome?.slice(0, 50), level: fields.level || 'info', durationMs: Number.isFinite(fields.durationMs) ? Math.max(0, Math.round(fields.durationMs!)) : undefined, code: fields.code?.slice(0, 80), count: fields.count,
      detail: fields.detail ? redactLogText(fields.detail) : undefined, stack: fields.stack ? redactLogText(fields.stack, 8000) : undefined };
    if (Buffer.byteLength(JSON.stringify(record)) > 15000) { record.stack = record.stack?.slice(0, 2000); record.detail = record.detail?.slice(0, 1000); }
    if (record.level === 'error' || record.level === 'warning') {
      const key = JSON.stringify([name, scope.account, scope.projectId, scope.sessionId, record.code, record.detail]);
      const prior = this.repeats.get(key);
      if (prior && now < prior.until) { prior.count++; prior.lastAt = record.at; return; }
      if (this.repeats.size >= 500) { this.drop(); return; }
      this.repeats.set(key, { record, count: 1, lastAt: record.at, until: now + 60000 });
    }
    if (/progress$/.test(name)) {
      const key = `${scope.sessionId}:${scope.operationId}:${name}`;
      if (now - (this.progress.get(key) || 0) < 5000) { this.drop(); return; }
      this.progress.set(key, now); if (this.progress.size > 1000) this.progress.delete(this.progress.keys().next().value!);
    }
    this.enqueue(record);
  }
  private drop() { this.suppressed++; this.unreported++; }
  private enqueue(record: LogRecord, exempt = false) {
    const now = Date.now(); this.tokens = Math.min(100, this.tokens + (now - this.refilled) * 0.02); this.refilled = now;
    if (!exempt && this.tokens < 1) { this.drop(); return; }
    const size = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (size > 16384 || this.records.length >= 1000 || this.bytes + size > 2 * MiB) {
      if (record.level === 'error') { const index = this.records.findIndex(item => item.level === 'info'); if (index >= 0) { this.bytes -= Buffer.byteLength(JSON.stringify(this.records[index])) + 1; this.records.splice(index, 1); } else { this.drop(); return; } }
      else { this.drop(); return; }
    }
    if (!exempt) this.tokens--; this.records.push(record); this.bytes += size;
    if (this.bytes >= 65536) void this.flush();
  }
  private flushRepeats(force = false) {
    for (const [key, value] of this.repeats) if (force || Date.now() >= value.until) {
      if (value.count > 1) this.enqueue({ ...value.record, id: randomUUID(), name: value.record.name + '.repeated', count: value.count, lastAt: value.lastAt }, true);
      this.repeats.delete(key);
    }
    if (this.unreported && (force || Date.now() - this.lastSuppression >= 60000)) {
      this.enqueue({ schema: 1, id: randomUUID(), at: new Date().toISOString(), version: logVersion, instance: this.instance, category: 'diagnostic', name: 'logging.suppressed', suppressed: this.unreported }, true);
      this.unreported = 0; this.lastSuppression = Date.now();
    }
  }
  private updatePressure() {
    const next = this.traceBytes >= 2 * MiB || this.traces.length >= 512 ? true : this.traceBytes <= 512 * 1024 && this.traces.length < 128 ? false : this.pressure;
    if (next !== this.pressure) { this.pressure = next; this.emit('pressure', next); }
  }
  get pressured() { return this.pressure; }
  emergency(error: unknown) {
    if (this.emergencyWritten) return; this.emergencyWritten = true;
    const directory = path.join(this.root, 'logs'), file = path.join(directory, `diagnostic-${Date.now()}-${randomUUID()}.jsonl`), pending = file + '.' + randomUUID() + '.tmp';
    try {
      fsSync.mkdirSync(directory, { recursive: true });
      if (fsSync.lstatSync(this.root).isSymbolicLink() || fsSync.lstatSync(directory).isSymbolicLink()) return;
      const row = { schema: 1, id: randomUUID(), at: new Date().toISOString(), version: logVersion, instance: this.instance, category: 'diagnostic', name: 'app.uncaught_exception', level: 'error', detail: redactLogText(error, 500), stack: error instanceof Error ? redactLogText(error.stack, 1500) : undefined };
      fsSync.writeFileSync(pending, JSON.stringify(row) + '\n', { flag: 'wx', mode: 0o600 }); fsSync.renameSync(pending, file);
    } catch { /* A fatal-path fallback must neither throw nor recursively log. */ }
    finally { try { fsSync.unlinkSync(pending); } catch {} }
  }
  async migrateTraces(root: string) {
    if (this.migrating.has(root)) return;
    this.migrating.add(root);
    try {
      const fs = await import('node:fs/promises');
      for (const entry of await fs.readdir(path.join(root, 'sessions'), { withFileTypes: true }).catch(() => [])) {
        if (this.disposed) break;
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
        const directory = path.join(root, 'sessions', entry.name);
        if ((await traceFiles(directory)).some(file => !file.endsWith('.gz'))) await this.seal(directory);
      }
    } catch (error) { this.failed(error); }
    finally { this.migrating.delete(root); }
  }
  async ingestStartup(directory?: string, edition?: string) {
    if (!directory || this.disposed) return;
    const fs = await import('node:fs/promises');
    const files = (await fs.readdir(directory, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isFile() && !entry.isSymbolicLink() && (!edition || entry.name.startsWith(edition + '-')) && /^(user|admin)-\d{8}-\d{6}-\d{3}-\d+(?:-[\w-]+)?\.(log|out|err)$/.test(entry.name));
    this.startupBytes = 0;
    for (const entry of files) {
      const file = path.join(directory, entry.name), stat = await fs.stat(file); this.startupBytes += stat.size;
      const pid = Number(/-\d{3}-(\d+)/.exec(entry.name)?.[1]);
      if (!pid || Date.now() - stat.mtimeMs < 5000) continue;
      try { process.kill(pid, 0); continue; } catch (error: any) { if (error.code !== 'ESRCH') continue; }
      const handle = await fs.open(file, 'r'), bytes = Buffer.alloc(Math.min(4000, stat.size));
      try { await handle.read(bytes, 0, bytes.length, Math.max(0, stat.size - bytes.length)); } finally { await handle.close(); }
      const before = this.suppressed;
      this.record('diagnostic', 'startup.capture', {}, { code: /error|\.err$/.test(entry.name) ? 'stderr' : 'stdout', detail: bytes.toString('utf8'), outcome: 'imported' });
      await this.flush();
      if (!this.error && before === this.suppressed && (await fs.stat(file)).mtimeMs === stat.mtimeMs) { await fs.rm(file); this.startupBytes -= stat.size; }
    }
  }
  trace(directory: string, event: unknown) {
    const line = JSON.stringify({ at: new Date().toISOString(), event }) + '\n';
    const promise = new Promise<void>((resolve, reject) => { const bytes = Buffer.byteLength(line); this.traces.push({ directory, line, bytes, resolve, reject }); this.traceBytes += bytes; this.updatePressure(); });
    void this.flush(); return promise;
  }
  flush(): Promise<void> {
    if (this.pumping) return this.pumping;
    this.pumping = (async () => {
      while (this.traces.length || this.records.length && Date.now() >= this.cooldown) {
        const trace = this.traces[0];
        if (trace && this.readGates.has(trace.directory)) break;
        if (trace) {
          const batch: TraceJob[] = []; let bytes = 0;
          for (const job of this.traces) { if (job.directory !== trace.directory || batch.length >= 100 || batch.length && bytes + job.bytes > 65536) break; batch.push(job); bytes += job.bytes; }
          try {
            if (Date.now() < this.cooldown) throw Error('轨迹写入暂不可用，存在未持久化记录');
            const result = await this.request({ action: 'trace', directory: trace.directory, line: batch.map(job => job.line).join('') });
            if (result?.recoveredIncomplete) { this.traceError = '上次异常退出留下不完整的执行事件，原片段已保留并与新记录分开'; this.emit('trace-incomplete', trace.directory); }
            batch.forEach(job => job.resolve()); this.lastWrite = new Date().toISOString();
          }
          catch (error) { this.failed(error, true); batch.forEach(job => job.reject(error as Error)); }
          this.traces.splice(0, batch.length); this.traceBytes -= bytes; this.updatePressure();
        }
        if (this.records.length && Date.now() >= this.cooldown) {
          const records = this.records.splice(0, 100); this.bytes -= records.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)) + 1, 0);
          try { await this.request({ action: 'append', records }); this.lastWrite = new Date().toISOString(); this.error = undefined; }
          catch (error) { this.failed(error); for (const _ of records) this.drop(); }
        }
      }
    })().finally(() => { this.pumping = undefined; });
    return this.pumping;
  }
  async traceSnapshot(directory: string) {
    await this.flush();
    this.readGates.set(directory, (this.readGates.get(directory) || 0) + 1);
    try {
      await this.flush(); const result = await this.request({ action: 'seal', directory });
      if (result?.recoveredIncomplete) { this.traceError = '旧执行事件末尾缺少换行，可能不完整；原片段已保留并与后续事件隔开'; this.emit('trace-incomplete', directory); }
      return await traceFiles(directory);
    }
    finally { const count = this.readGates.get(directory)! - 1; if (count) this.readGates.set(directory, count); else this.readGates.delete(directory); void this.flush(); }
  }
  async seal(directory: string) { await this.traceSnapshot(directory); }
  async files(): Promise<{ file: string; name: string; category: LogCategory; at: number; bytes: number }[]> { await this.flush(); return this.request({ action: 'files' }); }
  async status(traceRoots: string[]): Promise<LogStatus> { const usage = await this.request({ action: 'status', roots: traceRoots }); usage.diagnostic.limit = 30 * MiB; usage.diagnostic.bytes += this.startupBytes; return { ...usage, queued: this.records.length + this.traces.length, queueBytes: this.bytes + this.traceBytes, suppressed: this.suppressed, lastWrite: this.lastWrite, error: this.error, traceError: this.traceError, exporting: this.exporting || this.exportPending }; }
  async cleanup() { await this.flush(); this.records = []; this.bytes = 0; this.repeats.clear(); this.progress.clear(); this.unreported = 0; await this.request({ action: 'cleanup', clear: true }); }
  async close() { this.disposed = true; clearInterval(this.timer); clearInterval(this.cleanupTimer); this.flushRepeats(true); await this.flush(); if (this.worker) { const worker = this.worker; this.worker = undefined; await worker.terminate(); } roots.delete(this.root); }
}
