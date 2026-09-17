import React, { useEffect, useRef, useState } from 'react';
import type { AgentSession, PermissionMode, PermissionReport, Provider } from '../shared/types';

import { permissionLabels, permissionEffects, permissionReportDescription, sessionPermissionDescription } from '../shared/permission-presentation';
export { sessionPermissionDescription } from '../shared/permission-presentation';
export function PermissionSummary({ report }: { report?: PermissionReport }) {
  if (!report) return <p className="muted small">权限尚未检测</p>;
  return <div className="permission-summary"><p>{permissionReportDescription(report)}</p></div>;
}
export function PermissionPicker({ provider, cwd, mode, changed }: { provider: Provider; cwd: string; mode: PermissionMode; changed: (m: PermissionMode) => void }) {
  const [report, setReport] = useState<PermissionReport>(), [busy, setBusy] = useState(false), [error, setError] = useState(''); const sequence = useRef(0);
  const check = async () => { const n = ++sequence.current; setBusy(true); setError(''); try { const next = await window.workbench.call<PermissionReport>('provider.permissions', { provider, cwd }); if (n === sequence.current) setReport(next); } catch (e: any) { if (n === sequence.current) setError('权限检测失败：' + e.message); } finally { if (n === sequence.current) setBusy(false); } };
  useEffect(() => { setReport(undefined); if (cwd) void check(); return () => { sequence.current++; }; }, [provider, cwd]);
  return <section className="permission-picker" aria-label="CLI 执行权限"><div className="row"><b>执行权限</b><span className="spacer"/><button type="button" className="text-button" disabled={busy || !cwd} onClick={() => void check()}>{busy ? '检测中…' : '重新检测权限'}</button></div><label className="field">权限模式<select aria-label="权限模式" value={mode} onChange={e => changed(e.target.value as PermissionMode)}>{(['inherit', 'review', 'auto', 'full'] as const).map(m => {
      const unavailable = provider === 'cursor' && m === 'auto';
      const restricted = !!report?.allowedModes && !report.allowedModes.includes(m);
      return <option key={m} value={m} disabled={unavailable || restricted}>{permissionLabels[provider][m]}{unavailable ? '（当前接入方式暂不支持）' : restricted ? '（管理员策略不允许）' : ''}</option>;
    })}</select></label>
    {mode !== 'inherit' && <p className="muted small">{permissionEffects[provider][mode]}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}<PermissionSummary report={report}/>
    {provider === 'cursor' && mode === 'review' && <details className="cursor-review-config"><summary>配置 Cursor Allowlist</summary><p>清空账号及当前目录的自动允许列表，启用白名单审批；保留拒绝规则并备份配置。会影响使用同一配置的其他 Cursor CLI 会话。</p>{report?.cursorConfig?.files.map(file => <code key={file}>{file}</code>)}<button className="secondary" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { const next = await window.workbench.call<PermissionReport>('provider.cursorReview', { cwd }); setReport(next); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>应用 Cursor Allowlist 配置</button></details>}
  </section>;
}
export function SessionPermissions({ session, close }: { session: AgentSession; close: () => void }) {
  const [mode, setMode] = useState<PermissionMode>(session.permissionMode || 'inherit'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const running = ['running', 'approval', 'starting'].includes(session.status);
  return <div className="modal-backdrop"><section className="modal"><header><h2>会话执行权限</h2><button className="secondary" onClick={close}>关闭</button></header><div className="modal-body"><p>会话：{session.title}。修改后需手动继续任务。</p><p>{sessionPermissionDescription(session)}</p><PermissionPicker provider={session.provider} cwd={session.cwd} mode={mode} changed={setMode}/>{running && <p>应用将停止当前任务并取消未处理授权。</p>}{error && <p className="inline-error" role="alert">{error}</p>}</div><footer><button className="secondary" onClick={close}>取消</button><button className="primary" disabled={busy || session.status === 'starting'} onClick={async () => { setBusy(true); try { await window.workbench.call('session.permissions', { id: session.id, mode, stop: running }); close(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>{running ? '停止当前任务并应用' : '应用到此会话'}</button></footer></section></div>;
}
