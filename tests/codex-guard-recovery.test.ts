import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { AgentRuntime } from '../src/core/agents';
import { CodexRequestGuard } from '../src/core/codex-request-guard';
import { SessionInputQueue } from '../src/core/session-input-queue';
import type { AgentRpc } from '../src/core/rpc';
import type { AgentSession } from '../src/shared/types';

const message = (role: string, text: string) => ({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function until(check: () => boolean) {
  const end = Date.now() + 10_000;
  while (!check()) { if (Date.now() > end) throw Error('fixture timed out'); await new Promise(r => setTimeout(r, 5)); }
}
async function post(url: string, value: unknown, zstd = false, signal?: AbortSignal) {
  return new Promise<any>((resolve, reject) => {
    const req = http.request(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', session_id: 'native-guard', ...(zstd ? { 'content-encoding': 'zstd' } : {}) } }, res => {
      let body = ''; res.on('data', data => { body += data; }); res.on('error', reject);
      res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(Error(JSON.parse(body).error.message)));
    }); req.on('error', reject); req.end(zstd ? zstdCompressSync(Buffer.from(JSON.stringify(value))) : JSON.stringify(value));
  });
}

type Scenario = 'recover' | 'mid-turn-zstd' | 'near-budget' | 'shrinking' | 'compact-refused' | 'retry-refused' | 'missing-input' | 'changed-input' | 'partial-tool' | 'unsupported' | 'ambiguous';
class Native extends EventEmitter implements AgentRpc {
  calls: { method: string; params: any }[] = []; errors: unknown[] = []; records: any[] = [];
  base = ''; turns = 0; compactCount = 0; failureSeen = false; compactItemDone = false; closed = false;
  inference?: AbortController;
  terminal = deferred(); compactStart = deferred(); compactEnd = deferred(); firstAck = deferred(); holdAck = false;
  // Unknown native state must stay protected; dropping it would conceal the bug.
  history: any[] = [message('developer', 'KEEP_DEVELOPER'), message('user', 'OLD_USER'),
    { type: 'reasoning', encrypted_content: 'r'.repeat(700_000), vendor_state: 'DO_NOT_DROP_UNKNOWN_STATE' }, message('assistant', 'old result')];
  constructor(private upstream: string, readonly scenario: Scenario) {
    super();
    if (scenario === 'mid-turn-zstd') this.history = [];
  }
  event(method: string, params: any) { if (!this.closed) this.emit('message', { method, params: { threadId: 'native-guard', ...params } }); }
  async request(method: string, params: any = {}, _timeout?: number, written?: () => void): Promise<any> {
    this.calls.push({ method, params: structuredClone(params) }); written?.();
    if (method === 'initialize') return {};
    if (method === 'config/read') return { config: { model_provider: 'fixture', model_providers: { fixture: { base_url: this.upstream, wire_api: 'responses' } } } };
    if (method === 'thread/start') {
      this.base = params.config['model_providers.fixture'].base_url;
      return { thread: { id: 'native-guard' }, modelProvider: 'fixture' };
    }
    if (method === 'thread/read') {
      const turns = structuredClone(this.records);
      if (this.scenario === 'missing-input' || this.scenario === 'changed-input' && this.compactItemDone)
        turns[0].items = [{ type: 'userMessage', content: [{ type: 'text', text: 'NOT_THE_ORIGINAL_INPUT' }] }];
      return { thread: { id: 'native-guard', status: { type: turns.some(turn => turn.status === 'inProgress') ? 'active' : 'idle' }, turns } };
    }
    if (method === 'turn/start') {
      const id = 'user-' + ++this.turns;
      const turn = { id, status: 'inProgress', items: params.input.length ? [{ type: 'userMessage', content: structuredClone(params.input) }] : [] };
      this.records.push(turn);
      if (params.input.length) this.history.push(message('user', params.input[0].text));
      void this.answer(turn).catch(error => this.errors.push(error));
      if (this.holdAck && this.turns === 1) await this.firstAck.promise;
      return { turn: { id, status: turn.status } };
    }
    if (method === 'thread/compact/start') {
      this.compactCount++;
      if (this.scenario === 'unsupported') throw Object.assign(Error('Method not found'), { code: -32601 });
      if (this.scenario === 'ambiguous') throw Error('RPC transport lost');
      const previous = this.records.at(-1);
      if (previous?.status === 'inProgress') {
        this.inference?.abort();
        previous.status = 'interrupted';
        this.event('turn/completed', { turn: previous });
      }
      void this.compact().catch(error => this.errors.push(error)); return {};
    }
    if (method === 'turn/interrupt') {
      const turn = this.records.find(turn => turn.id === params.turnId);
      if (turn) { turn.status = 'interrupted'; this.event('turn/completed', { turn }); }
      return {};
    }
    throw Error('Unexpected fixture method: ' + method);
  }
  private async answer(turn: any) {
    this.event('turn/started', { turn });
    const inference = this.inference = new AbortController();
    if (this.scenario === 'partial-tool' && this.turns === 1) {
      const item = { id: 'cmd', type: 'commandExecution', command: 'already-did-work' };
      turn.items.push(item); this.event('item/started', { turnId: turn.id, item });
    }
    try {
      const toolStep = this.scenario === 'mid-turn-zstd' && this.turns === 1;
      if (toolStep) {
        const under = { model: 'fixture', input: this.history, instructions: '' };
        under.instructions = 'A'.repeat(799_999 - Buffer.byteLength(JSON.stringify(under)));
        await post(this.base + '/responses', under);
        const item = { id: 'cmd', type: 'commandExecution', command: 'once', status: 'inProgress' };
        turn.items.push(item); this.event('item/started', { turnId: turn.id, item });
        this.history.push({ type: 'function_call', call_id: 'cmd', name: 'exec_command', arguments: '{"cmd":"once"}' },
          { type: 'function_call_output', call_id: 'cmd', output: 'done' });
      }
      const payload = { model: 'fixture', instructions: 'KEEP_SYSTEM',
        tools: [{ type: 'function', name: 'inspect', description: 'tool'.repeat(10_000), parameters: {} }], input: this.history };
      if (toolStep) this.history.at(-1).output += 'Z'.repeat(802_134 - Buffer.byteLength(JSON.stringify(payload)));
      await post(this.base + '/responses', payload, toolStep, inference.signal);
      if (this.closed || turn.status === 'interrupted') return;
      const item = { id: 'answer-' + turn.id, type: 'agentMessage', phase: 'final_answer', text: 'final answer' };
      turn.items.push(item); this.history.push(message('assistant', item.text));
      this.event('item/completed', { turnId: turn.id, item }); turn.status = 'completed';
    } catch (error: any) {
      if (this.closed || turn.status === 'interrupted') return;
      turn.error = { message: error.message }; this.failureSeen = true;
      this.event('error', { turnId: turn.id, error: turn.error, willRetry: false });
      await this.terminal.promise;
      if (this.closed || turn.status === 'interrupted') return;
      turn.status = 'failed';
    }
    this.event('turn/completed', { turn }); this.event('turn/completed', { turn });
  }
  private async compact() {
    const turn = { id: 'compact-' + this.compactCount, status: 'inProgress', items: [] as any[], error: undefined as any };
    this.records.push(turn); this.event('turn/started', { turn });
    const item = { id: 'context-item', type: 'contextCompaction' };
    this.event('item/started', { turnId: turn.id, item });
    await this.compactStart.promise;
    if (this.closed || turn.status === 'interrupted') return;
    try {
      const response = await post(this.base + '/responses/compact', { model: 'fixture',
        instructions: this.scenario === 'compact-refused' ? 'KEEP_COMPACT_' + 'i'.repeat(40_000) : 'KEEP_COMPACT', input: this.history });
      if (this.closed || turn.status === 'interrupted') return;
      if (this.scenario !== 'retry-refused') this.history = response.output;
      if (this.scenario === 'shrinking' && this.compactCount === 1)
        this.history.push({ type: 'reasoning', encrypted_content: 'p'.repeat(540_000) });
      turn.items.push(item); this.event('item/completed', { turnId: turn.id, item }); this.compactItemDone = true;
      await this.compactEnd.promise;
      if (this.closed || turn.status === 'interrupted') return;
      turn.status = 'completed';
    } catch (error: any) { turn.status = 'failed'; turn.error = { message: error.message }; }
    this.event('turn/completed', { turn }); this.event('turn/completed', { turn });
  }
  notify() {} respond() {} reject() {}
  async close() { this.closed = true; this.terminal.resolve(); this.compactStart.resolve(); this.compactEnd.resolve(); this.firstAck.resolve(); this.emit('closed', Error('closed')); }
}

