'use strict';

// Child-process adapter for Cursor CLI 2026.09.10-fd3934a. ACP does not expose
// /summarize: use the CLI's native ConversationAction and checkpoint writer.
// Never edit the installed bundle, SQLite database, blob IDs or history.
const { createHash } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const guardedRuns = new AsyncLocalStorage();
const BUDGET = 1_000_000;
const SESSION_MODULE = './src/acp/agent-session.ts';
const SERVICES_MODULE = './src/acp/shared-services.ts';
const fingerprints = {
  [SESSION_MODULE]: 'bced7965f1279c8f365d45f8a92e10396448bf99910273313305399b7e45aa2c',
  [SERVICES_MODULE]: '76035ed5ec839769694ee5c31cd55b908d97e359f481c911f96e143f98dfcef2',
};
const hash = value => createHash('sha256').update(value).digest('hex');
const tooLarge = () => Object.assign(new Error('Cursor 请求在压缩后仍达到 1 MB，已在上传前停止。单条消息、附件或工具结果过大时，请缩小内容后继续；原会话历史未被截断。'), { code: 'WB_CURSOR_REQUEST_TOO_LARGE' });

/** Guard actual, already gzip-encoded HTTP bodies, including native summarize.
 * Cursor's HTTP/1 transport uses separate unary BidiAppend requests and an SSE
 * response. Do not buffer an HTTP/2 bidirectional stream (that would deadlock).
 */
function guardRequest(request, budget = BUDGET) {
  const write = request.write, end = request.end;
  let chunks = [], bytes = 0, overflow = false, ended = false;
  const collect = (chunk, encoding) => {
    if (chunk == null) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
    bytes += data.length;
    if (bytes >= budget) { overflow = true; chunks = []; }
    else if (!overflow) chunks.push(data);
  };
  request.write = function(chunk, encoding, callback) {
    if (ended) return write.call(this, chunk, encoding, callback);
    collect(chunk, encoding);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(() => done());
    return true;
  };
  request.end = function(chunk, encoding, callback) {
    if (ended) return end.call(this, chunk, encoding, callback);
    ended = true;
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
    if (typeof encoding === 'function') callback = encoding;
    collect(chunk, encoding);
    if (overflow) { guardedRuns.getStore()?.onOversize(); this.destroy(tooLarge()); return this; }
    const body = Buffer.concat(chunks, bytes); chunks = [];
    return end.call(this, body, callback);
  };
  return request;
}

async function runGuarded(run, args) {
  const [ctx, cancel] = args[0].withCancel();
  let oversized = false;
  try {
    const value = await guardedRuns.run({ onOversize() { oversized = true; cancel(); } }, () => run(ctx, ...args.slice(1)));
    if (oversized) throw tooLarge();
    return value;
  } catch (error) { throw oversized ? tooLarge() : error; }
  finally { cancel(); }
}
function installHttpGuard() {
  for (const name of ['node:http', 'node:https']) {
    const module = require(name), original = module.request;
    module.request = function(...args) {
      const request = original.apply(this, args);
      if (/\/(?:aiserver\.v1\.BidiService\/BidiAppend(?:\?|$)|agent\.v1\.AgentService\/)/.test(request.path || '')) guardRequest(request);
      return request;
    };
  }
}

// A fresh snapshot of the model-visible prompt only. Archived history and UI
// turns are deliberately excluded, otherwise every turn would recompact forever.
async function promptBytes(ctx, state, blobs) {
  let bytes = 0;
  const seen = new Set();
  for (const id of state.rootPromptMessagesJson || []) {
    if (ctx.canceled) throw Error('Cursor 上下文检查已取消');
    const key = Buffer.from(id).toString('hex');
    if (seen.has(key)) continue;
    seen.add(key);
    const blob = await blobs.getBlob(ctx, id);
    if (!(blob instanceof Uint8Array)) throw Error('Cursor 上下文记录不完整，未执行自动压缩');
    bytes += blob.byteLength;
  }
  return bytes;
}
function summaryStamp(state) {
  return JSON.stringify({ summary: state.summary && Buffer.from(state.summary).toString('hex'),
    archives: (state.summaryArchives || []).map(id => Buffer.from(id).toString('hex')),
    legacy: state.summaryArchive && Buffer.from(state.summaryArchive).toString('hex'), count: state.selfSummaryCount });
}

