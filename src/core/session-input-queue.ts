import { randomUUID } from 'node:crypto';
import type { AgentSession, QueuedSessionInput, SessionInput } from '../shared/types';

interface QueueHost {
  session(id: string): AgentSession;
  save(): Promise<unknown>;
  changed(): void;
  blocked(session: AgentSession): boolean;
  send(id: string, input: SessionInput, submitted: () => void): Promise<boolean>;
  steer(id: string, turnId: string, input: SessionInput): Promise<boolean>;
}

// A local, per-session FIFO. The provider remains the owner of execution context.
export class SessionInputQueue {
  private active = new Set<string>();
  private edits: Promise<unknown> = Promise.resolve();
  constructor(private host: QueueHost) {}
  private edit<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.edits.catch(() => {}).then(fn); this.edits = next; return next;
  }
  async enqueue(id: string, input: SessionInput) {
    return this.edit(async () => {
      const session = this.host.session(id);
      if (session.closedAt || session.cursorNative || session.purpose !== 'work') throw new Error('此会话不能加入待发送消息');
      if (!input.text.trim()) throw new Error('请输入任务内容');
      if (input.sourceIds.some(id => !session.sources.some(source => source.id === id))) throw new Error('引用不属于当前会话');
      if (!session.inputQueue?.items.length) session.inputQueue = { items: [], paused: !!session.stoppedAt || session.status === 'error' };
      const queue = session.inputQueue!;
      const item: QueuedSessionInput = { id: randomUUID(), input: structuredClone(input), state: 'queued' };
      queue.items.push(item);
      try { await this.host.save(); } catch (error) { queue.items = queue.items.filter(value => value !== item); throw error; }
      this.host.changed(); return true;
    });
  }
  async update(id: string, itemId: string, text?: string) {
    return this.edit(async () => {
      const session = this.host.session(id), queue = session.inputQueue;
      const item = queue?.items.find(value => value.id === itemId);
      if (!item || item.state !== 'queued') throw new Error('消息已开始发送，请等待发送结果');
      if (text !== undefined && !text.trim()) throw new Error('消息内容不能为空');
      const before = [...queue!.items], oldText = item.input.text;
      if (text === undefined) queue!.items = queue!.items.filter(value => value !== item);
      else item.input.text = text;
      try { await this.host.save(); } catch (error) { queue!.items = before; item.input.text = oldText; throw error; }
      this.host.changed(); return true;
    });
  }
  async pause(id: string, paused = true) {
    return this.edit(async () => {
      const session = this.host.session(id), queue = session.inputQueue;
      if (!queue) return true;
      const before = queue.paused, status = session.status, error = session.error; queue.paused = paused;
      if (!paused && session.status === 'error') { session.status = 'idle'; session.error = undefined; }
      try { await this.host.save(); } catch (reason) { queue.paused = before; session.status = status; session.error = error; throw reason; }
      this.host.changed(); return true;
    });
  }
  async steer(id: string, itemId: string, turnId: string) {
    // Lock synchronously against the dispatcher before awaiting disk or provider IO.
    if (this.active.has(id)) throw new Error('消息正在提交，请稍后引导');
    this.active.add(id);
    try {
      await this.edits.catch(() => {});
      const session = this.host.session(id), queue = session.inputQueue;
      const item = queue?.items.find(value => value.id === itemId);
      if (!item || item.state !== 'queued') throw new Error('消息已开始发送');
      item.state = 'sending'; this.host.changed();
      try {
        await this.host.save();
        if (!await this.host.steer(id, turnId, item.input)) throw new Error('引导未送达，消息已保留');
        queue!.items = queue!.items.filter(value => value !== item);
        // Once accepted, never put it back and accidentally execute it twice.
        await this.host.save();
      } catch (error: any) {
        if (queue!.items.includes(item)) { item.state = 'queued'; queue!.paused = true; queue!.error = error.message; }
        await this.host.save().catch(() => {});
        throw error;
      } finally { this.host.changed(); }
      return true;
    } finally { this.active.delete(id); }
  }
  async pump(id: string) {
    if (this.active.has(id)) return;
    this.active.add(id);
    try {
      await this.edits.catch(() => {});
      const session = this.host.session(id), queue = session.inputQueue;
      if (!queue?.items.length || queue.paused || this.host.blocked(session)) return;
      const item = queue.items[0];
      if (item.state !== 'queued') return;
      item.state = 'sending'; delete queue.error; this.host.changed();
      try {
        await this.host.save();
        // Stop/close/account changes can happen while saving.
        if (queue.paused || this.host.blocked(session)) { item.state = 'queued'; await this.host.save(); return; }
        const started = await this.host.send(id, item.input, () => {
          item.submitted = true; this.host.changed();
          void this.host.save().catch(() => {});
        });
        if (!started && !(item.submitted && (session.stoppedAt || session.closedAt))) throw new Error(session.error || '消息未能发送，请检查后继续');
        queue.items = queue.items.filter(value => value !== item);
        await this.host.save();
      } catch (error: any) {
        if (queue.items.includes(item)) { item.state = 'queued'; delete item.submitted; }
        queue.paused = true; queue.error = error.message;
        await this.host.save().catch(() => {});
      } finally { this.host.changed(); }
    } finally { this.active.delete(id); }
  }
}

export function recoverInputQueue(session: AgentSession) {
  const queue = session.inputQueue;
  if (!queue?.items.length) return;
  queue.paused = true;
  if (queue.items.some(item => item.state === 'sending')) queue.error = '上次发送结果尚未确认，请先核对对话，再继续队列。';
  for (const item of queue.items) { item.state = 'queued'; delete item.submitted; }
}
