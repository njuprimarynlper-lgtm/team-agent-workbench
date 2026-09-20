import fs from 'node:fs/promises';
import { z } from 'zod';
import { atomicJson } from './store';

const identitiesSchema = z.record(z.string(), z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/));

export class ServerIdentityStore {
  private identities: Record<string, string> = {};
  private initialization?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {}

  init(legacy: Record<string, string> = {}) {
    this.initialization ??= this.load(legacy);
    return this.initialization;
  }

  private async load(legacy: Record<string, string>) {
    try { this.identities = identitiesSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw new Error('本机服务器身份记录损坏，请保留文件并检查：' + this.file);
      this.identities = identitiesSchema.parse(legacy); await atomicJson(this.file, this.identities);
    }
  }

  snapshot() { return { ...this.identities }; }
  get(key: string) { return this.identities[key] || ''; }

  remember(key: string, fingerprint: string) {
    return this.update(next => {
      if (next[key] && next[key] !== fingerprint) throw new Error('服务器身份发生变化，已停止登录。请重新确认服务器地址。');
      next[key] = fingerprint;
    });
  }

  forget(key: string) { return this.update(next => { delete next[key]; }); }

  private update(change: (next: Record<string, string>) => void) {
    const write = this.writes.catch(() => {}).then(async () => {
      const next = { ...this.identities }; change(next); await atomicJson(this.file, next); this.identities = next;
    });
    this.writes = write; return write;
  }
}
