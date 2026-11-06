import { randomUUID } from 'node:crypto';
import type { AgentSession, QueuedSessionInput, SessionInput } from '../shared/types';

interface QueueHost {
  session(id: string): AgentSession;
  save(): Promise<unknown>;
  changed(): void;
  setDraft?(id: string, value: SessionInput): void;
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
  async enqueue(id: string, input: SessionInput, steerTurnId?: string) {
    const item = await this.add(id, input, steerTurnId);
    if (steerTurnId) {
      try { await this.steer(id, item.id, steerTurnId); }
      catch (error) {
        // A saved follow-up has its own retry action. Do not restore a second copy to the composer.
        if (item.state === 'queued' && item.steerTurnId && !item.failure) {
          item.failure = { message: error instanceof Error ? error.message : String(error) };
          await this.host.save().catch(() => {}); this.host.changed();
        }
      }
    }
    return true;
  }
  private add(id: string, input: SessionInput, steerTurnId?: string) {
    return this.edit(async () => {
      const session = this.host.session(id);
      if (session.closedAt || session.cursorNative || session.purpose !== 'work') throw new Error('此会话不能加入待发送消息');
      if (!input.text.trim()) throw new Error('请输入任务内容');
      if (input.sourceIds.some(id => !session.sources.some(source => source.id === id))) throw new Error('引用不属于当前会话');
      if (!session.inputQueue?.items.length) session.inputQueue = { ...session.inputQueue, items: [], paused: !!session.stoppedAt || session.status === 'error' };
      const queue = session.inputQueue!;
      const item: QueuedSessionInput = { id: randomUUID(), input: structuredClone(input), state: 'queued', steerTurnId };
      queue.items.push(item);
      try { await this.host.save(); } catch (error) { queue.items = queue.items.filter(value => value !== item); throw error; }
      this.host.changed(); return item;
    });
  }
  async update(id: string, itemId: string, text?: string) {
    return this.edit(async () => {
      const session = this.host.session(id), queue = session.inputQueue;
      const item = queue?.items.find(value => value.id === itemId);
      if (!queue || !item || item.state !== 'queued' || queue.editing?.itemId === itemId) throw new Error('消息已开始发送或编辑，请等待操作完成');
      if (text !== undefined && item.failure?.uncertain) throw Error('请先核对送达状态');
      if (text !== undefined && !text.trim()) throw new Error('消息内容不能为空');
      const index = queue.items.indexOf(item), oldText = item.input.text, removed = queue.removed;
      if (text === undefined) {
        if (!item.failure?.uncertain) queue.removed = [...(removed || []).slice(-9), { item, index, removedAt: Date.now(), before: queue.items[index-1]?.id, after: queue.items[index+1]?.id }];
        queue.items.splice(index, 1);
      }
      else item.input.text = text;
      try { await this.host.save(); } catch (error) { if (text === undefined) queue.items.splice(index, 0, item); queue.removed = removed; item.input.text = oldText; throw error; }
      this.host.changed(); return true;
    });
  }
  beginEdit(id: string, itemId: string, previousDraft: SessionInput) {
    return this.edit(async () => {
      const queue = this.host.session(id).inputQueue;
      const item = queue?.items.find(row => row.id === itemId);
      if (!queue || !item || item.state !== 'queued' || item.failure?.uncertain || queue.editing) throw Error('这条消息暂时不能编辑');
      queue.editing = { itemId, previousDraft };
      const draft = { ...structuredClone(item.input), editingQueueItemId: itemId };
      this.host.setDraft?.(id, draft);
      try { await this.host.save(); } catch (e) { delete queue.editing; this.host.setDraft?.(id, previousDraft); throw e; }
      this.host.changed(); return draft;
    });
  }
  finishEdit(id: string, itemId: string, draft: SessionInput, cancel: boolean) {
    return this.edit(async () => {
      const session = this.host.session(id), queue = session.inputQueue, edit = queue?.editing;
      const item = queue?.items.find(row => row.id === itemId);
      if (!queue || !edit || edit.itemId !== itemId || !item || draft.editingQueueItemId !== itemId) throw Error('编辑目标已变化');
      if (!cancel && (!draft.text.trim() || draft.sourceIds.some(i => !session.sources.some(s => s.id === i)))) throw Error('请检查消息内容及引用');
      const previous = item.input;
      if (!cancel) { const { editingQueueItemId, ...input } = draft; item.input = structuredClone(input); }
      delete queue.editing;
      const restored = { ...edit.previousDraft, editingQueueItemId: undefined };
      this.host.setDraft?.(id, restored);
      try { await this.host.save(); } catch (e) { queue.editing = edit; item.input = previous; this.host.setDraft?.(id, draft); throw e; }
      this.host.changed(); return restored;
    });
  }
  undoRemove(id: string, itemId: string) {
    return this.edit(async () => {
      const queue = this.host.session(id).inputQueue, removed = queue?.removed;
      const record = removed?.at(-1);
      if (!queue || !removed || !record || record.item.id !== itemId) throw Error('待恢复的消息已变化');
      const after = queue.items.findIndex(i => i.id === record.after), before = queue.items.findIndex(i => i.id === record.before);
      queue.items.splice(after >= 0 ? after : before >= 0 ? before + 1 : record.index, 0, record.item); removed.pop();
      try { await this.host.save(); } catch (e) { removed.push(record); queue.items = queue.items.filter(i => i.id !== itemId); throw e; }
      this.host.changed(); return true;
    });
  }
  requeue(id: string, itemId: string) {
    return this.edit(async () => {
      const queue = this.host.session(id).inputQueue, item = queue?.items.find(row => row.id === itemId);
      if (!item?.steerTurnId || item.state !== 'queued' || queue?.editing?.itemId === itemId || item.failure?.uncertain) throw Error('这条消息不能重新排队');
      const { steerTurnId, failure } = item; delete item.steerTurnId; delete item.failure;
      try { await this.host.save(); } catch (e) { Object.assign(item, { steerTurnId, failure }); throw e; }
      this.host.changed(); return true;
    });
  }
  async transfer<T>(id: string, itemId: string, create: (input: SessionInput) => Promise<T>, discard: (result: T) => Promise<void>) {
    const { queue, item } = await this.edit(async () => {
      const queue = this.host.session(id).inputQueue, item = queue?.items.find(row => row.id === itemId);
      if (!queue || !item || item.state !== 'queued' || queue.editing?.itemId === itemId || item.failure?.uncertain) throw Error('这条消息暂时不能转到侧聊');
      item.state = 'sending'; this.host.changed();
      return { queue, item };
    });
    let result: T | undefined;
    try {
      result = await create(structuredClone(item.input));
      await this.edit(async () => {
        if (this.host.session(id).inputQueue !== queue) throw Error('原会话已变化');
        const index = queue.items.indexOf(item);
        if (index < 0) throw Error('消息已移除');
        queue.items.splice(index, 1);
        try { await this.host.save(); } catch (error) { queue.items.splice(index, 0, item); throw error; }
      });
      return result;
    } catch (reason) {
      item.state = 'queued';
      if (result !== undefined) await discard(result);
      await this.host.save().catch(() => {});
      throw reason;
    } finally { this.host.changed(); }
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
  async move(id: string, itemId: string, beforeId?: string) {
    return this.edit(async () => {
      const queue = this.host.session(id).inputQueue;
      const item = queue?.items.find(value => value.id === itemId);
      const target = beforeId ? queue?.items.find(value => value.id === beforeId) : undefined;
      if (!queue || !item || item.state !== 'queued' || (beforeId && (!target || target.state !== 'queued'))) throw new Error('消息已开始发送或队列已变化，请重试');
      if (itemId === beforeId) return true;
      const previous = [...queue.items];
      queue.items = queue.items.filter(value => value.id !== itemId);
      queue.items.splice(target ? queue.items.indexOf(target) : queue.items.length, 0, item);
      try { await this.host.save(); } catch (error) {
        // A provider acknowledgement can consume its reserved row while this
        // save is pending. Restore order, never resurrect a consumed message.
        const order = new Map(previous.map((value, index) => [value.id, index]));
        queue.items.sort((a, b) => (order.get(a.id) ?? previous.length) - (order.get(b.id) ?? previous.length));
        throw error;
      }
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
      if (!item || item.state !== 'queued' || item.failure?.uncertain || queue?.editing?.itemId === itemId) throw new Error('消息正在处理或送达状态不明');
      if (item.input.nextTurnOnly) throw Error('这条消息已指定下一轮发送');
      if (item.steerTurnId && item.steerTurnId !== turnId) throw Error('原引导轮次已结束，可改为下一轮发送');
      // The queued row is already accepted. Compaction has no steerable turn.
      if (session.contextCompacting) { if (item.steerTurnId) await this.requeue(id, itemId); return true; }
      item.steerTurnId = turnId; delete item.failure;
      item.state = 'sending'; this.host.changed();
      try {
        await this.host.save();
        if (session.contextCompacting) { item.state = 'queued'; delete item.steerTurnId; await this.host.save(); return true; }
        if (!await this.host.steer(id, turnId, item.input)) throw new Error('引导未送达，消息已保留');
        queue!.items = queue!.items.filter(value => value !== item);
        // Once accepted, never put it back and accidentally execute it twice.
        await this.host.save();
      } catch (error: any) {
        if (queue!.items.includes(item)) { item.state = 'queued'; item.failure = { message: error.message, uncertain: /未能确认|尚未确认|超时|连接已关闭|进程已退出/.test(error.message) }; }
        await this.host.save().catch(() => {});
        throw error;
      } finally { this.host.changed(); }
      return true;
    } finally { this.active.delete(id); }
  }
  async pump(id: string, retryItemId?: string) {
    if (this.active.has(id)) { if (retryItemId) throw Error('消息正在提交'); return; }
    if (!retryItemId && this.host.blocked(this.host.session(id))) return;
    this.active.add(id);
    try {
      await this.edits.catch(() => {});
      const session = this.host.session(id), queue = session.inputQueue;
      const retry = retryItemId ? queue?.items.find(row => row.id === retryItemId) : undefined;
      if (retryItemId && (!retry?.failure || retry.failure.uncertain || retry.steerTurnId || retry.state !== 'queued' || queue?.editing?.itemId === retryItemId)) throw Error('这条消息不能重试');
      if (!queue?.items.length || (!retry && queue.paused)) return;
      if (retry && session.status === 'error' && session.error === queue.error) { session.status = 'idle'; delete session.error; }
      if (this.host.blocked(session)) { if (retry) throw Error('请在会话空闲后重试'); return; }
      const item = retry || queue.items.find(row => row.state === 'queued' && row.id !== queue.editing?.itemId && !row.steerTurnId && !row.failure?.uncertain);
      if (!item || item.state !== 'queued') return;
      item.state = 'sending'; delete item.failure; delete queue.error; this.host.changed();
      try {
        await this.host.save();
        // Stop/close/account changes can happen while saving.
        if ((!retry && queue.paused) || this.host.blocked(session)) { item.state = 'queued'; await this.host.save(); return; }
        const started = await this.host.send(id, item.input, () => {
          item.submitted = true; this.host.changed();
          void this.host.save().catch(() => {});
        });
        if (!started && !(item.submitted && (session.stoppedAt || session.closedAt))) throw new Error(session.error || '消息未能发送，请检查后继续');
        queue.items = queue.items.filter(value => value !== item);
        await this.host.save();
      } catch (error: any) {
        if (queue.items.includes(item)) {
          item.state = 'queued'; item.failure = { message: error.message, uncertain: !!item.submitted }; delete item.submitted;
        }
        queue.paused = true; queue.error = error.message;
        await this.host.save().catch(() => {});
      } finally { this.host.changed(); }
    } finally { this.active.delete(id); }
  }
}

export function recoverInputQueue(session: AgentSession, drafts?: Record<string, SessionInput>) {
  const queue = session.inputQueue;
  // The session ledger and draft ledger each use atomic writes. Repair a shutdown between the two.
  if (drafts) {
    const editing = queue?.editing, draft = drafts[session.id];
    const item = editing && queue?.items.find(row => row.id === editing.itemId);
    if (editing && !item) { drafts[session.id] = editing.previousDraft; delete queue!.editing; }
    else if (item && draft?.editingQueueItemId !== item.id) drafts[session.id] = { ...structuredClone(item.input), editingQueueItemId: item.id };
    else if (!editing && draft?.editingQueueItemId) delete draft.editingQueueItemId;
  }
  if (!queue?.items.length) return;
  queue.paused = true;
  if (queue.items.some(item => item.state === 'sending')) queue.error = '上次发送结果尚未确认，请先核对对话，再继续队列。';
  for (const item of queue.items) {
    if (item.steerTurnId && !item.failure && item.state === 'queued') item.failure = { message: '上次引导尚未提交，请核对轮次' };
    if (item.state === 'sending') item.failure = { message: '送达状态未确认，请先核对对话', uncertain: true };
    item.state = 'queued'; delete item.submitted;
  }
}
