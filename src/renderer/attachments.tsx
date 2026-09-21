import React, { useState } from 'react';
import type { Draft, DraftArtifact, FilePreview } from '../shared/types';
import type { SharedContent } from '../shared/content';

const api = window.workbench;
export const fileSize = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
function Preview({ file, close }: { file: FilePreview; close: () => void }) {
  return <div className="modal-backdrop"><section className="modal wide" role="dialog" aria-modal="true" aria-label="附件预览"><header><h2>{file.name}</h2><button className="icon" aria-label="关闭附件预览" onClick={close}>×</button></header><div className="modal-body">{file.type === 'image' ? <img style={{ maxWidth: '100%' }} src={file.content} alt={file.name}/> : file.type === 'text' ? <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{file.content}</pre> : <p>此格式暂不支持预览，请下载后查看。</p>}{file.truncated && <p className="muted small">仅预览前 512 KB。</p>}</div></section></div>;
}
export function DraftAttachments({ draft, artifact, locked, run }: { draft: Draft; artifact: DraftArtifact; locked: boolean; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const [preview, setPreview] = useState<FilePreview>();
  const entries = (artifact.attachments || []).map(entry => ({ ...entry, file: draft.files.find(file => file.id === entry.fileId) }));
  return <section className="artifact-attachments" aria-label={`成果附件：${artifact.title}`}><b>附件（已选 {entries.filter(entry => entry.selected).length} 个）</b>{entries.map(entry => <div className="row" key={entry.fileId}><label className="check-row"><input type="checkbox" aria-label={`上传附件：${entry.file?.name || '文件不可用'}`} checked={entry.selected} disabled={locked || !entry.file} onChange={event => void run(() => api.call('draft.attachment.select', { id: draft.id, artifactId: artifact.id, fileId: entry.fileId, selected: event.target.checked }))}/>{entry.file?.name || '文件不可用'} <small className="muted">{entry.file && fileSize(entry.file.size)}</small></label><button className="text-button" disabled={!entry.file} onClick={() => void run(async () => setPreview(await api.call<FilePreview>('draft.attachment.preview', { id: draft.id, fileId: entry.fileId })))}>预览</button></div>)}{!locked && <button className="text-button" onClick={() => void run(() => api.call('draft.attach', { id: draft.id, artifactId: artifact.id }))}>＋ 添加本地文件</button>}{preview && <Preview file={preview} close={() => setPreview(undefined)}/>}</section>;
}
export function SharedAttachments({ item, projectId }: { item: SharedContent; projectId: string }) {
  const [preview, setPreview] = useState<FilePreview>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const action = async (sha256: string, download: boolean) => { setBusy(true); setError(''); try { const result = await api.call<FilePreview>(download ? 'content.attachment.download' : 'content.attachment.preview', { projectId, contentId: item.id, sha256 }); if (!download) setPreview(result); } catch (error: any) { setError(error.message); } finally { setBusy(false); } };
  if (!item.attachments?.length) return null;
  return <section className="artifact-attachments" aria-label="成果附件"><h3>附件（{item.attachments.length}）</h3>{item.attachments.map(file => <div className="row" key={file.sha256}><span>{file.name}</span><small className="muted">{fileSize(file.size)}</small><button className="text-button" disabled={busy} onClick={() => void action(file.sha256, false)}>预览</button><button className="text-button" disabled={busy} onClick={() => void action(file.sha256, true)}>下载附件</button></div>)}{error && <p className="inline-error" role="alert">{error}</p>}{preview && <Preview file={preview} close={() => setPreview(undefined)}/>}</section>;
}
