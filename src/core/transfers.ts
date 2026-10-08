import { submissionRecord, submissionRecordSchema } from '../shared/submission';
import { hashFile } from './artifacts';
import { contentMetadataSchema, type ContentMetadata } from '../shared/content';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { RemoteBinding, Transfer, TransferPhase } from '../shared/types';
import { childRemote, assertRemote, safeFilename } from './paths';
import { SharedFiles } from './shared-files';
import { Store } from './store';
import { attachmentPath } from '../shared/attachments';
import { linkConclusionPublications } from './conclusion-publications';
export interface TransferInput { conclusionSourceId?: string; id?: string; dependsOn?: string[]; attachment?: boolean; name?: string; local: string; binding: RemoteBinding; folder: string; kind: Transfer['kind']; sessionId?: string; metadata?: ContentMetadata; trajectoryHash?: string }
function failureMessage(task: Transfer, detail: string) {
  const prefix = task.phase === 'awaiting_receipt' ? '服务器可能已接收；重试会先查询原请求回执。' : task.phase === 'streaming' ? '传输中断，可能留有未完成的临时文件；重试会校验后从头传输。' : task.phase === 'verifying' ? '传输已结束但结果尚未通过校验；不会标记为成功。' : task.phase === 'rejected' ? '服务器已拒绝此次请求；重试前会重新核对账号和项目权限。' : '传输尚未开始。';
  return prefix + ' ' + detail;
}
export class TransferQueue {
  private active = false;
  private persisting = new Set<string>();
  constructor(private store: Store, private remote: SharedFiles, private changed: () => void) {}
  async enqueue(local: string, binding: RemoteBinding, folder: string, kind: Transfer['kind'], sessionId?: string, metadata?: ContentMetadata, trajectoryHash?: string, conclusionSourceId?: string) {
    return (await this.enqueueMany([{ local, binding, folder, kind, sessionId, metadata, trajectoryHash, conclusionSourceId }]))[0];
  }
  async enqueueDownload(binding: RemoteBinding, remotePath: string, localPath: string) {
    return (await this.enqueueMany([{ local: localPath, binding, folder: remotePath, kind: 'download' }]))[0];
  }
  async enqueueMany(inputs: TransferInput[]): Promise<Transfer[]> {
    const transfers: Transfer[] = await Promise.all(structuredClone(inputs).map(async input => {
      assertRemote(input.binding.project.remoteRoot, input.folder);
      const id = input.id || randomUUID();
      const metadata = input.kind === 'upload' && !input.attachment ? contentMetadataSchema.parse({ title: (input.name || path.basename(input.local)).slice(0, 200), description: '', kind: 'file', ...structuredClone(input.metadata), submission: input.metadata?.submission ? structuredClone(input.metadata.submission) : submissionRecord(input.binding, input.metadata?.sourceSessionTitle ? [{ kind: 'session', id: input.metadata.sourceSessionId, title: input.metadata.sourceSessionTitle, snapshotHash: input.metadata.snapshotHash }] : [{ kind: 'unknown' }]) }) : structuredClone(input.metadata);
      const fingerprint = input.kind === 'download' ? undefined : { sha256: await hashFile(input.local), size: (await fsp.stat(input.local)).size };
      const target = input.kind === 'download' ? input.folder : input.attachment ? attachmentPath(input.binding, fingerprint!.sha256) : childRemote(input.folder, `${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}-${safeFilename(path.basename(input.local))}`);
      return { id, requestId: input.kind === 'download' ? undefined : id, phase: 'queued' as const, sha256: fingerprint?.sha256, conclusionSourceId: input.conclusionSourceId, attachment: input.attachment, dependsOn: input.dependsOn, metadata, trajectoryHash: input.trajectoryHash, kind: input.kind, name: input.name || path.basename(input.kind === 'download' ? input.folder : input.local), status: 'queued' as const, bytes: 0, total: fingerprint?.size || 0, target, projectName: input.binding.project.name, createdAt: new Date().toISOString(), sessionId: input.sessionId, localPath: input.local, binding: structuredClone(input.binding) };
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
    const related = new Set([id, ...(item.dependsOn || [])]);
    for (const task of this.store.transfers) if (task.dependsOn?.some(dependency => related.has(dependency))) related.add(task.id);
    const retry = this.store.transfers.filter(task => related.has(task.id) && task.status === 'error');
    await this.remote.loadManifest();
    for (const task of retry) {
      if (task.cacheCleared) throw new Error('此上传缓存已清理，无法重试');
      this.remote.channel(task.binding);
      if (task.kind === 'download') {
        if (task.sha256) {
          const remote = await this.remote.downloadInfo(task.binding, task.target);
          if (remote.sha256 !== task.sha256 || remote.size !== task.total) throw new Error('远端文件内容已改变，原下载记录不能重试；请重新选择该文件');
        }
      } else if (!task.sha256 || await hashFile(task.localPath) !== task.sha256 || (await fsp.stat(task.localPath)).size !== task.total) throw new Error('本地上传快照已改变，原传输记录不能重试；请重新提交');
    }
    const previous = retry.map(task => ({ task, status: task.status, phase: task.phase, requestId: task.requestId, bytes: task.bytes, error: task.error, completedAt: task.completedAt }));
    for (const task of retry) { this.persisting.add(task.id); if (task.phase === 'rejected') task.requestId = randomUUID(); task.phase = 'queued'; task.status = 'queued'; task.bytes = 0; task.error = undefined; task.completedAt = undefined; }
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
          await this.remote.loadManifest(); this.remote.channel(task.binding);
          if (task.dependsOn?.some(id => !this.store.transfers.some(item => item.id === id && item.status === 'done'))) throw new Error('附件上传失败，成果尚未发布；重试会保留已传好的文件');
          if (task.kind !== 'download' && task.sha256 && await hashFile(task.localPath) !== task.sha256) throw new Error('本地上传快照已改变，拒绝发送');
          const progress = (bytes: number, total: number) => { task.bytes = bytes; task.total = total; this.changed(); };
          const phase = async (value: TransferPhase) => { task.phase = value; this.changed(); await this.store.save(); };
          if (task.kind === 'download') {
            if (!task.sha256) { const info = await this.remote.downloadInfo(task.binding, task.target); task.sha256 = info.sha256; task.total = info.size; await this.store.save(); this.changed(); }
            await phase('streaming');
            await this.remote.download(task.binding, task.target, task.localPath, progress, { sha256: task.sha256!, size: task.total });
            await phase('verifying');
            if (await hashFile(task.localPath) !== task.sha256 || (await fsp.stat(task.localPath)).size !== task.total) throw new Error('下载后校验失败，本地文件不能作为完整副本');
          } else if (task.attachment) {
            const receipt = await this.remote.uploadAttachment(task.binding, task.localPath, task.sha256!, progress, task.requestId || task.id, phase);
            if (receipt?.path !== task.target || receipt.sha256 !== task.sha256 || receipt.size !== task.total) throw new Error('附件上传回执校验失败，请确认服务端已更新');
          } else {
            await this.remote.ensurePersonalFolder(task.binding, path.posix.dirname(task.target));
            const receipt = await this.remote.upload(task.binding, task.localPath, task.target, progress, task.metadata, task.sha256, task.requestId || task.id, phase);
            if (receipt?.path !== task.target || receipt.sha256 !== task.sha256 || receipt.size !== task.total || receipt.author !== task.binding.username) throw new Error('上传回执与原账号、目标或内容不一致；已保留失败记录');
            if (receipt.submission) {
              const accepted = submissionRecordSchema.parse(receipt.submission);
              if (accepted.submittedBy !== task.binding.username || accepted.destination.projectId !== task.binding.project.id || accepted.destination.groupName !== task.binding.project.groupName) throw new Error('上传回执的提交账号或项目不一致');
              task.submission = accepted; if (task.metadata) task.metadata.submission = structuredClone(accepted);
            }
            if (task.metadata?.attachments?.length && JSON.stringify(receipt?.attachments) !== JSON.stringify(task.metadata.attachments)) throw new Error('服务端未保留附件信息，请先更新服务端再重试');
          }
          task.status = 'done'; task.phase = 'completed'; task.completedAt = new Date().toISOString(); task.bytes = task.total;
          linkConclusionPublications(this.store.conclusions, this.store.drafts, [task]);
          if (task.kind === 'history') { const session = this.store.sessions.find(s => s.id === task.sessionId); if (session) { session.lastArchiveAt = task.completedAt; session.lastTrajectoryHash = task.trajectoryHash; } }
          await this.store.save();
        }
        catch (e: any) {
          if (task.phase === 'completed') task.phase = 'verifying';
          task.status = 'error'; task.error = failureMessage(task, e.message);
          try { await this.store.save(); }
          catch (saveError: any) { task.error += '；传输状态保存失败：' + saveError.message + '。请恢复本地存储后重试，将复用原目标。'; }
        }
        this.changed();
      }
    } finally { this.active = false; }
  }
}
