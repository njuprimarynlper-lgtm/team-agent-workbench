import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentSession, Draft, Settings, Transfer, SessionInput } from '../shared/types';
import { settingsSchema } from './config';
import { migrateSessionContext } from './session-context';
export async function atomicJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    // Windows scanners may briefly hold the destination. Never unlink the old file to replace it.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); break; }
      catch (e: any) {
        if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
export class Store {
  settings: Settings = { connections: [], providerPaths: { codex: '', cursor: '' }, lastWorkspace: '' };
  sessions: AgentSession[] = []; transfers: Transfer[] = []; drafts: Draft[] = [];
  inputs: Record<string, SessionInput> = {};
  private writes: Promise<void> = Promise.resolve();
  constructor(public root: string) {}
  async init() {
    await fs.mkdir(this.root, { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.root, 'settings.json'), 'utf8'));
      // Older builds stored the verified workspace as a time-limited lease; carry it over without the timestamps.
      if (raw && typeof raw === 'object') {
        if (raw.offlineAuthorization && !raw.workspaceSnapshot) raw.workspaceSnapshot = { profile: raw.offlineAuthorization.profile, workspaces: raw.offlineAuthorization.workspaces };
        delete raw.offlineAuthorization;
      }
      this.settings = settingsSchema.parse(raw);
    } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('本地设置损坏，请保留文件并检查：' + path.join(this.root, 'settings.json')); }
    for (const key of ['sessions', 'transfers', 'drafts'] as const) {
      try { const data = JSON.parse(await fs.readFile(path.join(this.root, key + '.json'), 'utf8')); if (!Array.isArray(data)) throw new Error('Invalid array'); (this[key] as unknown[]) = data; } catch (e: any) { if (e.code !== 'ENOENT') throw new Error(`本地 ${key}.json 无法读取`); }
    }
    try { this.inputs = JSON.parse(await fs.readFile(path.join(this.root, 'inputs.json'), 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('本地 inputs.json 无法读取'); }
    this.sessions.forEach(s => { s.status = 'idle'; s.approvals = []; migrateSessionContext(s); });
    this.drafts.forEach(d => {
      if (!d.preparationVersion && !d.submitted) {
        // Preserve the user's previous final explanation when upgrading older drafts.
        d.body = d.body || d.generatedBody || ''; d.supplement ??= '';
        if (d.binding) d.target = d.binding.project.uploadPath;
        d.preparationVersion = 1;
        if (d.body && d.generation !== 'running') { d.generation = 'ready'; d.generationError = undefined; }
      }
      if (d.generation === 'running') { d.generation = 'error'; d.generationError = '应用关闭后整理已中断，可重试整理，“给团队的补充”已保留。'; }
      else if (!d.generation) { const s = this.sessions.find(s => s.id === d.prepareSessionId); d.generation = d.generatedBody ? 'ready' : 'error'; d.generationError = d.generatedBody ? undefined : s?.error || '此前的整理未完成，可重试整理，“给团队的补充”已保留。'; }
    });
    this.transfers.forEach(t => { if (t.status === 'running' || t.status === 'queued') { t.status = 'error'; t.error = '应用重启，确认服务器连接后可重试'; } });
  }
  save() {
    const data = JSON.parse(JSON.stringify({ settings: this.settings, sessions: this.sessions, inputs: this.inputs, transfers: this.transfers, drafts: this.drafts }));
    const next = this.writes.catch(() => {}).then(async () => { for (const [key, value] of Object.entries(data)) await atomicJson(path.join(this.root, key + '.json'), value); });
    this.writes = next; return next;
  }
  sessionDir(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效会话 ID'); return path.join(this.root, 'sessions', id); }
  async event(id: string, event: unknown) {
    const dir = this.sessionDir(id); await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event }) + '\n', { mode: 0o600 });
  }
}
