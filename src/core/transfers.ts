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
  constructor(private store: Store, private remote: SharedFiles, private changed: () => void) {}
  async enqueue(local: string, binding: RemoteBinding, folder: string, kind: Transfer['kind'], sessionId?: string, metadata?: ContentMetadata, trajectoryHash?: string) {
    assertRemote(binding.project.remoteRoot, folder);
    const id = randomUUID();
    const transfer: Transfer = { id, sha256: await hashFile(local), metadata, trajectoryHash, kind, name: path.basename(local), status: 'queued', bytes: 0, total: (await fsp.stat(local)).size, target: childRemote(folder, `${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}-${safeFilename(path.basename(local))}`), projectName: binding.project.name, createdAt: new Date().toISOString(), sessionId, localPath: local, binding: structuredClone(binding) };
    this.store.transfers.unshift(transfer); await this.store.save(); this.changed(); void this.pump(); return transfer;
  }
  async retry(id: string) { const item = this.store.transfers.find(t => t.id === id); if (!item || item.status !== 'error') throw new Error('只能重试失败的传输'); if (item.cacheCleared) throw new Error('此上传缓存已清理，无法重试'); this.remote.channel(item.binding); item.status = 'queued'; item.error = undefined; await this.store.save(); this.changed(); void this.pump(); }
  private async pump() {
    if (this.active) return; this.active = true;
    try {
      for (;;) {
        const task = [...this.store.transfers].reverse().find(t => t.status === 'queued'); if (!task) break;
        task.status = 'running'; this.changed(); await this.store.save();
        try {
          if (task.sha256 && await hashFile(task.localPath) !== task.sha256) throw new Error('本地上传快照已改变，拒绝发送');
          await this.remote.ensurePersonalFolder(task.binding, path.posix.dirname(task.target));
          await this.remote.upload(task.binding, task.localPath, task.target, (bytes, total) => { task.bytes = bytes; task.total = total; this.changed(); }, task.metadata, task.sha256);
          task.status = 'done'; task.completedAt = new Date().toISOString(); task.bytes = task.total;
          if (task.kind === 'history') { const session = this.store.sessions.find(s => s.id === task.sessionId); if (session) { session.lastArchiveAt = task.completedAt; session.lastTrajectoryHash = task.trajectoryHash; } }
        }
        catch (e: any) { task.status = 'error'; task.error = e.message; }
        await this.store.save(); this.changed();
      }
    } finally { this.active = false; }
  }
}
