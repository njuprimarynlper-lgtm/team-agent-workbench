import React, { useEffect, useState } from 'react';
import type { AdminSnapshot } from './types';
import type { AdminEgressConfig, ReverseEgressSnapshot } from '../shared/egress';

export function EgressJumpSettings({ remote, config, reverse, refresh }: { remote: AdminSnapshot; config: AdminEgressConfig; reverse?: ReverseEgressSnapshot; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const targets = remote.state?.egressJumpTargets || [], host = config.publicHost, port = config.listenPort;
  useEffect(() => { setMessage(''); setError(''); }, [remote.profile?.host, remote.profile?.port, remote.profile?.root, host, port]);
  const allowed = targets.some(target => target.host === host && target.port === port);
  const ready = remote.connected && remote.verified && remote.role === 'administrator' && remote.profile?.mode !== 'local' && remote.state?.initialized;
  const connected = reverse?.state === 'connected' && reverse.memberAccessConfigured;
  const reverseAction = async (action: 'enable' | 'disable' | 'copy' | 'test') => {
    setBusy(true); setMessage(''); setError('');
    try {
      await window.admin.call('egress.reverse.' + action); await refresh();
      setMessage({ enable: '反向隧道已启用。首次使用的成员请断开共享连接后重新登录，并粘贴中转接入码。', disable: '反向隧道已停用，管理端出口和其他管理员的隧道继续运行。', copy: '中转接入码已复制，请使用新版用户端。', test: '本机 → 共享服务器 → 本机出口的连接、证书和接入码校验通过。' }[action]);
    } catch (reason: any) { setError(reason.message); await refresh().catch(() => {}); }
    finally { setBusy(false); }
  };
  const run = async (op: 'egress_jump' | 'egress_jump_probe', target = { host, port }, enabled = true) => {
    setBusy(true); setMessage(''); setError('');
    try {
      await window.admin.call('operation', { op, ...target, enabled }); await refresh();
      setMessage(op === 'egress_jump_probe' ? `共享服务器可连接 ${target.host}:${target.port}（TCP）。用户端登录后可检测完整中转链路。` : enabled ? '已允许中转。需要使用此出口的成员请断开共享连接后重新登录。' : '已移除中转地址，旧成员共享连接已断开，请重新登录。');
    } catch (reason: any) { setError(reason.message); await refresh().catch(() => {}); }
    finally { setBusy(false); }
  };
  return <section className="egress-card egress-jump"><header><div><h3>共享服务器中转</h3><small>用户端 → 共享服务器 → 管理端 → 模型服务</small></div><span className={'egress-state ' + (connected ? 'online' : '')}>{connected ? '中转可用' : reverse?.enabled ? '等待连接' : '未启用'}</span></header>
    <div className="egress-form">
      <p>管理端主动建立反向隧道，复用共享服务器的 SSH 端口{remote.profile && remote.profile.mode !== 'local' ? `（${remote.profile.port}）` : ''}。共享服务器无需连接本机 IP，也无需新增对外端口。</p>
      {reverse?.enabled && <div className="egress-reverse-status" role="status"><strong>{reverse.detail}</strong><span>连接 {reverse.activeConnections} · 重连 {reverse.reconnects}{reverse.remotePort ? ` · 内部端口 ${reverse.remotePort}` : ''}</span></div>}
      {!ready && <p className="muted">请先以 root / sudo 管理账号连接并初始化 Linux 共享服务器。</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}{message && <p className="admin-success" role="status">{message}</p>}
      {!config.enabled && <p className="muted">请先在上方启用管理端出口。</p>}
      <div className="egress-jump-actions">
        {connected ? <><button className="primary" disabled={busy || remote.busy} onClick={() => void reverseAction('copy')}>复制中转接入码</button><button className="secondary" disabled={busy || remote.busy} onClick={() => void reverseAction('test')}>检测完整隧道</button></> : <button className="primary" disabled={!ready || !config.enabled || busy || remote.busy} onClick={() => void reverseAction('enable')}>{reverse?.state === 'connected' ? '完成成员接入' : reverse?.enabled ? '重新连接反向隧道' : '启用反向隧道'}</button>}
        {reverse?.enabled && <button className="text-button" disabled={busy || remote.busy} onClick={() => void reverseAction('disable')}>停用中转</button>}
      </div>
      <details><summary>直接连接管理端（可选）</summary><div className="egress-jump-target"><span>当前已保存出口{allowed ? ' · 已允许直连中转' : ''}</span><code>{host}:{port}</code></div><div className="egress-jump-actions"><button className="secondary" disabled={!ready || busy || remote.busy} onClick={() => void run('egress_jump_probe')}>测试服务器到出口</button><button className="secondary" disabled={!ready || busy || remote.busy || allowed} onClick={() => void run('egress_jump')}>{allowed ? '已允许直连中转' : '允许此出口中转'}</button></div></details>
      {targets.length > 0 && <details><summary>管理允许的出口（{targets.length}）</summary><p className="muted small">移除地址会断开全体成员现有的共享连接和中转请求，使旧权限立即失效。成员需重新登录。</p>{targets.map(target => <div className="egress-jump-target" key={target.host + ':' + target.port}><code>{target.host}:{target.port}</code><button className="text-button danger" disabled={!ready || busy || remote.busy} onClick={() => void run('egress_jump', target, false)}>移除并断开成员连接</button></div>)}</details>}
    </div>
  </section>;
}