class CursorCompaction {
  constructor(run, types, notify = () => {}, now = Date.now, timeoutMs = 10 * 60_000) {
    this.run = run; this.types = types; this.notify = notify; this.now = now; this.timeoutMs = timeoutMs;
    this.armed = true; this.attemptedBytes = 0; this.retryAfter = 0; this.failures = 0; this.busy = false; this.uncertain = false;
  }
  eligible(bytes) {
    if (bytes < BUDGET * .8) this.armed = true;
    return bytes >= BUDGET && this.now() >= this.retryAfter && (this.armed || bytes >= this.attemptedBytes * 1.2);
  }
  async compact(args, bytes, phase) {
    const [ctx, state, , , , , blobs, , checkpoint, , options] = args;
    if (state.pendingToolCalls?.length || ctx.canceled || !this.eligible(bytes)) return;
    this.attemptedBytes = bytes; this.armed = false;
    const before = summaryStamp(state), beforeId = options.conversationId;
    const [compactCtx, cancel] = ctx.withCancel();
    let timedOut = false, timer;
    const native = [...args];
    native[0] = compactCtx;
    native[2] = new this.types.ConversationAction({ action: { case: 'summarizeAction', value: new this.types.SummarizeAction() } });
    native[4] = { sendUpdate: async () => {}, query: async () => { throw Error('原生摘要意外请求交互，已停止'); } };
    native[7] = this.types.controlled();
    // All writes still go through the native checkpoint handler, on the same
    // session. Keeping original turn/archive references is Cursor's job.
    native[10] = { ...options, endlessRetries: () => false };
    this.notify({ status: 'started', phase, inputBytes: bytes });
    try {
      const operation = runGuarded(this.run, native);
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
        timedOut = true; this.uncertain = true; cancel(); reject(Error('Cursor 自动压缩超时，请重新连接会话后继续'));
      }, this.timeoutMs); });
      // A timeout is not a settled native job. Block all future turns until the
      // original operation settles; no concurrent prompt/checkpoint writers.
      void operation.finally(() => { if (timedOut) this.uncertain = false; }).catch(() => {});
      await Promise.race([operation, timeout]);
      if (compactCtx.canceled) throw Error('Cursor 自动压缩已取消');
      const after = checkpoint.getLatestCheckpoint();
      if (options.conversationId !== beforeId || !after || summaryStamp(after) === before
        || !after.rootPromptMessagesJson?.length || JSON.stringify(after.rootPromptMessagesJson) === JSON.stringify(state.rootPromptMessagesJson))
        throw Error('Cursor 未确认保存新的原生摘要');
      await blobs.flush?.(compactCtx);
      this.failures = 0; this.retryAfter = 0;
      this.notify({ status: 'completed', phase });
    } catch (error) {
      this.armed = true;
      this.retryAfter = this.now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(this.failures++, 5));
      this.notify({ status: timedOut ? 'uncertain' : 'failed', phase, message: error.message });
      if (timedOut || ctx.canceled) throw error;
      // Native gzip + the wire guard remain in force even when compaction fails.
    } finally { clearTimeout(timer); cancel(); }
  }
  async execute(...args) {
    if (this.busy || this.uncertain) throw Error('Cursor 正在压缩上下文，请等待或重新连接会话');
    this.busy = true;
    try {
      const [ctx, , action, , , , blobs, , checkpoint] = args;
      if (action.action?.case !== 'userMessageAction') return await runGuarded(this.run, args);
      let state = checkpoint.getLatestCheckpoint();
      const stamp = summaryStamp(state);
      await this.compact(args, await promptBytes(ctx, state, blobs), 'before');
      if (ctx.canceled || this.uncertain) throw Error('Cursor 上下文压缩尚未结束，消息未发送');
      state = checkpoint.getLatestCheckpoint();
      args[1] = state; // Never reuse the pre-compaction snapshot.
      const userStamp = summaryStamp(state);
      const result = await runGuarded(this.run, args);
      if (ctx.canceled) return result;
      state = checkpoint.getLatestCheckpoint();
      const bytes = await promptBytes(ctx, state, blobs);
      // Respect Cursor's automatic compaction during the ordinary user turn.
      if (summaryStamp(state) !== userStamp) { this.armed = false; this.attemptedBytes = bytes; }
      else if (summaryStamp(state) === stamp) {
        args[1] = state;
        await this.compact(args, bytes, 'after');
      }
      return result;
    } finally { this.busy = false; }
  }
}