async function fixture(scenario: Scenario, run: (value: {
  rpc: Native; runtime: AgentRuntime; session: AgentSession; queue: SessionInputQueue;
  uploads: { url: string; bytes: number; value: any }[]; events: any[]; done: () => number; latest: string;
}) => Promise<void>) {
  const uploads: { url: string; bytes: number; value: any }[] = [], events: any[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const value = JSON.parse((req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(body) : body).toString());
    uploads.push({ url: req.url!, bytes: body.length, value });
    if (body.length >= 1_000_000) { res.writeHead(413).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url!.endsWith('/compact') ? { output: [...value.input.filter((item: any) => item.role === 'user' || item.role === 'developer'), { type: 'compaction', encrypted_content: 'PERSISTED_NATIVE_STATE' }] } : { response: 'OK' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const rpc = new Native(`http://127.0.0.1:${(server.address() as any).port}/v1`, scenario);
  const session = { id: 'work', provider: 'codex', purpose: 'work', cwd: process.cwd(), status: 'idle', messages: [], approvals: [], sources: [], model: 'fixture', reasoningEffort: 'high', permissionMode: 'inherit' } as unknown as AgentSession;
  let done = 0;
  const runtime = new AgentRuntime(session, 'unused', { changed() {}, event: e => events.push(e), done() { done++; if (session.error && session.inputQueue) session.inputQueue.paused = true; } }, undefined,
    { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '*', no_proxy: '*' }, rpc, false, true);
  const queue = new SessionInputQueue({ session: () => session, save: async () => {}, changed() {}, blocked: s => ['starting', 'running', 'approval', 'error'].includes(s.status), send: async (_id, input, submitted) => runtime.prompt(input.text, { userText: input.text, context: { sourceIds: [] } as any, submitted }), steer: async () => false });
  const latest = 'LATEST_KEEP_' + 'u'.repeat(scenario === 'mid-turn-zstd' ? 5 : scenario === 'near-budget' ? 100_000 : 280_000);
  try { await run({ rpc, runtime, session, queue, uploads, events, latest, done: () => done }); assert.deepEqual(rpc.errors, []); assert(uploads.every(item => item.bytes < 1_000_000)); }
  finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('zstd tool output over 80% stays in the same turn when its wire body fits', () => fixture('mid-turn-zstd', async ({ rpc, runtime, session, uploads, latest, done }) => {
  rpc.compactStart.resolve(); rpc.compactEnd.resolve();
  await runtime.prompt(latest); await until(() => done() === 1);
  assert.equal(uploads.filter(upload => upload.url === '/v1/responses').length, 2);
  assert.equal(uploads[0].bytes, 799_999); assert(uploads[1].bytes < 1_000_000);
  assert.equal(rpc.records[0].status, 'completed'); assert.equal(rpc.failureSeen, false);
  assert.equal(session.status, 'idle', session.error || 'turn should complete without interruption');
  assert.equal(rpc.turns, 1); assert.equal(rpc.compactCount, 1); // Maintenance follows the completed turn.
  assert.equal(session.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(rpc.records.flatMap(t => t.items).filter(i => i.id === 'cmd').length, 1);
  assert.equal(session.contextCompacting, undefined); assert.equal(session.messages.some(m => m.role === 'system'), false);
}));

test('a near-budget request uploads and completes before optional compaction blocks the FIFO', () => fixture('near-budget', async ({ rpc, runtime, session, queue, uploads, latest, done }) => {
  await runtime.prompt(latest); await until(() => rpc.compactCount === 1);
  assert.equal(uploads[0].url, '/v1/responses'); assert(uploads[0].bytes < 1_000_000);
  assert.equal(rpc.records[0].status, 'completed'); assert.equal(session.contextCompacting, true);
  await queue.enqueue(session.id, { text: 'NEXT', sourceIds: [], answers: {} }); await queue.pump(session.id);
  assert.equal(rpc.turns, 1); assert.equal(done(), 0);
  rpc.compactStart.resolve(); await until(() => rpc.compactItemDone); await queue.pump(session.id); assert.equal(rpc.turns, 1);
  rpc.compactEnd.resolve(); await until(() => done() === 1); await queue.pump(session.id); await until(() => done() === 2);
  assert.equal(rpc.turns, 2); assert.equal(session.inputQueue?.items.length, 0); assert.equal(rpc.compactCount, 1);
}));

test('an oversized request compacts once and its smaller continuation may upload above 80%', () => fixture('shrinking', async ({ rpc, runtime, session, latest, uploads, done }) => {
  rpc.compactStart.resolve(); rpc.compactEnd.resolve();
  await runtime.prompt(latest); await until(() => done() === 1);
  assert.equal(session.status, 'idle', session.error || 'expected automatic continuation');
  assert.equal(rpc.compactCount, 1); assert.equal(rpc.turns, 2);
  assert.equal(uploads.filter(upload => !upload.url.endsWith('/compact')).length, 1);
  assert.equal(session.messages.filter(m => m.role === 'user').length, 1);
}));

test('native compact supersedes the held upload even before turn/start acknowledgement; queued turn stays last', () => fixture('recover', async ({ rpc, runtime, session, queue, uploads, latest, done, events }) => {
  rpc.holdAck = true;
  const sending = runtime.prompt(latest); await until(() => rpc.compactCount === 1);
  assert.equal(rpc.failureSeen, false); assert.equal(uploads.length, 0); assert.equal(done(), 0);
  await queue.enqueue(session.id, { text: 'NEXT', sourceIds: [], answers: {} }); await queue.pump(session.id); assert.equal(rpc.turns, 1);
  rpc.terminal.resolve(); await until(() => rpc.compactCount === 1);
  await assert.rejects(runtime.prompt('DO_NOT_INTERLEAVE'), /仍在运行/);
  assert.equal(session.status, 'running'); assert.equal(done(), 0);
  rpc.compactStart.resolve(); await until(() => rpc.compactItemDone); await queue.pump(session.id); assert.equal(rpc.turns, 1);
  const compact = uploads.find(item => item.url.endsWith('/compact'))!;
  assert.equal(compact.value.instructions, 'KEEP_COMPACT');
  assert(compact.value.input.some((item: any) => item.vendor_state === 'DO_NOT_DROP_UNKNOWN_STATE'));
  assert(compact.value.input.some((item: any) => item.content?.[0]?.text === latest));
  rpc.compactEnd.resolve(); await until(() => rpc.turns === 2); rpc.firstAck.resolve(); assert.equal(await sending, true);
  await until(() => done() === 1);
  const starts = rpc.calls.filter(call => call.method === 'turn/start');
  assert.deepEqual(starts[1].params, { ...starts[0].params, input: [] });
  const recovered = uploads.find(item => item.url === '/v1/responses')!;
  assert.equal(recovered.value.instructions, 'KEEP_SYSTEM'); assert.equal(recovered.value.tools[0].name, 'inspect');
  assert.equal(recovered.value.input.filter((item: any) => item.content?.[0]?.text === latest).length, 1);
  assert(recovered.value.input.some((item: any) => item.encrypted_content === 'PERSISTED_NATIVE_STATE'));
  assert.equal(session.messages.filter(item => item.role === 'user').length, 1); assert.equal(session.turnTimings?.length, 1);
  await queue.pump(session.id); await until(() => done() === 2);
  assert.equal(rpc.turns, 3); assert.equal(session.inputQueue?.items.length, 0); assert.equal(rpc.compactCount, 1);
  assert.equal(events.filter(e => e.reason === 'pre-upload-overflow' && e.status === 'completed').length, 1);
}));

for (const scenario of ['compact-refused', 'retry-refused', 'missing-input', 'changed-input', 'partial-tool', 'unsupported', 'ambiguous'] as const)
  test(`local refusal recovery remains bounded and preserves the pending FIFO: ${scenario}`, () => fixture(scenario, async ({ rpc, runtime, session, queue, uploads, latest, done }) => {
    await queue.enqueue(session.id, { text: 'NEXT_MUST_WAIT', sourceIds: [], answers: {} });
    await runtime.prompt(latest); await until(() => rpc.compactCount === 1);
    rpc.terminal.resolve(); rpc.compactStart.resolve(); rpc.compactEnd.resolve();
    await until(() => session.status === 'error'); await queue.pump(session.id);
    assert.equal(rpc.turns, scenario === 'retry-refused' ? 2 : 1); assert(rpc.compactCount <= 1); assert.equal(done(), 1);
    assert.equal(session.messages.filter(item => item.role === 'user').length, 1);
    assert.equal(session.inputQueue?.items.length, 1); assert.equal(session.inputQueue?.paused, true);
    assert.match(session.error!, /输入已保留/);
    if (scenario === 'compact-refused') { assert.match(session.error!, /原生 compact 请求.*未上传/); assert.equal(uploads.length, 0); }
    if (scenario === 'retry-refused') assert.match(session.error!, /compact 后请求仍无法无损压至 1 MB 以下/);
    if (scenario === 'missing-input') assert.match(session.error!, /无法核对保留输入/);
    if (scenario === 'partial-tool') assert.match(session.error!, /already-did-work/);
    if (scenario === 'changed-input') assert.match(session.error!, /无法核对保留输入/);
    if (scenario === 'ambiguous') await assert.rejects(runtime.prompt('NO_RETRY'), /尚未确认/);
  }));

for (const stop of ['cancel', 'close'] as const) test(`${stop} during recovery never resumes the input`, () => fixture('recover', async ({ rpc, runtime, session, latest }) => {
  await runtime.prompt(latest); await until(() => rpc.compactCount === 1);
  await runtime[stop](); rpc.compactStart.resolve(); rpc.compactEnd.resolve(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(rpc.turns, 1); assert.notEqual(session.status, 'running');
}));

test('a hard size refusal without a terminal event never starts compact or allows another turn', t => {
  t.mock.method(CodexRequestGuard.prototype, 'beforeUpload', () => () => {});
  return fixture('recover', async ({ rpc, runtime, session, latest }) => {
  await runtime.prompt(latest); await until(() => rpc.failureSeen);
  await until(() => session.status === 'error');
  assert.equal(rpc.compactCount, 0); assert.match(session.error!, /尚未确认本轮结束.*原生 compact 未启动/);
  await assert.rejects(runtime.prompt('DO_NOT_DUPLICATE'), /上一轮已结束/);
  assert.equal(rpc.turns, 1);
  });
});
