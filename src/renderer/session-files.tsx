import React, { useEffect, useState } from 'react';
import type { FilePreview, SessionFile } from '../shared/types';
import { Copy, FolderOpen, RefreshCw } from 'lucide-react';

export function SessionFilesDialog({ sessionId, initialPath, close }: { sessionId: string; initialPath?: string; close: () => void }) {
  const [files, setFiles] = useState<SessionFile[]>([]), [preview, setPreview] = useState<FilePreview>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const show = async (target: string) => {
    setBusy(true); setError(''); setCopied(false);
    try { setPreview(await window.workbench.call<FilePreview>('session.file.preview', { id: sessionId, path: target })); }
    catch (error: any) { setError(error.message); } finally { setBusy(false); }
  };
  const load = async () => { setBusy(true); setError(''); try { setFiles(await window.workbench.call<SessionFile[]>('session.files', { id: sessionId })); } catch (error: any) { setError(error.message); } finally { setBusy(false); } };
  useEffect(() => { if (initialPath) void show(initialPath); else void load(); }, [sessionId, initialPath]);
  const act = async (action: 'copy' | 'reveal' | 'open') => {
    if (!preview) return; setError('');
    try { if (action === 'copy') { await window.workbench.call('copy', preview.path); setCopied(true); } else await window.workbench.call('session.file.open', { id: sessionId, path: preview.path, reveal: action === 'reveal' }); }
    catch (error: any) { setError(error.message); }
  };
  return <div className="modal-backdrop"><section className="modal wide session-files-modal" role="dialog" aria-modal="true" aria-labelledby="session-files-title"><header><h2 id="session-files-title">{preview ? preview.name : '会话文件'}</h2><button className="icon" aria-label="关闭窗口" onClick={close}>×</button></header><div className="modal-body">
    {error && <div className="inline-error" role="alert">{error}</div>}{busy && <p role="status">正在读取文件…</p>}
    {preview ? <><p className="muted small">完整路径</p><code className="session-file-path">{preview.path}</code><div className="row session-file-actions"><button className="secondary compact" onClick={() => void act('copy')}><Copy size={13}/>{copied ? '路径已复制' : '复制路径'}</button><button className="secondary compact" onClick={() => void act('reveal')}><FolderOpen size={13}/>打开所在文件夹</button>{!/\.(exe|com|bat|cmd|ps1|sh|msi|vbs|vbe|js|jse|wsf|wsh|scr|lnk|url|reg|hta)$/i.test(preview.path) && <button className="secondary compact" onClick={() => void act('open')}>用系统应用打开</button>}</div>{preview.type === 'text' ? <pre className="session-file-preview">{preview.content}</pre> : preview.type === 'image' ? <img className="session-file-image" src={preview.content} alt={preview.name}/> : <p className="muted">此格式暂不支持页面预览，可以使用系统应用打开，或定位到文件夹。</p>}{preview.truncated && <p className="muted small">文件较大，这里显示前 512 KB；完整内容请用系统应用打开。</p>}</> : <><p className="muted small">列出会话中生成、修改或提到且仍在本机的文件。点击名称查看内容与完整路径。</p><div className="session-file-list">{files.map(file => <button className="session-file-entry" key={file.path} onClick={() => void show(file.path)}><b>{file.name}</b><code>{file.path}</code><small>{Math.ceil(file.size / 1024)} KB · {new Date(file.modifiedAt).toLocaleString()}</small></button>)}</div>{!files.length && !busy && <p>尚未找到文件记录。AI 回复中的本地文件链接也可以直接点击查看。</p>}</>}
  </div><footer>{preview && <button className="secondary" onClick={() => { setPreview(undefined); void load(); }}>查看会话文件列表</button>}{!preview && <button className="secondary" disabled={busy} onClick={() => void load()}><RefreshCw size={13}/>刷新文件</button>}<button className="primary" onClick={close}>关闭</button></footer></section></div>;
}
