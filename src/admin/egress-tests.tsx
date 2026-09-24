import React from 'react';
import type { AdminEgressSnapshot } from '../shared/egress';

export const egressServices = [{ id: 'codex', label: 'Codex' }, { id: 'cursor', label: 'Cursor' }, { id: 'claude', label: 'Claude Code' }] as const;
export type EgressService = typeof egressServices[number]['id'];
export type EgressTestResult = { ok: boolean; detail: string };

export function EgressNetworkTests({ snapshot, busy, testing, results, pendingChanges, onTest }: {
  snapshot: AdminEgressSnapshot; busy: boolean; testing?: EgressService; results: Partial<Record<EgressService, EgressTestResult>>; pendingChanges: boolean; onTest: (provider: EgressService) => void;
}) {
  return <section className="egress-card egress-tests">
    <header><div><h3>管理端网络测试</h3><small>无需在本机安装或启动对应 CLI。测试使用已保存的网络设置，不改变成员转发权限。</small></div></header>
    {pendingChanges && <p className="egress-test-note">有未应用的修改，当前测试仍使用已保存的设置。</p>}
    <div className="egress-test-grid">{egressServices.map(service => <div className="egress-test-service" key={service.id}>
      <div><strong>{service.label}</strong><span className={'egress-service-access ' + (snapshot.config[service.id] ? 'allowed' : '')}>{snapshot.config[service.id] ? '允许成员转发' : '未允许成员转发'}</span></div>
      <button className="secondary" disabled={busy} onClick={() => onTest(service.id)}>{testing === service.id ? '正在测试…' : `测试 ${service.label}`}</button>
      {results[service.id] && <small role={results[service.id]!.ok ? 'status' : 'alert'} className={'egress-test-result ' + (results[service.id]!.ok ? 'passed' : 'failed')}>{results[service.id]!.detail}</small>}
    </div>)}</div>
    <p className="egress-test-note">检查管理端到服务地址的网络连接；成员的模型登录、配额与实际请求状态在用户端查看。</p>
  </section>;
}
