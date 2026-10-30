import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { AgentRuntime } from '../src/core/agents';
import { SessionInputQueue } from '../src/core/session-input-queue';
import type { AgentRpc } from '../src/core/rpc';
import type { AgentSession } from '../src/shared/types';

const message = (role: string, text: string) => ({ role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function until(check: () => boolean) {
  const end = Date.now() + 10_000;
  while (!check()) { if (Date.now() > end) throw Error('fixture timed out'); await new Promise(r => setTimeout(r, 5)); }
}
async function post(url: string, value: unknown) {
  return new Promise<string>((resolve, reject) => {
    const request = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', session_id: 'native-a' } }, response => {
      let result = ''; response.on('data', data => { result += data.toString(); }); response.on('error', reject);
      response.on('end', () => response.statusCode === 200 ? resolve(result) : reject(Error(result)));
    }); request.on('error', reject); request.end(json(value));
  });
}

// Protocol-only native CLI: the native side owns history replacement, while the
// real runtime and loopback request guard handle scheduling and upload boundaries.
class Native extends EventEmitter implements AgentRpc {
  calls: string[] = []; errors: unknown[] = []; turns = 0; base = ''; compactItemDone = false;
  releaseCompact = deferred(); releaseComplete = deferred(); compacted = false;
  history = [message('developer', 'KEEP_DEVELOPER'), ...Array.from({ length: 8 }, (_, i) => message(i % 2 ? 'assistant' : 'user', randomBytes(140_000).toString('base64')))];
  constructor(private upstream: string) { super(); }
  event(method: string, params: any) { this.emit('message', { method, params: { threadId: 'native-a', ...params } }); }
  async request(method: string, params: any = {}, _timeout?: number, onWritten?: () => void) {
    this.calls.push(method); onWritten?.();
    if (method === 'initialize') return {};
    if (method === 'config/read') return { config: { model_provider: 'fixture', model_providers: { fixture: { base_url: this.upstream, wire_api: 'responses' } } } };
    if (method === 'thread/start') {
      this.base = params.config['model_providers.fixture'].base_url;
      return { thread: { id: 'native-a', status: { type: 'idle' } }, modelProvider: 'fixture' };
    }
    if (method === 'turn/start') {
      const id = 'user-' + ++this.turns;
      this.history.push(message('user', params.input[0].text));
      void this.answer(id).catch(error => this.errors.push(error));
      return { turn: { id } };
    }
    if (method === 'thread/compact/start') {
      void this.compact().catch(error => this.errors.push(error)); return {};
    }
    if (method === 'turn/interrupt') { this.event('turn/completed', { turn: { id: params.turnId, status: 'interrupted' } }); return {}; }
    throw Error('Unexpected fixture method ' + method);
  }
  private async answer(id: string) {
    this.event('turn/started', { turn: { id } });
    await post(this.base + '/responses', { model: 'test', instructions: 'KEEP_SYSTEM', tools: [], input: this.history, stream: true });
    this.history.push(message('assistant', 'final answer'));
    this.event('item/completed', { turnId: id, item: { id: 'answer-' + id, type: 'agentMessage', phase: 'final_answer', text: 'final answer' } });
    this.event('turn/completed', { turn: { id, status: 'completed' } });
    this.event('turn/completed', { turn: { id, status: 'completed' } }); // delayed duplicate from original turn
  }
  private async compact() {
    this.event('turn/started', { turn: { id: 'compact-1' } });
    this.event('item/started', { turnId: 'compact-1', item: { id: 'compact-item', type: 'contextCompaction' } });
    await this.releaseCompact.promise;
    const response = JSON.parse(await post(this.base + '/responses/compact', { model: 'test', instructions: 'KEEP_COMPACT_INSTRUCTIONS', input: this.history }));
    this.history = response.output; this.compacted = true;
    this.event('item/completed', { turnId: 'compact-1', item: { id: 'compact-item', type: 'contextCompaction' } });
    this.compactItemDone = true;
    await this.releaseComplete.promise;
    this.event('turn/completed', { turn: { id: 'compact-1', status: 'completed' } });
  }
  notify() {} respond() {} reject() {}
  async close() { this.emit('closed', Error('closed')); }
}

