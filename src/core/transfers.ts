import { hashFile } from './artifacts';
import type { ContentMetadata } from '../shared/content';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { RemoteBinding, Transfer } from '../shared/types';
import { childRemote, assertRemote, safeFilename } from './paths';
import { SharedFiles } from './shared-files';
import { Store } from './store';
import { attachmentPath } from '../shared/attachments';
import { linkConclusionPublications } from './conclusion-publications';
export interface TransferInput { conclusionSourceId?: string; id?: string; dependsOn?: string[]; attachment?: boolean; name?: string; local: string; binding: RemoteBinding; folder: string; kind: Transfer['kind']; sessionId?: string; metadata?: ContentMetadata; trajectoryHash?: string }
export class TransferQueue {
  private active = false;
  private persisting = new Set<string>();
  constructor(private store: Store, private remote: SharedFiles, private changed: () => void) {}
  async enqueue(local: string, binding: RemoteBinding, folder: string, kind: Transfer['kind'], sessionId?: string, metadata?: ContentMetadata, trajectoryHash?: string, conclusionSourceId?: string) {
    return (await this.enqueueMany([{ local, binding, folder, kind, sessionId, metadata, trajectoryHash, conclusionSourceId }]))[0];
  }
  async enqueueMany(inputs: TransferInput[]): Promise<Transfer[]> {
    const transfers: Transfer[] = await Promise.all(inputs.map(async input => {
      assertRemote(input.binding.project.remoteRoot, input.folder);
      const id = input.id || randomUUID(), sha256 = await hashFile(input.local);
      return { id, sha256, conclusionSourceId: input.conclusionSourceId, attachment: input.attachment, dependsOn: input.dependsOn, metadata: input.metadata, trajectoryHash: input.trajectoryHash, kind: input.kind, name: input.name || path.basename(input.local), status: 'queued', bytes: 0, total: (await fsp.stat(input.local)).size, target: input.attachment ? attachmentPath(input.binding, sha256) : childRemote(input.folder, `${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}-${safeFilename(path.basename(input.local))}`), projectName: input.binding.project.name, createdAt: new Date().toISOString(), sessionId: input.sessionId, localPath: input.local, binding: structuredClone(input.binding) };
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
    const related = new Set([id, ...(item.dependsOn || [])]);
    for (const task of this.store.transfers) if (task.dependsOn?.some(dependency => related.has(dependency))) related.add(task.id);
    const retry = this.store.transfers.filter(task => related.has(task.id) && task.status === 'error');
    for (const task of retry) { if (task.cacheCleared) throw new Error('此上传缓存已清理，无法重试'); this.remote.channel(task.binding); }
    const previous = retry.map(task => ({ task, status: task.status, bytes: task.bytes, error: task.error, completedAt: task.completedAt }));
    for (const task of retry) { this.persisting.add(task.id); task.status = 'queued'; task.bytes = 0; task.error = undefined; task.completedAt = undefined; }
    try { await this.store.save(); }
    catch (error) { for (const { task, ...state } of previous) Object.assign(task, state); this.changed(); throw error; }
    finally { for (const task of retry) this.persisting.delete(task.id); }
    this.changed(); void this.pump();
  }
  private async pump() {
    if (this.active) return; this.active = true;
    try {
      for (;;) {
        const task = [...this.store.transfers].reverse().find(t => t.status === 'queued' && !this.persisting.has(t.id) && !(t.dependsOn || []).some(id => this.store.transfers.some(d => d.id === id && ['queued', 'running'].includes(d.status)))); if (!task) break;
        task.status = 'running'; this.changed();
        try {
          await this.store.save();
          if (task.dependsOn?.some(id => !this.store.transfers.some(item => item.id === id && item.status === 'done'))) throw new Error('附件上传失败，成果尚未发布；重试会保留已传好的文件');
          if (task.sha256 && await hashFile(task.localPath) !== task.sha256) throw new Error('本地上传快照已改变，拒绝发送');
          const progress = (bytes: number, total: number) => { task.bytes = bytes; task.total = total; this.changed(); };
          if (task.attachment) {
            const receipt = await this.remote.uploadAttachment(task.binding, task.localPath, task.sha256!, progress);
            if (receipt?.path !== task.target || receipt.sha256 !== task.sha256 || receipt.size !== task.total) throw new Error('附件上传回执校验失败，请确认服务端已更新');
          } else {
            await this.remote.ensurePersonalFolder(task.binding, path.posix.dirname(task.target));
            const receipt = await this.remote.upload(task.binding, task.localPath, task.target, progress, task.metadata, task.sha256);
            if (task.metadata?.attachments?.length && JSON.stringify(receipt?.attachments) !== JSON.stringify(task.metadata.attachments)) throw new Error('服务端未保留附件信息，请先更新服务端再重试');
          }
          task.status = 'done'; task.completedAt = new Date().toISOString(); task.bytes = task.total;
          linkConclusionPublications(this.store.conclusions, this.store.drafts, [task]);
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