function wrapServicesRequire(original) {
  const wrapped = id => {
    const exports = original(id);
    if (id !== './src/client.ts') return exports;
    // Local in-memory network preference only. Cursor's native gzip and proxy,
    // credentials, CA roots, and endpoint selection remain owned by Cursor.
    return { ...exports, hO: (credentials, options) => exports.hO(credentials, { ...options, serverHttp2Config: undefined,
      configProvider: new Proxy(options.configProvider, { get(target, key) {
        if (key === 'get') return () => { const value = target.get(); return { ...value, network: { ...value.network, useHttp1ForAgent: true } }; };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } }) }) };
  };
  return Object.assign(wrapped, original);
}
function patchSession(exports, webpack) {
  const Session = exports.m;
  const proto = webpack('../proto/dist/generated/agent/v1/agent_pb.js');
  const controlled = webpack('../agent-core/dist/conversation-actions/controlled.js');
  if (!Session?.prototype?.processPrompt || proto.ConversationAction?.typeName !== 'agent.v1.ConversationAction'
    || proto.SummarizeAction?.typeName !== 'agent.v1.SummarizeAction' || typeof controlled.h !== 'function')
    throw Error('当前 Cursor CLI 的自动压缩接口不兼容，请使用工作台配套版本');
  const original = Session.prototype.processPrompt;
  Session.prototype.processPrompt = async function(...args) {
    if (!Object.hasOwn(this, '__workbenchCompaction')) {
      const client = this.sharedServices.agentClient;
      const controller = new CursorCompaction(client.run.bind(client), { ...proto, controlled: () => new controlled.h() }, update => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: '_workbench/cursorCompaction', params: { sessionId: this.sessionId, ...update } }) + '\n');
      });
      this.__workbenchCompaction = controller;
      this.sharedServices = { ...this.sharedServices, agentClient: new Proxy(client, { get(target, key) {
        if (key === 'run') return controller.execute.bind(controller);
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } }) };
    }
    return original.apply(this, args);
  };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: '_workbench/cursorGuardReady', params: { version: 1, budget: BUDGET } }) + '\n');
}
function patchChunk(chunk) {
  const modules = chunk?.modules;
  if (!modules?.[SESSION_MODULE] && !modules?.[SERVICES_MODULE]) return false;
  for (const [id, expected] of Object.entries(fingerprints)) {
    if (typeof modules[id] !== 'function' || hash(modules[id].toString()) !== expected)
      throw Error('当前 Cursor CLI 版本尚未适配 1 MB 自动压缩，请使用工作台配套的 Cursor CLI');
  }
  const services = modules[SERVICES_MODULE];
  modules[SERVICES_MODULE] = (module, exports, webpack) => services(module, exports, wrapServicesRequire(webpack));
  const session = modules[SESSION_MODULE];
  modules[SESSION_MODULE] = (module, exports, webpack) => {
    // Wrap webpack's async-module completion, not minified source or exports.
    const wrapped = Object.assign(id => webpack(id), webpack);
    wrapped.a = (mod, body, asyncFlag) => webpack.a(mod, (dependencies, done) => body(dependencies, error => {
      if (!error) { try { patchSession(exports, webpack); } catch (failure) { error = failure; } }
      done(error);
    }), asyncFlag);
    return session(module, exports, wrapped);
  };
  return true;
}
function install() {
  installHttpGuard();
  const Module = require('node:module'), load = Module._extensions['.js'];
  Module._extensions['.js'] = function(module, filename) {
    load(module, filename);
    if (/[/\\]\d+\.index\.js$/.test(filename)) {
      try { patchChunk(module.exports); }
      catch { process.stderr.write('[WB_CURSOR_COMPACTION_UNSUPPORTED]\n'); }
      // The parent requires the ready notification before authentication or a
      // prompt. Unknown modules stay intact and cannot silently bypass protection.
    }
  };
}
module.exports = { BUDGET, guardRequest, runGuarded, promptBytes, summaryStamp, CursorCompaction, patchChunk, wrapServicesRequire, install };
