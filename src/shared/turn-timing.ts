import type { AgentSession, Message } from './types';

export type TurnPhase = 'thinking' | 'tools' | 'reply' | 'approval' | 'network' | 'other';
export type TurnOutcome = 'completed' | 'stopped' | 'error' | 'interrupted';
export interface TurnTiming {
  id: string; nativeTurnId?: string; userMessageId?: string; assistantMessageIds: string[];
  startedAt: string; updatedAt: string; finishedAt?: string; outcome?: TurnOutcome;
  phase: TurnPhase; phaseStartedAt: string; durations: Record<TurnPhase, number>;
  thinkingObserved: boolean; partial: boolean;
}
export const turnPhaseLabels: Record<TurnPhase, string> = {
  thinking: '思考', tools: '工具执行', reply: '生成回复', approval: '等待确认', network: '连接等待', other: '其他处理与等待',
};
export function timingDurations(timing: TurnTiming, at = Date.now()) {
  const durations = { ...timing.durations };
  if (!timing.finishedAt) durations[timing.phase] += Math.max(0, at - Date.parse(timing.phaseStartedAt));
  return durations;
}
export function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
export function messageTimingMap(session: Pick<AgentSession, 'turnTimings' | 'messages'>) {
  const index = new Map<string, { message: Message; position: number }>();
  session.messages.forEach((message, position) => {
    if (message.role !== 'assistant' || !message.text.trim() || message.kind === 'planSteps') return;
    for (const key of [message.id, message.nativeItemId, message.id.replace(/^native:/, '')]) if (key) index.set(key, { message, position });
  });
  const result = new Map<string, TurnTiming>();
  for (const timing of session.turnTimings || []) if (timing.finishedAt) {
    const last = timing.assistantMessageIds.map(id => index.get(id) || index.get(id.replace(/^native:/, ''))).filter(item => !!item).sort((a, b) => b.position - a.position)[0];
    if (last) result.set(last.message.id, timing);
    else if (timing.userMessageId) {
      // Stopped/failed turns may have only tools (or just the submitted prompt).
      // Keep their timing at that turn, never append old, pruned history below a new reply.
      const from = session.messages.findIndex(message => message.id === timing.userMessageId || message.nativeItemId === timing.userMessageId || message.id === 'native:' + timing.userMessageId);
      if (from < 0) continue;
      let end = from;
      while (end + 1 < session.messages.length && !(session.messages[end + 1].role === 'user' && !session.messages[end + 1].steering)) end++;
      result.set(session.messages[end].id, timing);
    }
  }
  return result;
}
export function messageTiming(session: Pick<AgentSession, 'turnTimings' | 'messages'>, message: Message) {
  return messageTimingMap(session).get(message.id);
}
export function interruptStoredTimings(session: Pick<AgentSession, 'turnTimings'>) {
  for (const timing of session.turnTimings || []) if (!timing.finishedAt) {
    timing.durations = timingDurations(timing, Date.parse(timing.updatedAt));
    timing.finishedAt = timing.updatedAt; timing.outcome = 'interrupted'; timing.partial = true;
  }
}
