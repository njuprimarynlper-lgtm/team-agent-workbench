import type { AgentRpc } from './rpc';
import type { CodexRequestGuard, GuardRequestSize } from './codex-request-guard';

export type AutoCompactionResult = { status: 'completed' | 'failed' | 'uncertain' | 'closed'; message?: string; turnId?: string };
type Job = {
  previousTurnId?: string; turnId?: string; itemCompleted: boolean; turnCompleted: boolean;
  acknowledged: boolean; error?: string; resolve: (result: AutoCompactionResult) => void; timer: ReturnType<typeof setTimeout>;
};

/** Per native thread, including borrowed forks. Never start from an HTTP callback:
 * the guard holds the request's scope lock until its response stream has ended. */
export class CodexAutoCompaction {
  private detach: () => void;
  private job?: Job;
  private pendingBytes = 0;
  private observedBytes = 0;
  private attemptedBytes = 0;
  private armed = true;
  private retryAfter = 0;
  private failures = 0;
  private disabled = false;
  private closed = false;
  private uncertain?: Job;
  private finishedTurns = new Set<string>();
  private rejection?: string;
  constructor(readonly guard: CodexRequestGuard, private rpc: AgentRpc, private threadId: () => string | undefined,
    private timeoutMs = 10 * 60_000) {
    this.detach = guard.observeRequests(request => this.observe(request));
  }
  get active() { return !!this.job; }
  get activeTurnId() { return this.job?.turnId; }
  get localRejection() { return this.rejection; }
  private observe(request: GuardRequestSize) {
    if (request.threadId !== this.threadId() || this.closed || this.job || this.uncertain) return;
    this.rejection = request.rejected;
    if (this.disabled) return;
    this.observedBytes = request.inputBytes;
    if (request.rejected) { this.pendingBytes = Math.max(this.pendingBytes, request.inputBytes); return; }
    if (request.inputBytes < request.budget * 0.6) { this.armed = true; return; }
    // If native compaction still leaves a large payload, do not compact every
    // turn. Rearm after a small request or substantial further history growth.
    if (request.inputBytes >= request.budget * 0.8 && Date.now() >= this.retryAfter
      && (this.armed || this.attemptedBytes > 0 && request.inputBytes >= this.attemptedBytes * 1.2))
      this.pendingBytes = Math.max(this.pendingBytes, request.inputBytes);
  }
  nativeCompacted() {
    this.attemptedBytes = Math.max(this.observedBytes, this.pendingBytes);
    this.pendingBytes = 0; this.rejection = undefined; this.armed = false;
  }
  discardPending() { this.pendingBytes = 0; this.rejection = undefined; }
  start(previousTurnId?: string, recovery = false): Promise<AutoCompactionResult> | undefined {
    if (!this.pendingBytes || this.job || this.closed || this.disabled || this.uncertain || Date.now() < this.retryAfter || recovery && !this.rejection) return;
    this.attemptedBytes = this.pendingBytes; this.pendingBytes = 0; this.rejection = undefined; this.armed = false;
    const threadId = this.threadId(); if (!threadId) return;
    let resolve!: Job['resolve'];
    const result = new Promise<AutoCompactionResult>(done => { resolve = done; });
    const job: Job = { previousTurnId, acknowledged: false, itemCompleted: false, turnCompleted: false, resolve,
      timer: setTimeout(() => {
        if (this.job !== job) return;
        // An RPC timeout does not cancel native work. Keep a barrier until the
        // turn is confirmed stopped; never send another turn into that window.
        this.complete({ status: 'uncertain', message: '自动压缩未能确认结束，后续消息已暂停；请稍后再发送或重新连接会话。' });
        if (job.turnId) void this.rpc.request('turn/interrupt', { threadId, turnId: job.turnId }, 5000).catch(() => {});
      }, this.timeoutMs) };
    this.job = job;
    void this.rpc.request('thread/compact/start', { threadId }, Math.min(this.timeoutMs, 60_000)).then(() => {
      job.acknowledged = true;
    }, error => {
      if (this.job !== job) return;
      // A structured JSON-RPC rejection before any turn started is definitive.
      // Transport errors and timeouts may have happened after native acceptance.
      const rejected = typeof error?.code === 'number' && !job.turnId;
      if (error?.code === -32601) this.disabled = true;
      this.complete({ status: rejected ? 'failed' : 'uncertain', message: rejected
        ? '本次自动压缩未执行，后续请求继续使用大小保护。'
        : '自动压缩的执行状态尚未确认，后续消息已暂停；请重新连接会话后继续。' });
    });
    return result;
  }
  /** Called before normal turn accounting or rendering. The compact RPC's empty
   * acknowledgement is not completion; both native lifecycle events are needed. */
  handle(method: string, p: any): boolean {
    if ((p.threadId || p.thread?.id) !== this.threadId()) return false;
    const turnId = p.turnId || p.turn?.id;
    if (this.finishedTurns.has(turnId)) return /^(turn\/|item\/|error$)/.test(method);
    const job = this.job;
    if (!job) {
      if (this.uncertain && /^(turn\/|item\/|error$)/.test(method)) {
        if (turnId && turnId === this.uncertain.previousTurnId) return true;
        if ((method === 'turn/started' || p.item?.type === 'contextCompaction') && turnId) this.uncertain.turnId ||= turnId;
        if (method === 'turn/completed' && turnId && turnId === this.uncertain.turnId) {
          this.remember(turnId); this.uncertain = undefined;
        }
        return true;
      }
      if (method === 'item/completed' && p.item?.type === 'contextCompaction') this.nativeCompacted();
      return false;
    }
    if (!/^(turn\/|item\/|error$)/.test(method)) return false;
    if (turnId && turnId === job.previousTurnId) return true; // duplicate original completion
    if (method === 'turn/started' && turnId) job.turnId ||= turnId;
    if (p.item?.type === 'contextCompaction' && turnId) job.turnId ||= turnId;
    if (!turnId || turnId !== job.turnId) return true;
    if (method === 'error' && !p.willRetry) job.error = p.error?.message;
    if (method === 'item/completed' && p.item?.type === 'contextCompaction') job.itemCompleted = true;
    if (method === 'turn/completed') {
      job.turnCompleted = true;
      if (p.turn?.error || p.turn?.status !== 'completed') {
        const detail = p.turn?.error?.message || job.error;
        this.complete({ status: 'failed', message: `原生 compact 未完成${detail ? '：' + detail : '；后续请求继续使用大小保护。'}` }); return true;
      }
    }
    if (job.itemCompleted && job.turnCompleted) this.complete({ status: 'completed' });
    return true;
  }
  private remember(turnId?: string) {
    if (turnId) this.finishedTurns.add(turnId);
    if (this.finishedTurns.size > 32) this.finishedTurns.delete(this.finishedTurns.values().next().value!);
  }
  private complete(result: AutoCompactionResult) {
    const job = this.job; if (!job) return;
    clearTimeout(job.timer); this.job = undefined;
    if (result.status === 'uncertain') this.uncertain = job;
    else this.remember(job.turnId);
    if (result.status === 'completed') { this.failures = 0; this.retryAfter = 0; }
    else {
      this.armed = true;
      this.retryAfter = Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(this.failures++, 5));
    }
    job.resolve({ ...result, turnId: job.turnId });
  }
  async assertReady() {
    if (this.closed) throw new Error('自动压缩所属的 CLI 连接已关闭，请重新连接会话');
    if (this.job) throw new Error('正在自动压缩上下文，消息可加入等待队列');
    if (!this.uncertain) return;
    // Require a known native turn as well as acknowledgement before trusting an
    // idle read: an accepted but not yet started operation may still be queued.
    const uncertain = this.uncertain;
    if (uncertain.acknowledged && uncertain.turnId) {
      const state = await this.rpc.request('thread/read', { threadId: this.threadId() }, 5000);
      if (this.closed) throw new Error('CLI 连接已关闭，请重新连接会话');
      if (!this.uncertain) return;
      if (['idle', 'notLoaded'].includes(state.thread?.status?.type)) {
        this.remember(this.uncertain?.turnId); this.uncertain = undefined; return;
      }
    }
    throw new Error('尚未确认自动压缩已结束，消息未发送；请稍后重试或重新连接会话。');
  }
  async cancel() {
    this.pendingBytes = 0;
    const job = this.job;
    if (job?.turnId) await this.rpc.request('turn/interrupt', { threadId: this.threadId(), turnId: job.turnId }, 5000);
    // Before turn/started, closing the runtime is the only reliable cancellation.
    return !!job?.turnId;
  }
  close() {
    this.closed = true; this.detach(); this.pendingBytes = 0;
    this.complete({ status: 'closed' });
  }
}
