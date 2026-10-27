import React, { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { AgentSession } from '../shared/types';
import { formatElapsed, timingDurations, turnPhaseLabels, type TurnTiming, type TurnPhase } from '../shared/turn-timing';

export function MessageTime({ at }: { at: string }) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return null;
  return <time dateTime={at} title={date.toLocaleString('zh-CN')}>{date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })} {date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>;
}

export function TurnTimingSummary({ timing }: { timing: TurnTiming }) {
  const durations = timingDurations(timing, Date.parse(timing.updatedAt));
  const total = Object.values(durations).reduce((sum, ms) => sum + ms, 0);
  const outcome = timing.outcome === 'stopped' ? ' · 已停止' : timing.outcome === 'error' ? ' · 未完成' : timing.outcome === 'interrupted' ? ' · 记录中断' : '';
  return <details className="turn-timing-summary">
    <summary><ChevronRight size={13}/><span>{timing.thinkingObserved ? `已思考 ${formatElapsed(durations.thinking)} · ` : ''}{timing.partial ? '已记录用时' : '整轮用时'} {formatElapsed(total)}{outcome}</span></summary>
    <div className="turn-timing-details"><dl>{(Object.keys(turnPhaseLabels) as TurnPhase[]).filter(phase => phase === 'thinking' || durations[phase] > 0).map(phase => <React.Fragment key={phase}><dt>{turnPhaseLabels[phase]}</dt><dd>{phase === 'thinking' && !timing.thinkingObserved ? '未提供细分数据' : formatElapsed(durations[phase])}</dd></React.Fragment>)}</dl><p>{timing.partial ? '仅统计接入后观察到的时段。' : '按工作台收到的事件计时。'}未区分的时段计入其他处理与等待。</p></div>
  </details>;
}

export function SessionTurnProgress({ session }: { session: AgentSession }) {
  const active = !session.closedAt && ['running', 'starting', 'approval'].includes(session.status);
  const timing = session.turnTimings?.findLast(item => !item.finishedAt);
  const [at, setAt] = useState(Date.now);
  useEffect(() => {
    setAt(Date.now());
    if (!active || !timing) return;
    const timer = setInterval(() => setAt(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, session.id, timing?.id]);
  if (!active) return null;
  const phaseLabels: Record<TurnPhase, string> = { thinking: '思考中', tools: '正在执行工具', reply: '正在生成回复', approval: '等待确认', network: '等待连接', other: '正在处理' };
  const label = session.status === 'approval' || session.desktopWaitingApproval ? '等待确认' : session.status === 'starting' ? session.codexRemote ? '正在连接远程 Codex' : '正在连接本地 CLI' : session.cliConnection?.state === 'reconnecting' ? '正在重连' : session.cliConnection?.state === 'failed' ? '连接异常' : timing ? phaseLabels[timing.phase] : '正在处理';
  const durations = timing && timingDurations(timing, Math.max(at, Date.parse(timing.updatedAt)));
  return <div className="turn-progress"><span className="status-pulse"/><span role="status">{label}{session.cursorNative && (session.status === 'approval' || session.desktopWaitingApproval) ? '，请在 Cursor 中处理' : ''}</span>{timing && durations && <span className="turn-progress-clock" aria-label="本轮已用时间">{formatElapsed(Object.values(durations).reduce((sum, value) => sum + value, 0))}{timing.phase === 'thinking' && <> · 思考 {formatElapsed(durations.thinking)}</>}</span>}</div>;
}
