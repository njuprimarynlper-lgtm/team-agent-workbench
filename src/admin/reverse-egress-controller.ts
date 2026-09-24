import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { atomicJson } from '../core/store';
import { ReverseEgressTunnel } from './reverse-egress';
import type { AdminProfile } from './types';
import type { ReverseEgressSnapshot, SharedServerRoute } from '../shared/egress';

const recordSchema = z.object({ enabled: z.boolean(), remotePort: z.number().int().min(0).max(65535), memberAccessConfigured: z.boolean() });
type SavedRoute = z.infer<typeof recordSchema>;
const empty = (): SavedRoute => ({ enabled: false, remotePort: 0, memberAccessConfigured: false });

export class ReverseEgressController {
  private records: Record<string, SavedRoute> = {};
  private profile?: AdminProfile;
  private password?: string;
  private key = '';
  private generation = 0;
  private gateway = { enabled: false, host: '127.0.0.1', port: 18443 };
  private writes = Promise.resolve();
  private storageError = false;
  busy = false;
  constructor(private file: string, private changed: () => void, readonly tunnel = new ReverseEgressTunnel()) {
    tunnel.on('changed', () => {
      const state = tunnel.snapshot();
      if (state.state === 'connected' && this.key && state.remotePort && this.record.remotePort !== state.remotePort) {
        this.record.remotePort = state.remotePort; this.record.memberAccessConfigured = false;
        void this.save().catch(() => {});
      }
      changed();
    });
  }
  async init() {
    try { this.records = z.record(z.string().regex(/^[a-f0-9]{64}$/), recordSchema).parse(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch (error: any) { if (error.code !== 'ENOENT') this.storageError = true; }
  }
  private get record() { return this.key ? this.records[this.key] ||= empty() : empty(); }
  private save() {
    const write = this.writes.catch(() => {}).then(() => atomicJson(this.file, this.records));
    this.writes = write;
    return write.then(() => { this.storageError = false; }, error => { this.storageError = true; this.changed(); throw error; });
  }
  select(profile?: AdminProfile) {
    this.disconnect(); this.profile = profile?.mode === 'local' ? undefined : profile;
    this.key = this.profile?.fingerprint ? createHash('sha256').update(JSON.stringify([this.profile.host.toLowerCase(), this.profile.port, this.profile.fingerprint, this.profile.root])).digest('hex') : '';
    this.changed();
  }
  async login(profile: AdminProfile, password: string) {
    this.select(profile); this.password = password;
    if (this.record.enabled) await this.sync().catch(() => {});
  }
  disconnect() { this.generation++; this.password = undefined; this.tunnel.stop(); this.changed(); }
  async setGateway(enabled: boolean, host: string, port: number) {
    const next = { enabled, host: host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host, port };
    if (JSON.stringify(next) === JSON.stringify(this.gateway)) return;
    this.gateway = next; this.tunnel.stop();
    await this.sync().catch(() => {}); this.changed();
  }
  private async sync() {
    if (!this.record.enabled || !this.password || !this.profile || !this.gateway.enabled) { this.tunnel.stop(); return; }
    if (this.tunnel.snapshot().state === 'connected') return;
    await this.tunnel.start({ host: this.profile.host, port: this.profile.port, username: this.profile.username, password: this.password,
      fingerprint: this.profile.fingerprint, remotePort: this.record.remotePort, localHost: this.gateway.host, localPort: this.gateway.port });
    await this.save();
  }
  snapshot(targets?: { host: string; port: number }[]): ReverseEgressSnapshot {
    const record = this.record, tunnel = this.tunnel.snapshot();
    const base = { ...tunnel, enabled: record.enabled, remotePort: record.remotePort || undefined, server: this.profile ? `${this.profile.host}:${this.profile.port}` : undefined,
      memberAccessConfigured: targets ? targets.some(target => target.host === '127.0.0.1' && target.port === record.remotePort) : record.memberAccessConfigured };
    if (!record.enabled) return { ...base, state: 'disabled', detail: '未启用反向隧道' };
    if (this.storageError) return { ...base, state: 'error', detail: '中转设置保存失败，请检查本机数据目录并重试' };
    if (!this.password) return { ...base, state: 'waiting-login', detail: '请登录共享服务器，登录后自动恢复反向隧道' };
    if (!this.gateway.enabled) return { ...base, state: 'paused', detail: '管理端出口未运行，反向隧道已暂停' };
    if (base.state === 'connected' && !base.memberAccessConfigured) return { ...base, detail: '隧道已连接，请完成成员接入授权' };
    return base;
  }
  async enable(allow: (port: number) => Promise<unknown>) {
    if (this.busy) throw new Error('反向隧道设置正在更新');
    if (!this.password || !this.profile || !this.key) throw new Error('请先以服务器管理账号登录');
    if (!this.gateway.enabled) throw new Error('请先保存并启用管理端网络出口');
    this.busy = true; const generation = this.generation; this.changed();
    try {
      this.record.enabled = true; await this.save(); await this.sync();
      if (generation !== this.generation) throw new Error('服务器连接已改变');
      const port = this.record.remotePort;
      if (!port || this.tunnel.snapshot().state !== 'connected') throw new Error('反向隧道尚未连通');
      await allow(port);
      if (generation !== this.generation) throw new Error('服务器连接已改变');
      this.record.memberAccessConfigured = true; await this.save();
    } finally { this.busy = false; this.changed(); }
  }
  async disable() {
    if (this.busy) throw new Error('反向隧道设置正在更新');
    this.record.enabled = false; this.tunnel.stop(); await this.save(); this.changed();
  }
  route(targets?: { host: string; port: number }[]): SharedServerRoute {
    const state = this.snapshot(targets);
    if (state.state !== 'connected' || !state.memberAccessConfigured || !this.profile || !state.remotePort) throw new Error('请先启用反向隧道并完成成员接入授权');
    return { host: this.profile.host, port: this.profile.port, fingerprint: this.profile.fingerprint, relayPort: state.remotePort };
  }
}
