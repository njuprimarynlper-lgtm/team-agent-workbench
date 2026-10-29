import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { AgentRpc } from './rpc';
import { guardHeaders, guardRequest, guardNetworkEnvironment } from './codex-guard-transport';
import { guardHash, guardHistory, replaceGuardHistory, summaryRequest, type ResponseBody } from './codex-guard-history';

export const codexRequestBudget = 1_000_000;
const memoryLimit = 32 * 1024 * 1024, readLimit = 64 * 1024 * 1024, ttl = 3600000;
const compress = promisify(zlib.zstdCompress);
type Encoded = { bytes: Buffer; encoding?: string };
type CacheEntry = { scope: string; key: string; prefixHash: string; end: number; summary: string; bytes: number; used: number };
export interface GuardOptions { upstream: string; compression: boolean; env?: NodeJS.ProcessEnv; budget?: number; }
export interface GuardStats { forwarded: number; summaries: number; summaryInputTokens: number; summaryOutputTokens: number; cacheHits: number; rejected: number; maxUploadBytes: number; }

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

/** Under-budget bodies are byte-identical; only oversized requests are re-encoded. */
export async function encodeGuardBody(body: Buffer, encoding: string | undefined, compression: boolean, budget = codexRequestBudget): Promise<Encoded | undefined> {
  if (body.length <= budget) return { bytes: body, encoding };
  const raw = await decoded(body, encoding);
  if (raw.length <= budget) return { bytes: raw };
  if (compression) { const bytes = await compress(raw); if (bytes.length <= budget) return { bytes, encoding: 'zstd' }; }
}

