import { EventEmitter } from 'node:events';
import type { AdminEgressConfig, EgressRelaySnapshot } from '../shared/egress';

export interface RelayProcess extends EventEmitter { pid?: number; postMessage(value: unknown): void; kill(): boolean; }
export type RelaySecret = { accessCode: string; upstreamPassword?: string };
export type RelayCertificate = { pfx: Buffer; passphrase: string; fingerprint: string };

// Credentials travel only over the private parent/child IPC channel.
export class EgressHost extends EventEmitter {
  private child?: RelayProcess;
  private value: EgressRelaySnapshot;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private operations: Promise<unknown> = Promise.resolve();
  constructor(private entry: string, private config: AdminEgressConfig, private secret: RelaySecret, private certificate: RelayCertificate, private launch: (entry: string) => RelayProcess) {
    super(); this.value = this.empty();
  }
  private empty(): EgressRelaySnapshot { return { running: false, activeConnections: 0, events: [], fingerprint: this.certificate.fingerprint }; }
  snapshot(): EgressRelaySnapshot { return structuredClone(this.value); }
  private publish(value: EgressRelaySnapshot) { this.value = value; this.emit('changed'); }
  private rejectPending(message: string) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
    this.pending.clear();
  }
  private request(action: string, payload?: unknown, timeout = 20000) {
    const child = this.child;
    if (!child) return Promise.reject(new Error('代理进程未启动'));
    return new Promise<unknown>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('代理进程响应超时')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { child.postMessage({ id, action, payload }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('无法连接代理进程')); }
    });
  }
  private async launchWorker(probeOnly = false) {
    if (this.child) return;
    if (!this.config.enabled && !probeOnly) { this.publish(this.empty()); return; }
    let child: RelayProcess;
    try { child = this.launch(this.entry); }
    catch { const error = new Error('无法启动独立代理进程，请检查安装文件'); if (!probeOnly) this.publish({ ...this.empty(), lastError: error.message }); throw error; }
    this.child = child;
    child.on('message', message => {
      if (this.child !== child) return;
      if (message?.type === 'snapshot') { if (!probeOnly) this.publish(message.value); }
      else if (message?.type === 'response') {
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.value);
      }
    });
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = undefined; this.rejectPending('代理进程已退出');
      if (!probeOnly) this.publish({ ...this.empty(), lastError: '代理进程意外退出，请重新应用出口设置。' });
    });
    try { await this.request('start', { config: probeOnly ? { ...this.config, enabled: false } : this.config, secret: this.secret, certificate: this.certificate }); }
    catch (error) {
      if (this.child === child) { this.child = undefined; child.kill(); this.rejectPending('代理启动失败'); }
      if (!probeOnly) this.publish({ ...this.empty(), lastError: error instanceof Error ? error.message : '代理启动失败' }); throw error;
    }
  }
  private serial(operation: () => Promise<void>) {
    const task = this.operations.catch(() => {}).then(operation); this.operations = task; return task;
  }
  start() { return this.serial(() => this.launchWorker()); }
  restart(config: AdminEgressConfig, secret: RelaySecret) {
    return this.serial(async () => { await this.stopWorker(); this.config = config; this.secret = secret; await this.launchWorker(); });
  }
  private async stopWorker(preserveSnapshot = false) {
    const child = this.child;
    if (child) {
      try { await this.request('stop', undefined, 3000); } catch { /* terminate an unresponsive worker */ }
      if (this.child === child) { this.child = undefined; child.kill(); }
      this.rejectPending('代理进程已停止');
    }
    if (!preserveSnapshot) this.publish(this.empty());
  }
  stop() { return this.serial(() => this.stopWorker()); }
  probe(provider: 'codex' | 'cursor' | 'claude') {
    return this.serial(async () => {
      const temporary = !this.child;
      try { if (temporary) await this.launchWorker(true); await this.request('probe', { provider }); }
      finally { if (temporary) await this.stopWorker(true); }
    });
  }
}
