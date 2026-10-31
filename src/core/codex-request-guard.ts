import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentRpc } from './rpc';
import { guardHeaders, guardRequest, guardNetworkEnvironment, guardProbe } from './codex-guard-transport';
import { GuardNetworkError } from './codex-guard-trust';
import { guardHash, guardHistory, redactedMediaSummaryItem, replaceGuardHistory, summaryRequest, type ResponseBody } from './codex-guard-history';

/** Exclusive limit for every outgoing HTTP body, including summary requests. */
export const codexRequestBudget = 1_000_000;
const memoryLimit = 32 * 1024 * 1024, readLimit = 64 * 1024 * 1024, ttl = 3600000;
const summaryRawTarget = 200_000, summaryTimeout = 240_000, maxSummaries = 16;
const compress = promisify(zlib.zstdCompress);
type Encoded = { bytes: Buffer; encoding?: string };
type CacheEntry = { scope: string; key: string; prefixHash: string; end: number; summary: string; bytes: number; used: number };
class RetryableSummaryError extends Error {}
class GuardSizeError extends Error {}
export interface GuardOptions { upstream: string; compression: boolean; env?: NodeJS.ProcessEnv; budget?: number; certificateFile?: () => string; }
export interface GuardStats { forwarded: number; summaries: number; summaryInputTokens: number; summaryOutputTokens: number; cacheHits: number; rejected: number; maxUploadBytes: number; }
export interface GuardRequestSize { threadId: string; inputBytes: number; budget: number; rejected?: string; }

async function readBody(source: AsyncIterable<Uint8Array>, limit: number) {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of source) { bytes += chunk.length; if (bytes > limit) throw new Error('请求内容过大，原推理请求未上传'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks, bytes);
}
async function decoded(body: Buffer, encoding?: string) {
  try {
    if (!encoding || encoding === 'identity') return body;
    const decompress = ({ zstd: zlib.zstdDecompress, gzip: zlib.gunzip, deflate: zlib.inflate, br: zlib.brotliDecompress } as Record<string, any>)[encoding];
    if (!decompress) throw Error();
    return await new Promise<Buffer>((resolve, reject) => decompress(body, { maxOutputLength: readLimit }, (error: Error | null, value: Buffer) => error ? reject(error) : resolve(value)));
  } catch { throw new Error('无法安全读取超限请求的压缩正文，原推理请求未上传'); }
}

// A summary is a separate inference. Native turn headers identify the original
// request and must never be reused for this independent request.
function isolatedSummaryHeaders(headers: http.OutgoingHttpHeaders) {
  const next = { ...headers };
  for (const name of ['thread-id', 'session-id', 'session_id', 'x-codex-session-id', 'x-session-id', 'x-codex-turn-metadata',
    'x-codex-turn-state', 'x-codex-window-id', 'x-codex-parent-thread-id', 'x-codex-routing-hint',
    'x-openai-subagent']) delete next[name];
  next['x-client-request-id'] = randomUUID();
  next.accept = 'text/event-stream';
  next['accept-encoding'] = 'identity';
  return next;
}

function safeDiagnostic(value: unknown, limit = 80) {
  return typeof value === 'string' && value.length <= limit && /^[A-Za-z0-9_.-]+$/.test(value) ? value : undefined;
}

