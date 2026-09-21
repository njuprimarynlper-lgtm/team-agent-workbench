import React, { useState } from 'react';
import { X } from 'lucide-react';

export function EnvironmentPreparation({ close, refresh }: { close: () => void; refresh: () => Promise<void> }) {
  const [source, setSource] = useState<'online' | 'offline'>('online');
  const [directory, setDirectory] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [result, setResult] = useState<{ environment: { setupIssues?: string[]; setupNotes?: string[] } }>();
  async function prepare() {
    setBusy(true); setError(''); setResult(undefined);
    try {
      setResult(await window.admin.call('operation', { op: 'environment_prepare', source, ...(source === 'offline' ? { packageDirectory: directory.trim() } : {}) }));
    } catch (error: any) { setError(error.message); }
    finally { setBusy(false); await refresh(); }
  }
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-label="准备运行环境">
    <header><h2>准备运行环境</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}><X size={19}/></button></header>
    <div className="modal-body">
      <p>补齐缺少的 ACL 或 Supervisor 组件，然后重新检查服务器。自动安装支持 Debian / Ubuntu。</p>
      <label className="field">准备方式<select aria-label="准备方式" disabled={busy} value={source} onChange={e => { setSource(e.target.value as typeof source); setResult(undefined); }}><option value="online">服务器软件源在线安装</option><option value="offline">使用服务器上的离线软件包</option></select></label>
      {source === 'offline' ? <label className="field">服务器离线包目录<input aria-label="服务器离线包目录" disabled={busy} value={directory} onChange={e => setDirectory(e.target.value)} placeholder="例如 /opt/workbench-packages"/><small>安装此目录内的 .deb 包，请只放置本次组件及其依赖，版本和架构须匹配服务器，目录由 root 管理。此方式不从软件源下载。</small></label> : <p className="muted small">使用服务器已有的软件源和网络配置；安装 ACL、Supervisor 所需的缺失组件和依赖。</p>}
      <p className="muted small">容器可能还需要接入启动脚本，才能在重启后恢复文件服务。完成后会显示具体步骤。</p>
      {busy && <div className="callout" role="status">正在准备并重新检查，可能需要几分钟…</div>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      {result && <div role="status"><b>{result.environment.setupIssues?.length ? '已执行准备，仍有以下条件需要处理：' : '当前运行环境已通过检查。'}</b>{result.environment.setupIssues?.map((text, i) => <p key={i}>{text}</p>)}{result.environment.setupNotes?.map((text, i) => <p key={i}>{text}</p>)}</div>}
    </div>
    <footer><button className="secondary" disabled={busy} onClick={close}>{result ? '关闭' : '取消'}</button><button className="primary" disabled={busy || (source === 'offline' && !directory.trim().startsWith('/'))} onClick={() => void prepare()}>{busy ? '准备中…' : result ? '重新准备' : '开始准备'}</button></footer>
  </section></div>;
}