test('oversized native history is repaired, compacted once between turns, then reused by the queued turn', async () => {
  const uploads: { url: string; bytes: number; value: any }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), value = JSON.parse(bytes.toString());
    uploads.push({ url: req.url!, bytes: bytes.length, value });
    if (bytes.length >= 1_000_000) { res.writeHead(413).end(); return; }
    if (req.url === '/v1/responses/compact') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ output: [message('developer', 'KEEP_DEVELOPER'), message('user', 'Native compacted context'), { type: 'compaction', encrypted_content: 'NATIVE_STATE' }] })); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Facts, constraints, completed work, and next steps.' }] }] } }) + '\n\n');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const rpc = new Native(`http://127.0.0.1:${(server.address() as any).port}/v1`);
  const session = { id: 'session-a', provider: 'codex', purpose: 'work', cwd: process.cwd(), status: 'idle', messages: [], approvals: [], sources: [], permissionMode: 'inherit' } as unknown as AgentSession;
  let done = 0; const events: any[] = [];
  const runtime = new AgentRuntime(session, 'unused', { changed() {}, event: value => events.push(value), done() { done++; } }, undefined,
    { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '*', no_proxy: '*' }, rpc, false, true);
  const queue = new SessionInputQueue({ session: () => session, save: async () => {}, changed() {}, blocked: s => ['starting', 'running', 'approval'].includes(s.status),
    send: async (_id, input) => runtime.prompt(input.text), steer: async () => false });
  try {
    assert.equal(await runtime.prompt('LATEST_KEEP'), true);
    await until(() => rpc.calls.includes('thread/compact/start') || rpc.errors.length > 0);
    assert.deepEqual(rpc.errors, []); assert.equal(session.status, 'running'); assert.equal(done, 0);
    await queue.enqueue(session.id, { text: 'NEXT_TURN', sourceIds: [], capabilities: [], answers: {} });
    await queue.pump(session.id); assert.equal(rpc.turns, 1, 'RPC acknowledgement does not release the queue');
    assert.equal(session.messages.filter(item => item.role === 'assistant').length, 1);
    assert.equal(session.messages.filter(item => item.role === 'tool').length, 0);
    rpc.releaseCompact.resolve();
    await until(() => rpc.compactItemDone || rpc.errors.length > 0);
    assert.deepEqual(rpc.errors, []); assert.equal(done, 0);
    await queue.pump(session.id); assert.equal(rpc.turns, 1, 'item completion alone does not release the queue');
    const compactUpload = uploads.find(item => item.url.endsWith('/compact'))!;
    assert(compactUpload.bytes < 800_000, 'repair leaves headroom before native compact');
    assert.equal(compactUpload.value.instructions, 'KEEP_COMPACT_INSTRUCTIONS');
    assert(JSON.stringify(compactUpload.value.input).includes('LATEST_KEEP'));
    assert(JSON.stringify(compactUpload.value.input).includes('工作台历史交接摘要'));
    const summaries = uploads.filter(item => item.value.tool_choice === 'none').length;
    assert(summaries > 0); assert(uploads.filter(item => item.value.tool_choice === 'none').every(item => item.url === '/v1/responses'));
    rpc.releaseComplete.resolve(); await until(() => done === 1);
    assert.equal(session.status, 'idle'); assert.equal(session.turnTimings?.length, 1);
    await queue.pump(session.id); await until(() => done === 2 || rpc.errors.length > 0);
    assert.deepEqual(rpc.errors, []);
    assert.equal(session.inputQueue?.items.length, 0);
    assert.equal(rpc.calls.filter(method => method === 'thread/compact/start').length, 1);
    assert.equal(uploads.filter(item => item.value.tool_choice === 'none').length, summaries, 'next turn needs no new summary');
    assert(uploads.at(-1)!.value.input.some((item: any) => item.type === 'compaction' && item.encrypted_content === 'NATIVE_STATE'));
    assert(uploads.every(item => item.bytes < 1_000_000));
    assert.equal(session.turnTimings?.length, 2); assert.equal(session.messages.length, 4);
    assert.equal(events.filter(event => event.method === 'workbench/autoCompact' && event.status === 'completed').length, 1);
  } finally {
    rpc.releaseCompact.resolve(); rpc.releaseComplete.resolve();
    await runtime.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  }
});