async function summaryHttpFailure(response: http.IncomingMessage, encoded: Encoded) {
  let raw = Buffer.alloc(0);
  try { raw = await readBody(response, 16 * 1024); } catch { /* Response bodies are untrusted and never shown verbatim. */ }
  finally { response.destroy(); }
  let error: any;
  try { error = JSON.parse(raw.toString('utf8'))?.error; } catch { /* HTML and other non-JSON errors are identified by status and content type. */ }
  const details = [`HTTP ${response.statusCode || 0}`];
  for (const [label, value] of [['类型', error?.type], ['代码', error?.code], ['参数', error?.param]] as const) {
    const safe = safeDiagnostic(value); if (safe) details.push(`${label} ${safe}`);
  }
  const contentType = /^([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+)/.exec(String(response.headers['content-type'] || ''))?.[1];
  if (contentType) details.push(`响应 ${contentType}`);
  const requestId = safeDiagnostic(response.headers['x-request-id'] || response.headers['openai-request-id'], 128);
  if (requestId) details.push(`上游请求 ${requestId}`);
  details.push(`上传 ${encoded.bytes.length} 字节${encoded.encoding ? `/${encoded.encoding}` : ''}`);
  const message = `历史摘要请求失败（${details.join('；')}），原推理请求未上传`;
  return error?.code === 'server_is_overloaded' || [502, 503, 504].includes(response.statusCode || 0)
    ? new RetryableSummaryError(message) : new Error(message);
}

function summaryResultFailure(reason: string, response: http.IncomingMessage, encoded: Encoded, retryable = false) {
  const details = [reason];
  const requestId = safeDiagnostic(response.headers['x-request-id'] || response.headers['openai-request-id'], 128);
  if (requestId) details.push(`上游请求 ${requestId}`);
  details.push(`上传 ${encoded.bytes.length} 字节${encoded.encoding ? `/${encoded.encoding}` : ''}`);
  const message = `历史摘要未完整完成或返回了非文本结果（${details.join('；')}），原推理请求未上传`;
  return retryable ? new RetryableSummaryError(message) : new Error(message);
}

/** Under-budget bodies are byte-identical; only oversized requests are re-encoded. */
export async function encodeGuardBody(body: Buffer, encoding: string | undefined, compression: boolean, budget = codexRequestBudget): Promise<Encoded | undefined> {
  if (body.length < budget) return { bytes: body, encoding };
  const raw = await decoded(body, encoding);
  if (raw.length < budget) return { bytes: raw };
  if (compression) { const bytes = await compress(raw); if (bytes.length < budget) return { bytes, encoding: 'zstd' }; }
}

export class CodexRequestGuard {
  readonly stats: GuardStats = { forwarded: 0, summaries: 0, summaryInputTokens: 0, summaryOutputTokens: 0, cacheHits: 0, rejected: 0, maxUploadBytes: 0 };
  private server: http.Server;
  private controllers = new Set<AbortController>();
  private sockets = new Set<import('node:net').Socket>();
  private cache: CacheEntry[] = [];
  private queues = new Map<string, Promise<unknown>>();
  private requestObservers = new Set<(request: GuardRequestSize) => void>();
  private readonly secret = randomBytes(24).toString('hex');
  private closed = false;
  private closeJob?: Promise<void>;
  private url = '';
  private readonly upstream: URL;
  private readonly env: NodeJS.ProcessEnv;
  private readonly budget: number;
  constructor(private options: GuardOptions) {
    this.upstream = new URL(options.upstream);
    if (!['http:', 'https:'].includes(this.upstream.protocol) || this.upstream.username || this.upstream.password || this.upstream.hash) throw new Error('请求保护不支持此上游地址');
    this.env = { ...process.env, ...options.env }; this.budget = options.budget ?? codexRequestBudget;
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
    this.server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
    this.server.on('clientError', (_error, socket) => socket.destroy());
    this.server.requestTimeout = 120000; this.server.headersTimeout = 15000;
  }
  async start() {
    if (this.closed) throw new Error('请求保护已关闭');
    if (this.url) return this.url;
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); }); });
    this.url = `http://127.0.0.1:${(this.server.address() as import('node:net').AddressInfo).port}/${this.secret}`;
    return this.url;
  }
  close() {
    if (this.closeJob) return this.closeJob;
    this.closed = true; for (const controller of this.controllers) controller.abort();
    for (const socket of this.sockets) socket.destroy();
    this.cache = []; this.requestObservers.clear();
    return this.closeJob = new Promise<void>(resolve => this.server.close(() => resolve()));
  }
  observeRequests(listener: (request: GuardRequestSize) => void) {
    this.requestObservers.add(listener);
    return () => { this.requestObservers.delete(listener); };
  }
  async probe() {
    if (this.closed) throw new Error('连接检测已关闭');
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 30000);
    try { return await guardProbe(this.upstream, this.env, this.options.certificateFile?.(), controller.signal); }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  private prune() {
    this.cache = this.cache.filter(item => item.used > Date.now() - ttl).sort((a, b) => b.used - a.used);
    let bytes = 0; this.cache = this.cache.filter((item, index) => (bytes += item.bytes) <= memoryLimit && index < 128);
  }
  private store(entry: CacheEntry) {
    this.cache = this.cache.filter(item => !(item.key === entry.key && item.end === entry.end)); this.cache.unshift(entry); this.prune();
  }
  private async serial<T>(key: string, action: () => Promise<T>) {
    const previous = this.queues.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(action); this.queues.set(key, result);
    try { return await result; } finally { if (this.queues.get(key) === result) this.queues.delete(key); }
  }
  private target(suffix: string, query: string) {
    const target = new URL(this.upstream); target.pathname = target.pathname.replace(/\/$/, '') + suffix;
    const params = new URLSearchParams(query); for (const [key, value] of params) target.searchParams.set(key, value);
    return target;
  }
  private async send(target: URL, headers: http.OutgoingHttpHeaders, encoded: Encoded, signal: AbortSignal, method = 'POST', responseTimeout = 120000) {
    if (encoded.bytes.length >= this.budget) throw new Error('请求大小保护阻止了超限上传');
    if (signal.aborted || this.closed) throw new Error('请求已取消');
    this.stats.maxUploadBytes = Math.max(this.stats.maxUploadBytes, encoded.bytes.length);
    const next = { ...headers }; delete next['content-encoding'];
    if (encoded.encoding) next['content-encoding'] = encoded.encoding;
    return guardRequest(target, next, encoded.bytes, this.env, signal, method, this.options.certificateFile?.(), 15000, responseTimeout);
  }
  private async summarize(target: URL, headers: http.OutgoingHttpHeaders, encoded: Encoded, signal: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.summarizeOnce(target, headers, encoded, signal); }
      catch (error) {
        if (!(error instanceof RetryableSummaryError) || signal.aborted || this.closed) throw error;
        if (attempt >= 2) throw new Error(`${error.message}（已尝试 3 次）`);
        await delay(2000 * 2 ** attempt, undefined, { signal });
      }
    }
  }
  private async summarizeOnce(target: URL, headers: http.OutgoingHttpHeaders, encoded: Encoded, signal: AbortSignal) {
    this.stats.summaries++;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(summaryTimeout)]);
    let raw: Buffer, response: http.IncomingMessage;
    try {
      response = await this.send(target, isolatedSummaryHeaders(headers), encoded, deadline, 'POST', summaryTimeout);
      if (response.statusCode !== 200) throw await summaryHttpFailure(response, encoded);
      raw = await decoded(await readBody(response, 8 * 1024 * 1024), String(response.headers['content-encoding'] || '') || undefined);
    } catch (error) {
      if (!signal.aborted && deadline.aborted) throw new Error(`历史摘要请求超时（${summaryTimeout / 1000} 秒；上传 ${encoded.bytes.length} 字节），原推理请求未上传`);
      throw error;
    }
    const fail = (reason: string, retryable = false): never => { throw summaryResultFailure(reason, response, encoded, retryable); };
    let completed: any, terminalType = '', lastType = '';
    const text = raw.toString('utf8');
    // Some Codex gateways stream valid SSE without a Content-Type header.
    if (String(response.headers['content-type']).includes('text/event-stream') || /^(?:event:|data:|:)/.test(text.trimStart())) {
      for (const event of text.split(/\r?\n\r?\n/)) {
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data.trim() === '[DONE]') continue;
        let parsed: any;
        try { parsed = JSON.parse(data); } catch { fail('SSE 事件不是有效 JSON'); }
        lastType = safeDiagnostic(parsed?.type) || 'unknown';
        if (['response.failed', 'response.incomplete', 'error'].includes(parsed?.type)) {
          const code = safeDiagnostic(parsed.response?.error?.code || parsed.error?.code);
          const reason = safeDiagnostic(parsed.response?.incomplete_details?.reason);
          fail(`事件 ${lastType}${code ? `、代码 ${code}` : ''}${reason ? `、原因 ${reason}` : ''}`, code === 'server_is_overloaded');
        }
        if (parsed?.type === 'response.completed') { completed = parsed.response; terminalType = lastType; }
      }
      if (!terminalType) fail(`缺少完成事件；末尾事件 ${lastType || 'none'}`);
    } else {
      try { completed = JSON.parse(text); } catch { fail('响应不是有效 JSON 或 SSE'); }
    }
    const status = safeDiagnostic(completed?.status) || 'missing';
    if (status !== 'completed') fail(`响应状态 ${status}`);
    if (!Array.isArray(completed.output) || !completed.output.length) fail('响应没有输出项');
    const outputTypes = completed.output.map((item: any) => safeDiagnostic(item?.type) || 'unknown');
    if (outputTypes.some((type: string) => !['message', 'reasoning'].includes(type))) fail(`输出类型 ${[...new Set(outputTypes)].slice(0, 5).join(',')}`);
    const parts = completed.output.filter((item: any) => item.type === 'message');
    for (const item of parts) {
      if (item.role !== 'assistant' || item.status && item.status !== 'completed' || !Array.isArray(item.content))
        fail(`消息结构异常；角色 ${safeDiagnostic(item.role) || 'unknown'}；状态 ${safeDiagnostic(item.status) || 'missing'}`);
      const contentTypes = item.content.map((part: any) => safeDiagnostic(part?.type) || 'unknown');
      if (item.content.some((part: any) => part?.type !== 'output_text' || typeof part.text !== 'string'))
        fail(`消息内容类型 ${[...new Set(contentTypes)].slice(0, 5).join(',')}`);
    }
    const summary = parts.flatMap((item: any) => item.content.map((part: any) => part.text)).join('\n').trim();
    if (!summary || Buffer.byteLength(summary) > 64000) fail(`摘要文本长度 ${Buffer.byteLength(summary)} 字节`);
    this.stats.summaryInputTokens += Number(completed.usage?.input_tokens) || 0;
    this.stats.summaryOutputTokens += Number(completed.usage?.output_tokens) || 0;
    return summary;
  }
  private async prepare(bodyBytes: Buffer, encoding: string | undefined, target: URL, headers: http.OutgoingHttpHeaders, signal: AbortSignal, scope: string, cacheable: boolean) {
    const ready = await encodeGuardBody(bodyBytes, encoding, this.options.compression, this.budget);
    if (ready) { this.cache = this.cache.filter(entry => entry.scope !== scope); return ready; }
    let body: ResponseBody, raw: Buffer;
    try { raw = await decoded(bodyBytes, encoding); body = JSON.parse(raw.toString('utf8')); } catch { throw new Error('超限正文不是可安全处理的 JSON，原推理请求未上传'); }
    const keyBase = { scope, config: { ...body, input: undefined }, target: target.href };
    let summariesLeft = maxSummaries, diagnostics = '', fallback: Encoded | undefined;
    this.prune();
    // Broaden only after the safer level cannot fit. Historical image bytes are
    // never sent to the summarizer; only verified text parts from their results are.
    const conservative = guardHistory(body), completed = guardHistory(body, 'completed'), completedMedia = guardHistory(body, 'completed_media');
    const hasSecondLevel = completed.omittedIndices.size > 0 || [...conservative.protectedIndices].some(index => !completed.protectedIndices.has(index));
    const hasThirdLevel = completedMedia.omittedIndices.size > completed.omittedIndices.size || [...completed.protectedIndices].some(index => !completedMedia.protectedIndices.has(index));
    for (const [level, history] of [['conservative', conservative], ['completed', completed], ['completed_media', completedMedia]] as const) {
      if (level === 'completed' && !hasSecondLevel || level === 'completed_media' && !hasThirdLevel) continue;
      const lastCut = history.cuts.at(-1);
      const activeBytes = Buffer.byteLength(JSON.stringify(history.items.slice(history.activeStart)));
      const replaceable = lastCut && history.items.slice(0, lastCut).some((_item, index) => !history.protectedIndices.has(index) && !history.omittedIndices.has(index));
      const probe = replaceable ? Buffer.from(JSON.stringify(replaceGuardHistory(body, history, lastCut!, '历史摘要', false))) : raw;
      const probeReady = replaceable && await encodeGuardBody(probe, undefined, this.options.compression, this.budget);
      const fixedInput = lastCut ? [...history.items.slice(0, lastCut).filter((_item, index) => history.protectedIndices.has(index)), ...history.items.slice(lastCut, history.activeStart)] : history.items.slice(0, history.activeStart);
      const fixedBytes = Buffer.byteLength(JSON.stringify({ ...body, input: fixedInput }));
      const baseBytes = Buffer.byteLength(JSON.stringify({ ...body, input: [] }));
      const oldProtected = { media: 0, reasoning: 0, other: 0 };
      for (const index of history.protectedIndices) {
        if (index >= (lastCut || 0)) continue;
        const item = history.items[index], parts = [...(Array.isArray(item?.output) ? item.output : []), ...(Array.isArray(item?.content) ? item.content : [])];
        const kind = item?.type === 'reasoning' ? 'reasoning' : parts.some((part: any) => ['input_image', 'input_audio', 'input_video', 'video'].includes(part?.type)) ? 'media' : 'other';
        oldProtected[kind] += Buffer.byteLength(JSON.stringify(item));
      }
      const wireBytes = probeReady ? probeReady.bytes.length : this.options.compression ? (await compress(probe)).length : probe.length;
      const fixedDetails = `基础字段约 ${baseBytes} 字节、保留旧媒体约 ${oldProtected.media} 字节、保留旧推理约 ${oldProtected.reasoning} 字节、其他旧项约 ${oldProtected.other} 字节`;
      diagnostics = `固定内容约 ${fixedBytes} 字节、最新轮次约 ${activeBytes} 字节、${fixedDetails}、占位预检${this.options.compression ? '压缩后' : '编码后'} ${wireBytes} 字节`;
      if (!probeReady) continue;
      // Prefer room for subsequent messages, but never discard a valid repair
      // merely because fixed instructions or the active turn use that room.
      const headroom = Math.floor(this.budget * 0.8);
      const repairBudget = await encodeGuardBody(probe, undefined, this.options.compression, headroom) ? headroom : this.budget;
      const key = guardHash({ ...keyBase, level });
      const prior = cacheable ? this.cache.filter(entry => entry.key === key && history.cuts.includes(entry.end) && entry.prefixHash === guardHash(history.items.slice(0, entry.end))).sort((a, b) => b.end - a.end)[0] : undefined;
      let end = prior?.end || 0, summary = prior?.summary || '';
      if (prior) { prior.used = Date.now(); this.stats.cacheHits++; }
      while (true) {
        if (signal.aborted || this.closed) throw new Error('请求已取消');
        if (summary) for (const keepRecent of [true, false]) {
          if (!history.items.slice(0, end).some((_item, index) => !history.protectedIndices.has(index) && !history.omittedIndices.has(index) && (!keepRecent || !history.recentUsers.includes(index)))) continue;
          const final = Buffer.from(JSON.stringify(replaceGuardHistory(body, history, end, summary, keepRecent)));
          const ready = await encodeGuardBody(final, undefined, this.options.compression, repairBudget);
          if (ready) return ready;
          fallback = await encodeGuardBody(final, undefined, this.options.compression, this.budget) || fallback;
        }
        // Reserve half the summary budget when a broader level can retain less.
        if (!summariesLeft || level !== 'completed_media' && hasThirdLevel && summariesLeft <= maxSummaries / 2
          || level === 'conservative' && !hasThirdLevel && hasSecondLevel && summariesLeft <= maxSummaries / 2) break;
        let selected: { end: number; encoded: Encoded } | undefined;
        // Bounded candidate count avoids unbounded compression work for adversarial histories.
        const cuts = history.cuts.filter(cut => cut > end);
        if (cuts.length > 4096) throw new Error('历史结构过大，无法安全缩小请求；原推理请求未上传');
        // Search logarithmically: each candidate is measured, so a non-monotonic
        // compression ratio can only miss an opportunity, never admit an oversized body.
        // Bound uncompressed model input as well as the wire body. Only an
        // indivisible old turn falls back to the larger wire-only limit.
        for (const rawLimit of [summaryRawTarget, Infinity]) {
          let lo = 0, hi = cuts.length - 1;
          while (lo <= hi) {
            const mid = (lo + hi) >>> 1, cut = cuts[mid];
            const material = history.items.slice(end, cut).flatMap((item, index) => {
              const position = end + index;
              if (history.protectedIndices.has(position)) return [];
              if (history.omittedIndices.has(position)) return level === 'completed_media' && ['function_call_output', 'custom_tool_call_output'].includes(item?.type) && Array.isArray(item.output)
                && item.output.some((part: any) => part?.type === 'input_image') ? [redactedMediaSummaryItem(item)] : [];
              return [item];
            });
            if (!material.length) { lo = mid + 1; continue; }
            const rawSummary = Buffer.from(JSON.stringify(summaryRequest(body, material, summary)));
            if (rawSummary.length > rawLimit) { hi = mid - 1; continue; }
            const encoded = await encodeGuardBody(rawSummary, undefined, this.options.compression, this.budget);
            if (!encoded) hi = mid - 1;
            else { selected = { end: cut, encoded }; lo = mid + 1; }
          }
          if (selected) break;
        }
        if (!selected) break;
        summariesLeft--;
        try { summary = await this.summarize(target, headers, selected.encoded, signal); }
        catch (error) {
          // Extra headroom is optional. A later helper failure must not discard
          // an already validated, under-limit request from the same safe level.
          if (fallback && !signal.aborted && !this.closed) return fallback;
          throw error;
        }
        end = selected.end;
        if (cacheable) this.store({ scope, key, prefixHash: guardHash(history.items.slice(0, end)), end, summary, bytes: Buffer.byteLength(summary) + 256, used: Date.now() });
      }
      if (summary) {
        const final = Buffer.from(JSON.stringify(replaceGuardHistory(body, history, end, summary, false)));
        const wireBytes = this.options.compression ? (await compress(final)).length : final.length;
        diagnostics = `固定内容约 ${fixedBytes} 字节、最新轮次约 ${activeBytes} 字节、${fixedDetails}、最终候选${this.options.compression ? '压缩后' : '编码后'} ${wireBytes} 字节`;
      }
      if (fallback) return fallback; // Do not broaden history loss merely to gain optional headroom.
    }
    throw new GuardSizeError(`分层历史处理后仍无法缩至 1 MB 以下（${diagnostics}）；原推理请求未上传。原生 compact 尚未执行，需在确认本轮结束后尝试恢复。`);
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const controller = new AbortController(); this.controllers.add(controller);
    const cancel = () => { if (!res.writableFinished) controller.abort(); };
    req.once('aborted', cancel); res.once('close', cancel);
    try {
      const local = new URL(req.url || '/', 'http://127.0.0.1');
      const prefix = '/' + this.secret;
      const suffix = local.pathname.slice(prefix.length);
      if (req.headers.origin || !local.pathname.startsWith(prefix + '/') || !['/responses', '/responses/compact', '/models'].includes(suffix)
        || !(req.method === 'POST' && suffix.startsWith('/responses') || req.method === 'GET' && suffix === '/models')) {
        res.writeHead(403).end(); return;
      }
      const headers = guardHeaders(req.headers), body = await readBody(req, readLimit);
      const target = this.target(suffix, local.search);
      const session = req.headers['thread-id'] || req.headers['session-id'] || req.headers.session_id || req.headers['x-codex-session-id'] || req.headers['x-session-id'];
      // Newer CLIs also stream native compaction through /responses (memento).
      // Keep it inside the same cap, but never schedule maintenance from itself.
      let compact = suffix === '/responses/compact';
      try { compact ||= JSON.parse(String(req.headers['x-codex-turn-metadata'] || '{}')).request_kind === 'compaction'; } catch { /* Not native compaction metadata. */ }
      const scope = guardHash([req.headers.authorization, req.headers['chatgpt-account-id'], session || 'unknown']);
      await this.serial(scope, async () => {
        const encoding = String(req.headers['content-encoding'] || '') || undefined;
        // Compact is initiated by the native thread so its result is persisted by
        // Codex. Its input needs the same size protection; helper summaries still
        // go to /responses, never to the stateless /responses/compact endpoint.
        let prepared: Encoded | undefined;
        try {
          prepared = suffix.startsWith('/responses') ? await this.prepare(body, encoding, this.target('/responses', local.search), headers, controller.signal, scope, !!session)
            : await encodeGuardBody(body, encoding, this.options.compression, this.budget);
        } catch (error) {
          // Only a verified local size rejection can schedule recovery. Summary,
          // authentication and network failures must not masquerade as one.
          if (error instanceof GuardSizeError && !controller.signal.aborted) {
            if (compact) throw new GuardSizeError(`原生 compact 请求经分层历史处理后仍超限，未上传；${error.message.replace(/原生 compact 尚未执行.*$/, '')}`);
            if (suffix === '/responses' && typeof session === 'string')
              for (const observe of this.requestObservers) observe({ threadId: session, inputBytes: body.length, budget: this.budget, rejected: error.message });
          }
          throw error;
        }
        if (!prepared) throw new Error('此类请求无法缩至 1 MB 以下且不能安全摘要，原请求未上传');
        const upstream = await this.send(target, headers, prepared, controller.signal, req.method);
        this.stats.forwarded++;
        if (!compact && suffix === '/responses' && typeof session === 'string' && upstream.statusCode === 200)
          for (const observe of this.requestObservers) observe({ threadId: session, inputBytes: body.length, budget: this.budget });
        const outgoing = guardHeaders(upstream.headers);
        if (upstream.headers['content-length']) outgoing['content-length'] = upstream.headers['content-length'];
        res.writeHead(upstream.statusCode || 502, outgoing);
        await pipeline(upstream, res);
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.stats.rejected++;
      if (!res.headersSent && !res.destroyed) {
        const message = error instanceof GuardNetworkError ? error.message : error instanceof Error && /请求|摘要|代理|工具|历史/.test(error.message) ? error.message : '请求大小保护未能安全完成处理，原推理请求未上传';
        // Codex retries 413 as a disconnected stream. A local non-retryable 400
        // stops immediately, avoiding repeated summary calls for the same failure.
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'workbench_request_guard', message } }));
      } else res.destroy();
    } finally { this.controllers.delete(controller); }
  }
}

