import { contextualError } from './contextual-error';
import { ErrorLogLink } from './error-notice';
import React, { useEffect, useRef, useState } from 'react';
import type { PermissionMode, PermissionReport, Provider, SessionNetworkRoute } from '../shared/types';

import { permissionLabels, permissionEffects, permissionReportDescription } from '../shared/permission-presentation';
import { uiErrorMessage } from '../shared/user-failure';
export function PermissionSummary({ report, warningsOnly = false }: { report?: PermissionReport; warningsOnly?: boolean }) {
  if (!report) return warningsOnly ? null : <p className="muted small">权限尚未检测</p>;
  const warnings: string[] = [];
  if (report.warnings.some(warning => /无法读取.*权限配置|完整权限信息|无法读取管理员约束/.test(warning))) warnings.push('有些权限设置没读出来，目前不知道哪些操作需要你批准。点“重新检测权限”再试。');
  if (report.warnings.some(warning => /明确拒绝|拒绝规则/.test(warning))) warnings.push('已有明确拒绝规则；更换权限模式后，匹配这些规则的操作仍可能被拒绝。');
  if (report.warnings.some(warning => /白名单.*不会请求|自动允许/.test(warning))) warnings.push('已有自动允许的操作规则，这些操作可能不会再次请求批准。');
  if (report.execution === 'blocked') warnings.push('本机执行检查未通过。请先查看日志确认原因，再决定是否调整执行权限。');
  return <div className="permission-summary">{!warningsOnly && !warnings.length && <p>{permissionReportDescription(report)}</p>}{warnings.map(warning => <p className="callout small" role="status" key={warning}>{warning} <ErrorLogLink/></p>)}</div>;
}
export function PermissionPicker({ provider, cwd, networkRoute, mode, changed, api = window.workbench }: { api?: import('../shared/types').WorkbenchAPI; provider: Provider; cwd: string; networkRoute: SessionNetworkRoute; mode: PermissionMode; changed: (m: PermissionMode) => void }) {
  const [report, setReport] = useState<PermissionReport>(), [busy, setBusy] = useState(false), [error, setError] = useState(''); const sequence = useRef(0);
  const check = async () => { const n = ++sequence.current; setBusy(true); setError(''); try { const next = await api.call<PermissionReport>('provider.permissions', { provider, cwd, networkRoute }); if (n === sequence.current) setReport(next); } catch (error) { if (n === sequence.current) setError(contextualError(error, { domain: 'local', operation: '检测执行权限', provider, outcome: 'not-started' }, { FILE_MISSING: '上面这个工作目录找不到，所以没能检查执行权限。请在上方重新选择目录，再点“重新检测权限”。', FILE_ACCESS_DENIED: 'Windows 不允许读取这个目录的权限设置。请检查目录访问权限，再点“重新检测权限”。', UNCLASSIFIED_FAILURE: '这次没能读出执行权限。点“重新检测权限”再试。' })); } finally { if (n === sequence.current) setBusy(false); } };
  useEffect(() => { setReport(undefined); if (cwd) void check(); return () => { sequence.current++; }; }, [provider, cwd, networkRoute]);
  return <section className="permission-picker" aria-label="CLI 执行权限"><div className="row"><b>执行权限</b><span className="spacer"/><button type="button" className="text-button" disabled={busy || !cwd} onClick={() => void check()}>{busy ? '检测中…' : '重新检测权限'}</button></div><label className="field">权限模式<select aria-label="权限模式" value={mode} onChange={e => changed(e.target.value as PermissionMode)}>{(['inherit', 'review', 'auto', 'full'] as const).map(m => {
      const unavailable = provider === 'cursor' && m === 'auto';
      const restricted = !!report?.allowedModes && !report.allowedModes.includes(m);
      return <option key={m} value={m} disabled={unavailable || restricted}>{permissionLabels[provider][m]}{unavailable ? '（当前接入方式暂不支持）' : restricted ? '（管理员策略不允许）' : ''}</option>;
    })}</select></label>
    <p className="muted small">本机工作目录：<code>{cwd}</code></p>
    {mode !== 'inherit' && <p className="muted small">{permissionEffects[provider][mode]}</p>}
    {error && <p className="inline-error" role="alert">{error} <ErrorLogLink message={error}/></p>}<PermissionSummary report={report}/>
    {provider === 'cursor' && mode === 'review' && <details className="cursor-review-config"><summary>配置 Cursor Allowlist</summary><p>清空账号及当前目录的自动允许列表，启用白名单审批；保留拒绝规则并备份配置。会影响使用同一配置的其他 Cursor CLI 会话。</p>{report?.cursorConfig?.files.map(file => <code key={file}>{file}</code>)}<button className="secondary" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { const next = await api.call<PermissionReport>('provider.cursorReview', { cwd }); setReport(next); } catch (e: any) { setError(uiErrorMessage(e, { domain: 'local' })); } finally { setBusy(false); } }}>应用 Cursor Allowlist 配置</button></details>}
  </section>;
}
