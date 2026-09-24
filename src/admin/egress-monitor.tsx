import React, { useEffect, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, Cpu, MemoryStick, Users } from 'lucide-react';
import type { AdminEgressSnapshot } from '../shared/egress';
import { cliConnectionAdvice, cliConnectionLabel } from '../shared/cli-connection';

export const traffic = (value: number) => value < 1024 ? Math.round(value) + ' B' : value < 1024 ** 2 ? (value / 1024).toFixed(1) + ' KB' : value < 1024 ** 3 ? (value / 1024 ** 2).toFixed(1) + ' MB' : (value / 1024 ** 3).toFixed(2) + ' GB';
export function trafficAxisCeiling(peak: number) {
  if (!Number.isFinite(peak) || peak <= 2) return 2;
  const unit = 1024 ** Math.floor(Math.log(peak) / Math.log(1024));
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find(value => value * unit >= peak) || 1024;
  return step * unit;
}
const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
const product = (value: string) => value === 'codex' ? 'Codex' : value === 'cursor' ? 'Cursor' : 'Claude Code';

export function EgressMonitorPanel({ snapshot }: { snapshot: AdminEgressSnapshot }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 2000); return () => clearInterval(timer); }, []);
  const monitor = snapshot.monitor, active = snapshot.running, resources = monitor?.process;
  const stale = !!monitor && now - Date.parse(monitor.sampledAt) > 10000;
  const live = active && !stale;
  const history = monitor?.history || [], peak = Math.max(0, ...history.flatMap(point => [point.upPerSecond, point.downPerSecond]));
  const axisMax = trafficAxisCeiling(peak);
  const points = (field: 'upPerSecond' | 'downPerSecond') => history.map((point, i) => `${i * 600 / Math.max(1, history.length - 1)},${76 - point[field] / axisMax * 68}`).join(' ');
  const state = !active ? '出口未运行' : !monitor ? '正在获取监控' : stale ? '监控暂未更新' : monitor.upPerSecond + monitor.downPerSecond > 0 ? '正在收发' : monitor.activeTunnels ? '已连接，等待数据' : '等待成员连接';
  return <section className="egress-monitor" aria-label="代理独立监控">
    <header><div><h2>代理监控</h2><span>仅统计本机代理 · 每 2 秒更新</span></div><span className={'relay-live ' + (live ? 'online' : '')}><i/>{state}</span></header>
    <div className="relay-metrics">
      <div><Users size={17}/><span>在线成员 / 隧道</span><strong>{live && monitor ? `${monitor.members.length} / ${monitor.activeTunnels}` : '—'}</strong><small>成员按账号标识与地址区分</small></div>
      <div><ArrowUp size={17}/><span>实时上行</span><strong>{live && monitor ? traffic(monitor.upPerSecond) + '/s' : '—'}</strong><small>累计 {traffic(monitor?.bytesUp || 0)}</small></div>
      <div><ArrowDown size={17}/><span>实时下行</span><strong>{live && monitor ? traffic(monitor.downPerSecond) + '/s' : '—'}</strong><small>累计 {traffic(monitor?.bytesDown || 0)}</small></div>
      <div><Cpu size={17}/><span>代理 CPU</span><strong>{live && resources ? resources.cpuPercent.toFixed(2) + '%' : '—'}</strong><small>占整机 CPU 总容量</small></div>
      <div><MemoryStick size={17}/><span>代理内存</span><strong>{live && resources ? traffic(resources.memoryBytes) : '—'}</strong><small>独立代理进程驻留内存</small></div>
    </div>
    <div className="relay-trend"><div className="relay-trend-label"><span><i className="up"/>上行 <i className="down"/>下行 · 最近 2 分钟</span><small>峰值 {traffic(peak)}/s</small></div>
      <div className="relay-trend-plot"><div className="relay-trend-y" aria-label="纵轴：每秒传输字节"><span>{traffic(axisMax)}/s</span><span>{traffic(axisMax / 2)}/s</span><span>0 B/s</span></div><div className="relay-trend-chart"><svg viewBox="0 0 600 84" preserveAspectRatio="none" role="img" aria-label="代理上下行速率趋势"><path d="M0 8H600 M0 42H600 M0 76H600" className="grid"/><path d="M0 8V76H600" className="axis"/><polyline points={points('upPerSecond')} className="up"/><polyline points={points('downPerSecond')} className="down"/></svg><div className="relay-trend-x" aria-label="横轴：时间"><span>{history.length ? time(history[0].at) : '—'}</span><span>{history.length ? time(history.at(-1)!.at) : '—'}</span></div></div></div>
      <div className="relay-summary"><span>成功建立 {monitor?.connections || 0} 条</span><span className={monitor?.failures ? 'problem' : ''}>连接失败 {monitor?.failures || 0}</span><span className={monitor?.rejections ? 'problem' : ''}>接入拒绝 {monitor?.rejections || 0}</span><small>{monitor ? `本次启动 ${time(monitor.startedAt)} · 更新 ${time(monitor.sampledAt)}` : '启用出口后开始统计'}</small></div>
    </div>
    {!!monitor?.members.length && <div className="storage-table-scroll relay-members"><table><thead><tr><th>在线成员</th><th>来源地址</th><th>目标</th><th>隧道</th><th>当前连接流量</th></tr></thead><tbody>{monitor.members.map(member => <tr key={JSON.stringify([member.username, member.address])}><td>{member.username || '未标识'}</td><td>{member.address}</td><td>{member.targets.join('、')}</td><td>{member.connections}</td><td>↑ {traffic(member.bytesUp)} · ↓ {traffic(member.bytesDown)}</td></tr>)}</tbody></table></div>}
    <div className="relay-cli"><h3><Activity size={16}/>用户端 CLI 状态</h3>
      {monitor?.cliReports.length ? <div className="storage-table-scroll"><table><thead><tr><th>成员 / 会话</th><th>产品</th><th>最新状态</th><th>上报时间</th></tr></thead><tbody>{monitor.cliReports.map(report => {
        const stale = now - Date.parse(report.updatedAt) > 90000;
        return <tr key={JSON.stringify([report.username, report.address, report.clientId, report.sessionId])}><td>{report.username || '未标识'}<small>{report.address} · {report.sessionId.slice(0, 8)}</small></td><td>{product(report.provider)}</td><td><span className={'relay-cli-state ' + (stale ? 'stale' : report.connection.state)}>{stale ? '状态已过期 · ' : ''}{cliConnectionLabel(report.connection)}</span>{cliConnectionAdvice(report.connection) && <small>{cliConnectionAdvice(report.connection)}</small>}</td><td>{time(report.updatedAt)}</td></tr>;
      })}</tbody></table></div> : <p>暂无上报。更新后的用户端会同步重连、HTTP 错误及恢复状态。</p>}
    </div>
    <footer>流量为隧道内转发字节，不含握手开销；统计随出口重启清零。CLI 状态由用户端上报，连接成功不代表模型请求成功。</footer>
  </section>;
}