/** Inspect effective configuration without writing personal config or authentication files. */
export async function createCodexRequestGuard(rpc: AgentRpc, cwd: string, env: NodeJS.ProcessEnv, certificateFile?: () => string) {
  const { config } = await rpc.request('config/read', { includeLayers: false, cwd });
  const id = config?.model_provider || 'openai', builtin = id === 'openai';
  // config/read includes null optional fields; app-server's JSON-to-TOML overlay
  // cannot round-trip these (for example auth:null becomes an invalid string).
  const omitNull = (value: any): any => Array.isArray(value) ? value.map(omitNull) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => [key, omitNull(item)])) : value;
  const original = omitNull(config?.model_providers?.[id] || {}) as Record<string, any>;
  if (builtin && config?.model_providers?.workbench_guard_openai) throw new Error('请求保护的临时连接名称与已有自定义配置重名，请先重命名该自定义连接');
  if (!builtin && !original.base_url || original.wire_api && original.wire_api !== 'responses') throw new Error('请求大小保护需要 Responses 模型连接，当前连接保持未启动');
  const environment = await guardNetworkEnvironment(env);
  const account = builtin ? await rpc.request('account/read', { refreshToken: false }) : undefined;
  const upstream = original.base_url || config?.openai_base_url || (account?.account?.type === 'chatgpt' ? 'https://chatgpt.com/backend-api/codex' : 'https://api.openai.com/v1');
  const guard = new CodexRequestGuard({ upstream, compression: builtin || original.supports_request_compression === true, env: environment, certificateFile });
  try {
    const base = await guard.start(), providerId = builtin ? 'workbench_guard_openai' : id;
    const provider = { ...original, name: original.name || 'OpenAI', wire_api: 'responses', requires_openai_auth: original.requires_openai_auth ?? builtin,
      base_url: base, supports_websockets: false, supports_request_compression: false };
    return { guard, config: { model_provider: providerId, [`model_providers.${providerId}`]: provider, 'features.responses_websockets': false, 'features.responses_websockets_v2': false } };
  } catch (error) { await guard.close(); throw error; }
}
