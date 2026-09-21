import { hashFile } from './artifacts';
import type { ContentMetadata } from '../shared/content';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { RemoteBinding, Transfer } from '../shared/types';
import { childRemote, assertRemote, safeFilename } from './paths';
import { SharedFiles } from './shared-files';
import { Store } from './store';
export class TransferQueue {
  private active = false;
  private persisting = new Set<string>();
  constructor(private store: Store, private remote: SharedFiles, private changed: () => void) {}
  async enqueue(local: string, binding: RemoteBinding, folder: string, kind: Transfer['kind'], sessionId?: string, metadata?: ContentMetadata, trajectoryHash?: string) {
    return (await this.enqueueMany([{ local, binding, folder, kind, sessionId, metadata, trajectoryHash }]))[0];
  }
  async enqueueMany(inputs: { local: string; binding: RemoteBinding; folder: string; kind: Transfer['kind']; sessionId?: string; metadata?: ContentMetadata; trajectoryHash?: string }[]): Promise<Transfer[]> {
    const transfers: Transfer[] = await Promise.all(inputs.map(async input => {
      assertRemote(input.binding.project.remoteRoot, input.folder);
      const id = randomUUID();
      return { id, sha256: await hashFile(input.local), metadata: input.metadata, trajectoryHash: input.trajectoryHash, kind: input.kind, name: path.basename(input.local), status: 'queued', bytes: 0, total: (await fsp.stat(input.local)).size, target: childRemote(input.folder, `${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}-${safeFilename(path.basename(input.local))}`), projectName: input.binding.project.name, createdAt: new Date().toISOString(), sessionId: input.sessionId, localPath: input.local, binding: structuredClone(input.binding) };
    }));
    transfers.forEach(item => this.persisting.add(item.id));
    this.store.transfers.unshift(...transfers.slice().reverse());
    try { await this.store.save(); }
    catch (error) { const ids = new Set(transfers.map(item => item.id)); this.store.transfers = this.store.transfers.filter(item => !ids.has(item.id)); this.changed(); throw error; }
    finally { transfers.forEach(item => this.persisting.delete(item.id)); }
    this.changed(); void this.pump(); return transfers;
  }
  async retry(id: string) {
    const item = this.store.transfers.find(t => t.id === id);
    if (!item || item.status !== 'error' || this.persisting.has(id)) throw new Error('只能重试失败的传输');
    if (item.cacheCleared) throw new Error('此上传缓存已清理，无法重试');
    this.remote.channel(item.binding);
    const previous = { status: item.status, bytes: item.bytes, error: item.error, completedAt: item.completedAt };
    this.persisting.add(id); item.status = 'queued'; item.bytes = 0; item.error = undefined; item.completedAt = undefined;
    try { await this.store.save(); }
    catch (error) { Object.assign(item, previous); this.changed(); throw error; }
    finally { this.persisting.delete(id); }
    this.changed(); void this.pump();
  }
  private async pump() {
    if (this.active) return; this.active = true;
    try {
      for (;;) {
        const task = [...this.store.transfers].reverse().find(t => t.status === 'queued' && !this.persisting.has(t.id)); if (!task) break;
        task.status = 'running'; this.changed();
        try {
          await this.store.save();
          if (task.sha256 && await hashFile(task.localPath) !== task.sha256) throw new Error('本地上传快照已改变，拒绝发送');
          await this.remote.ensurePersonalFolder(task.binding, path.posix.dirname(task.target));
          await this.remote.upload(task.binding, task.localPath, task.target, (bytes, total) => { task.bytes = bytes; task.total = total; this.changed(); }, task.metadata, task.sha256);
          task.status = 'done'; task.completedAt = new Date().toISOString(); task.bytes = task.total;
          if (task.kind === 'history') { const session = this.store.sessions.find(s => s.id === task.sessionId); if (session) { session.lastArchiveAt = task.completedAt; session.lastTrajectoryHash = task.trajectoryHash; } }
          await this.store.save();
        }
        catch (e: any) {
          task.status = 'error'; task.error = e.message;
          try { await this.store.save(); }
          catch (saveError: any) { task.error += '；传输状态保存失败：' + saveError.message + '。请恢复本地存储后重试，将复用原目标。'; }
        }
        this.changed();
      }
    } finally { this.active = false; }
  }
}