export class CodexRequestGuard {
  readonly stats: GuardStats = { forwarded: 0, summaries: 0, summaryInputTokens: 0, summaryOutputTokens: 0, cacheHits: 0, rejected: 0, maxUploadBytes: 0 };
  private server: http.Server;
  private controllers = new Set<AbortController>();
  private sockets = new Set<import('node:net').Socket>();
  private cache: CacheEntry[] = [];
  private queues = new Map<string, Promise<unknown>>();
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
    this.cache = [];
    return this.closeJob = new Promise<void>(resolve => this.server.close(() => resolve()));
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
  private async send(target: URL, headers: http.OutgoingHttpHeaders, encoded: Encoded, signal: AbortSignal, method = 'POST') {
    if (encoded.bytes.length > this.budget) throw new Error('请求大小保护阻止了超限上传');
    if (signal.aborted || this.closed) throw new Error('请求已取消');
    this.stats.maxUploadBytes = Math.max(this.stats.maxUploadBytes, encoded.bytes.length);
    const next = { ...headers }; delete next['content-encoding'];
    if (encoded.encoding) next['content-encoding'] = encoded.encoding;
    return guardRequest(target, next, encoded.bytes, this.env, signal, method);
  }
  private async summarize(target: URL, headers: http.OutgoingHttpHeaders, encoded: Encoded, signal: AbortSignal) {
    this.stats.summaries++;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    const response = await this.send(target, { ...headers, accept: 'text/event-stream', 'accept-encoding': 'identity' }, encoded, deadline);
    if (response.statusCode !== 200) { response.destroy(); throw new Error('历史摘要请求失败，原推理请求未上传'); }
    const raw = await decoded(await readBody(response, 8 * 1024 * 1024), String(response.headers['content-encoding'] || '') || undefined);
    let completed: any;
    try {
      const text = raw.toString('utf8');
      // Some Codex gateways stream valid SSE without a Content-Type header.
      if (String(response.headers['content-type']).includes('text/event-stream') || /^(?:event:|data:|:)/.test(text.trimStart())) {
        for (const event of text.split(/\r?\n\r?\n/)) {
          const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data || data.trim() === '[DONE]') continue;
          const parsed = JSON.parse(data);
          if (['response.failed', 'response.incomplete', 'error'].includes(parsed.type)) throw Error();
          if (parsed.type === 'response.completed') completed = parsed.response;
        }
      } else completed = JSON.parse(raw.toString('utf8'));
      if (completed?.status !== 'completed' || !Array.isArray(completed.output) || !completed.output.length || completed.output.some((item: any) => !['message', 'reasoning'].includes(item.type))) throw Error();
      const parts = completed.output.filter((item: any) => item.type === 'message');
      if (parts.some((item: any) => item.role !== 'assistant' || item.status && item.status !== 'completed' || !Array.isArray(item.content) || item.content.some((part: any) => part.type !== 'output_text' || typeof part.text !== 'string'))) throw Error();
      const summary = parts.flatMap((item: any) => item.content.map((part: any) => part.text)).join('\n').trim();
      if (!summary || Buffer.byteLength(summary) > 64000) throw Error();
      this.stats.summaryInputTokens += Number(completed.usage?.input_tokens) || 0;
      this.stats.summaryOutputTokens += Number(completed.usage?.output_tokens) || 0;
      return summary;
    } catch { throw new Error('历史摘要未完整完成或返回了非文本结果，原推理请求未上传'); }
  }
  private async prepare(bodyBytes: Buffer, encoding: string | undefined, target: URL, headers: http.OutgoingHttpHeaders, signal: AbortSignal, scope: string, cacheable: boolean) {
    const ready = await encodeGuardBody(bodyBytes, encoding, this.options.compression, this.budget);
    if (ready) { this.cache = this.cache.filter(entry => entry.scope !== scope); return ready; }
    let body: ResponseBody;
    try { body = JSON.parse((await decoded(bodyBytes, encoding)).toString('utf8')); } catch { throw new Error('超限正文不是可安全处理的 JSON，原推理请求未上传'); }
    const history = guardHistory(body);
    const lastCut = history.cuts.at(-1);
    if (!lastCut || !await encodeGuardBody(Buffer.from(JSON.stringify(replaceGuardHistory(body, history, lastCut, '历史摘要', false))), undefined, this.options.compression, this.budget))
      throw new Error('必须保留的指令或最新内容超过 1 MB，无法通过历史摘要缩小；原推理请求未上传');
    const key = guardHash({ scope, config: { ...body, input: undefined }, target: target.href });
    this.prune();
    const prior = cacheable ? this.cache.filter(entry => entry.key === key && history.cuts.includes(entry.end) && entry.prefixHash === guardHash(history.items.slice(0, entry.end))).sort((a, b) => b.end - a.end)[0] : undefined;
    let end = prior?.end || 0, summary = prior?.summary || '';
    if (prior) { prior.used = Date.now(); this.stats.cacheHits++; }
    for (let round = 0; round <= 8; round++) {
      if (signal.aborted || this.closed) throw new Error('请求已取消');
      if (summary) {
        for (const keepRecent of [true, false]) {
          const final = Buffer.from(JSON.stringify(replaceGuardHistory(body, history, end, summary, keepRecent)));
          const ready = await encodeGuardBody(final, undefined, this.options.compression, this.budget);
          if (ready) return ready;
        }
      }
      if (round === 8) break;
      let selected: { end: number; encoded: Encoded } | undefined;
      // Bounded candidate count avoids unbounded compression work for adversarial histories.
      const cuts = history.cuts.filter(cut => cut > end);
      if (cuts.length > 4096) throw new Error('历史结构过大，无法安全缩小请求；原推理请求未上传');
      // Search logarithmically: each candidate is measured, so a non-monotonic
      // compression ratio can only miss an opportunity, never admit an oversized body.
      let lo = 0, hi = cuts.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1, cut = cuts[mid];
        const material = history.items.slice(end, cut).filter((_item, index) => !history.protectedIndices.has(end + index));
        if (!material.length) { lo = mid + 1; continue; }
        const encoded = await encodeGuardBody(Buffer.from(JSON.stringify(summaryRequest(body, material, summary))), undefined, this.options.compression, this.budget);
        if (!encoded) hi = mid - 1;
        else { selected = { end: cut, encoded }; lo = mid + 1; }
      }
      if (!selected) break;
      summary = await this.summarize(target, headers, selected.encoded, signal); end = selected.end;
      if (cacheable) this.store({ scope, key, prefixHash: guardHash(history.items.slice(0, end)), end, summary, bytes: Buffer.byteLength(summary) + 256, used: Date.now() });
    }
    throw new Error('请求超过 1 MB，必须保留的内容过大或历史无法继续缩小，原推理请求未上传。请减少本轮附件或在 Codex 中压缩上下文后重试。');
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
      const session = req.headers.session_id || req.headers['x-codex-session-id'] || req.headers['x-session-id'];
      const scope = guardHash([req.headers.authorization, req.headers['chatgpt-account-id'], session || 'unknown']);
      await this.serial(scope, async () => {
        const encoding = String(req.headers['content-encoding'] || '') || undefined;
        const prepared = suffix === '/responses' ? await this.prepare(body, encoding, target, headers, controller.signal, scope, !!session)
          : await encodeGuardBody(body, encoding, this.options.compression, this.budget);
        if (!prepared) throw new Error('此类请求超过 1 MB 且不能安全摘要，原请求未上传');
        const upstream = await this.send(target, headers, prepared, controller.signal, req.method);
        this.stats.forwarded++;
        const outgoing = guardHeaders(upstream.headers);
        if (upstream.headers['content-length']) outgoing['content-length'] = upstream.headers['content-length'];
        res.writeHead(upstream.statusCode || 502, outgoing);
        await pipeline(upstream, res);
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.stats.rejected++;
      if (!res.headersSent && !res.destroyed) {
        const message = error instanceof Error && /请求|摘要|代理|工具|历史/.test(error.message) ? error.message : '请求大小保护未能安全完成处理，原推理请求未上传';
        // Codex retries 413 as a disconnected stream. A local non-retryable 400
        // stops immediately, avoiding repeated summary calls for the same failure.
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'workbench_request_guard', message } }));
      } else res.destroy();
    } finally { this.controllers.delete(controller); }
  }
}

/** Inspect effective configuration without writing personal config or authentication files. */
export async function createCodexRequestGuard(rpc: AgentRpc, cwd: string, env: NodeJS.ProcessEnv) {
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
  const guard = new CodexRequestGuard({ upstream, compression: builtin || original.supports_request_compression === true, env: environment });
  try {
    const base = await guard.start(), providerId = builtin ? 'workbench_guard_openai' : id;
    const provider = { ...original, name: original.name || 'OpenAI', wire_api: 'responses', requires_openai_auth: original.requires_openai_auth ?? builtin,
      base_url: base, supports_websockets: false, supports_request_compression: false };
    return { guard, config: { model_provider: providerId, [`model_providers.${providerId}`]: provider, 'features.responses_websockets': false, 'features.responses_websockets_v2': false } };
  } catch (error) { await guard.close(); throw error; }
}
