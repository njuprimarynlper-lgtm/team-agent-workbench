import { randomUUID } from 'node:crypto';
import type { AgentSession, Message } from '../shared/types';
import { interruptStoredTimings, timingDurations, type TurnOutcome, type TurnPhase, type TurnTiming } from '../shared/turn-timing';

/** Local observation time only. Missing provider phase events remain unknown. */
export class TurnTimingTracker {
  private current?: TurnTiming;
  private items = new Map<string, 'thinking' | 'tools' | 'reply'>();
  private waits = new Set<'approval' | 'network'>();
  constructor(private session: AgentSession, private clock = Date.now) { interruptStoredTimings(session); }
  get active() { return !!this.current && !this.current.finishedAt; }
  begin(userMessageId?: string, nativeTurnId?: string, partial = false) {
    if (this.active) { if (nativeTurnId) this.current!.nativeTurnId = nativeTurnId; return; }
    const now = new Date(this.clock()).toISOString();
    this.items.clear(); this.waits.clear();
    this.current = { id: randomUUID(), userMessageId, nativeTurnId, assistantMessageIds: [], startedAt: now, updatedAt: now,
      phaseStartedAt: now, phase: 'other', durations: { thinking: 0, tools: 0, reply: 0, approval: 0, network: 0, other: 0 }, thinkingObserved: false, partial };
    (this.session.turnTimings ||= []).push(this.current);
  }
  message(message: Message) {
    if (!this.active) return;
    if (message.role === 'user' && !message.steering && !this.current!.userMessageId) this.current!.userMessageId = message.id;
    if (message.role === 'assistant' && !this.current!.assistantMessageIds.includes(message.id)) this.current!.assistantMessageIds.push(message.id);
    this.touch();
  }
  private touch() { if (this.active) this.current!.updatedAt = new Date(Math.max(this.clock(), Date.parse(this.current!.updatedAt))).toISOString(); }
  private phase() {
    if (!this.active) return;
    const values = [...this.items.values()];
    const next: TurnPhase = this.waits.has('approval') ? 'approval' : this.waits.has('network') ? 'network' : values.includes('tools') ? 'tools' : values.includes('thinking') ? 'thinking' : values.includes('reply') ? 'reply' : 'other';
    this.touch(); const timing = this.current!;
    timing.durations = timingDurations(timing, Date.parse(timing.updatedAt));
    timing.phaseStartedAt = timing.updatedAt; timing.phase = next;
  }
  wait(phase: 'approval' | 'network', enabled: boolean) {
    if (!this.active) return;
    enabled ? this.waits.add(phase) : this.waits.delete(phase); this.phase();
  }
  item(id: string, phase: 'thinking' | 'tools' | 'reply', complete = false) {
    if (!this.active) return;
    // A completed item alone does not reveal when its execution started.
    if (!complete) { this.items.set(id, phase); if (phase === 'thinking') this.current!.thinkingObserved = true; }
    else this.items.delete(id);
    this.phase();
  }
  chunk(phase: 'thinking' | 'reply') {
    this.items.delete('chunk:thinking'); this.items.delete('chunk:reply');
    this.item('chunk:' + phase, phase);
  }
  clearChunks() { this.items.delete('chunk:thinking'); this.items.delete('chunk:reply'); this.phase(); }
  finish(outcome: TurnOutcome = 'completed') {
    if (!this.active) return;
    this.phase(); this.current!.finishedAt = this.current!.updatedAt; this.current!.outcome = outcome;
    this.items.clear(); this.waits.clear();
  }
  codex(method: string, p: any) {
    if (method === 'turn/started') this.begin(undefined, p.turn?.id);
    if (!this.active) return;
    const kind = p.item?.type;
    const phase = kind === 'reasoning' ? 'thinking' : ['agentMessage', 'plan'].includes(kind) ? 'reply' : ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageGeneration'].includes(kind) ? 'tools' : undefined;
    if (phase && (method === 'item/started' || method === 'item/completed')) this.item(String(p.item.id), phase, method === 'item/completed');
    if (method.startsWith('item/reasoning/') && method.endsWith('Delta') && p.itemId) this.item(p.itemId, 'thinking');
    if (method === 'item/agentMessage/delta' && p.itemId) this.item(p.itemId, 'reply');
    if (method === 'turn/completed') this.finish(p.turn?.status === 'interrupted' ? 'stopped' : p.turn?.error || p.turn?.status === 'failed' ? 'error' : 'completed');
  }
  cursor(update: any) {
    if (update.sessionUpdate === 'agent_thought_chunk') this.chunk('thinking');
    if (update.sessionUpdate === 'agent_message_chunk') this.chunk('reply');
    if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
      this.clearChunks(); this.item(String(update.toolCallId), 'tools', ['completed', 'failed', 'cancelled'].includes(update.status));
    }
  }
  claude(event: any) {
    if (event.parent_tool_use_id) return;
    const e = event.event;
    if (event.type === 'stream_event') {
      const key = 'block:' + e?.index;
      if (e?.type === 'content_block_start' && ['thinking', 'text'].includes(e.content_block?.type)) this.item(key, e.content_block.type === 'thinking' ? 'thinking' : 'reply');
      if (e?.type === 'content_block_delta' && ['thinking_delta', 'text_delta'].includes(e.delta?.type)) this.item(key, e.delta.type === 'thinking_delta' ? 'thinking' : 'reply');
      if (e?.type === 'content_block_stop') { this.items.delete(key); this.phase(); }
    }
    if (event.type === 'assistant') for (const block of event.message?.content || []) if (block.type === 'tool_use') this.item(block.id, 'tools');
    if (event.type === 'user') for (const block of Array.isArray(event.message?.content) ? event.message.content : []) if (block.type === 'tool_result') this.item(block.tool_use_id, 'tools', true);
    if (event.type === 'result') this.finish(event.is_error ? 'error' : 'completed');
  }
}
