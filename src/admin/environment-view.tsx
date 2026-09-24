import React, { useState } from 'react';
import { X } from 'lucide-react';

export function EnvironmentPreparation({ close, refresh, server, issues }: { close: () => void; refresh: () => Promise<void>; server?: string; issues: string[] }) {
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
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-label="修复远端服务器环境">
    <header><h2>修复远端服务器环境</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}><X size={19}/></button></header>
    <div className="modal-body">
      <div className="admin-target">操作位置：<b>{server || '当前连接的 Linux 服务器'}</b></div>
      <p>问题出在远端 Linux 服务器，本机 Windows 无需安装。只有点击“在服务器执行修复”后，管理端才会通过当前 SSH 连接，在服务器上安装缺失组件并重新检查；打开此窗口不会执行安装。</p>
      {!!issues.length && <div className="environment-findings"><b>当前服务器检查结果</b>{issues.map((issue, index) => <p key={index}>{issue}</p>)}</div>}
      <label className="field">服务器安装方式<select aria-label="服务器安装方式" disabled={busy} value={source} onChange={e => { setSource(e.target.value as typeof source); setError(''); setResult(undefined); }}><option value="online">在线：由服务器从其软件源下载</option><option value="offline">离线：使用已放在服务器上的安装包</option></select></label>
      {source === 'offline' ? <label className="field">服务器上的离线包目录（Linux 路径）<input aria-label="服务器上的离线包目录" disabled={busy} value={directory} onChange={e => setDirectory(e.target.value)} placeholder="例如 /opt/workbench-packages"/><small>请先把匹配服务器版本和架构的 .deb 包及全部依赖放到该目录，目录须由 root 管理。管理端不会从本机上传安装包，也不会联网下载；确认后会在服务器上执行离线安装。</small></label> : <p className="muted small">确认后，程序通过 SSH 让服务器执行 apt-get，使用服务器已有的软件源和网络配置下载、安装缺失的 ACL / Supervisor 组件及依赖；本机不下载软件包。服务器能访问内网软件源也可以。</p>}
      <p className="muted small">自动安装目前支持 Debian / Ubuntu。SSH、Python 或账号管理命令缺失时，需在服务器上手动补齐后点击“重新检查服务器”。容器可能还需在启动流程中接入服务脚本，完成后会显示具体要求。</p>
      {busy && <div className="callout" role="status">正在远端服务器上执行并重新检查，可能需要几分钟…</div>}
      {error && <div className="inline-error" role="alert">服务器操作失败：{error}</div>}
      {result && <div role="status"><b>{result.environment.setupIssues?.length ? '已执行远端修复，仍有以下条件需要处理：' : '远端服务器环境已通过检查。'}</b>{result.environment.setupIssues?.map((text, i) => <p key={i}>{text}</p>)}{result.environment.setupNotes?.map((text, i) => <p key={i}>{text}</p>)}</div>}
    </div>
    <footer><button className="secondary" disabled={busy} onClick={close}>{result ? '关闭' : '取消'}</button><button className="primary" disabled={busy || (source === 'offline' && !directory.trim().startsWith('/'))} onClick={() => void prepare()}>{busy ? '服务器执行中…' : result ? '重新在服务器执行' : '在服务器执行修复'}</button></footer>
  </section></div>;
}
