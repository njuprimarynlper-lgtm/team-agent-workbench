import React, { useEffect, useState } from 'react';
import { guardCertificateProblem, guardNetworkMessage, guardNetworkStageLabels, parseGuardNetworkProblem, type GuardConnectionCheck } from '../shared/guard-network';

export function CodexRequestGuardSetting({ enabled, disabled, changed, certificateFile = '', certificateChanged, chooseCertificate, testConnection }: {
  enabled: boolean; disabled?: boolean; changed: (value: boolean) => void; certificateFile?: string; certificateChanged?: (value: string) => void;
  chooseCertificate?: () => Promise<string>; testConnection?: (route: 'direct' | 'management') => Promise<GuardConnectionCheck>;
}) {
  const [testing, setTesting] = useState(false), [result, setResult] = useState<GuardConnectionCheck>(), [route, setRoute] = useState<'direct' | 'management'>('direct');
  const [expanded, setExpanded] = useState(!!certificateFile);
  return <section aria-label="Codex 请求大小保护"><div className="row"><strong>Codex 请求大小保护（1 MB）</strong><span className="spacer"/><button type="button" role="switch" className="project-ai-switch" aria-label="Codex 请求大小保护（1 MB）" aria-checked={enabled} disabled={disabled} onClick={() => changed(!enabled)}><span/></button></div>
    <p className="muted small">上传正文必须小于 1 MB（1,000,000 字节）。已超限的请求会先自动压缩，仍超限再摘要历史；无法安全缩小时停止发送。历史摘要会增加等待时间和模型用量，也可能遗漏信息。</p>
    <p className="muted small">首次使用默认开启，此后沿用上次保存的开关状态。开关保存后对新启动或重新连接的本机 Codex 生效，已连接会话保持原设置。共用后台的子会话沿用该后台设置。暂不覆盖 Codex 桌面同步、远程会话及其他 Agent。</p>
    {certificateChanged && <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>企业证书与连接检测</summary>
      <p className="muted small">自动使用系统及 Codex 已配置的信任证书；需要补充时再选择企业 CA 证书。证书保存后从下一次请求连接生效。</p>
      <fieldset disabled={disabled || testing} style={{ border: 0, padding: 0, margin: 0 }}>
        <label className="field">企业证书（选填）<div className="row"><input aria-label="企业证书路径" value={certificateFile} placeholder="自动使用已有信任证书" onChange={event => { certificateChanged(event.target.value); setResult(undefined); }}/><button type="button" className="secondary compact" onClick={async () => { try { const file = await chooseCertificate?.(); if (file) { certificateChanged(file); setResult(undefined); } } catch { setResult({ ok: false, message: '无法选择证书，请重试。' }); } }}>选择证书</button>{certificateFile && <button type="button" className="text-button" onClick={() => { certificateChanged(''); setResult(undefined); }}>清除</button>}</div></label>
        <div className="row"><select aria-label="检测使用的网络" value={route} onChange={event => { setRoute(event.target.value as typeof route); setResult(undefined); }}><option value="direct">本机网络</option><option value="management">经管理端转发</option></select><button type="button" className="secondary compact" onClick={async () => { setTesting(true); setResult(undefined); try { setResult(await testConnection?.(route)); } catch { setResult({ ok: false, message: '检测未完成，请确认所选网络出口已配置。' }); } finally { setTesting(false); } }}>{testing ? '正在检测…' : '检测连接'}</button></div>
      </fieldset>
      {result && <div className={result.ok ? 'muted small' : 'inline-error'} role={result.ok ? 'status' : 'alert'}>{result.message}{result.problem && <details><summary>查看详情</summary>{guardNetworkStageLabels[result.problem.stage]} · {result.problem.code} · 未切换网络通路</details>}</div>}
    </details>}</section>;
}

export function GuardConnectionError({ message, configure, testConnection, children }: { message: string; configure?: () => void; testConnection?: () => Promise<GuardConnectionCheck>; children?: React.ReactNode }) {
  const [testing, setTesting] = useState(false), [result, setResult] = useState<GuardConnectionCheck>();
  useEffect(() => { setResult(undefined); }, [message]);
  const original = parseGuardNetworkProblem(message), problem = result?.problem || original;
  if (!original || !problem) return <>{children}</>;
  return <div className={result?.ok ? 'muted small' : 'inline-error'} role={result?.ok ? 'status' : 'alert'}>
    <p style={{ margin: '0 0 6px' }}>{result?.ok ? '连接检查通过，可继续对话。' : result?.message || guardNetworkMessage(problem) + ' 当前回复未完成。'}</p>
    <div className="row">{!result?.ok && configure && <button className="text-button" type="button" onClick={configure}>{guardCertificateProblem(problem) ? '设置企业证书' : '检查连接'}</button>}
    {testConnection && <button className="text-button" type="button" disabled={testing} onClick={async () => { setTesting(true); try { setResult(await testConnection()); } catch { setResult({ ok: false, message: '检测未完成，请在 agent管理 中检查证书和网络设置。' }); } finally { setTesting(false); } }}>{testing ? '正在检测…' : '重新检测'}</button>}</div>
    {!result?.ok && <details><summary>查看详情</summary>{guardNetworkStageLabels[problem.stage]} · {problem.code} · 未切换网络通路</details>}
  </div>;
}
