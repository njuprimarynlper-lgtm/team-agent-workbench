import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { cursorNetworkEnvironment } from '../src/core/cursor-network';
const require = createRequire(import.meta.url);
const { guardRequest, runGuarded, CursorCompaction, promptBytes, patchChunk, wrapServicesRequire } = require('../src/core/cursor-request-guard.cjs');

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function context(parent?: any): any {
  let canceled = false;
  return { get canceled() { return canceled || parent?.canceled; }, cancel() { canceled = true; }, withCancel() { const child = context(this); return [child, () => child.cancel()]; } };
}
class Action { action: any; constructor(value: any) { this.action = value.action; } }
function fixture(initialBytes = 1_200_000) {
  let seq = 0, state: any = { rootPromptMessagesJson: [], summaryArchives: [], turns: ['keep-original-turn'], pendingToolCalls: [] };
  const data = new Map<string, Buffer>(), calls: any[] = [], updates: any[] = [];
  const add = (bytes: number) => { const id = Buffer.from(String(++seq)); data.set(id.toString('hex'), Buffer.alloc(bytes, 'a')); state.rootPromptMessagesJson.push(id); };
  add(initialBytes);
  const ctx = context(), blobs = { getBlob: async (_: any, id: Buffer) => data.get(id.toString('hex')), flush: async () => {} };
  let hold: any, failure: any, userGrowth = 0, noCheckpoint = false, nativeAuto = false;
  const run = async (...args: any[]) => {
    const kind = args[2].action.case; calls.push({ kind, state: args[1], id: args[10].conversationId, args });
    if (kind === 'summarizeAction') {
      if (hold) await hold.promise;
      if (failure) throw failure;
      if (args[0].canceled) throw Error('cancelled');
      await args[4].sendUpdate(null, { message: { case: 'textDelta', value: { text: 'invisible compact text' } } });
      if (noCheckpoint) return;
      state = { ...state, summaryArchives: [...state.summaryArchives, ...state.rootPromptMessagesJson], rootPromptMessagesJson: [], summary: Buffer.from('native-summary-' + seq) };
      add(20_000);
    } else { if (userGrowth) add(userGrowth); if (nativeAuto) state = { ...state, summary: Buffer.from('native-auto') }; }
  };
  const args: any[] = [ctx, state, new Action({ action: { case: 'userMessageAction' } }), {}, { sendUpdate() {} }, {}, blobs, {}, { getLatestCheckpoint: () => state }, [], { conversationId: 'same-native-id' }];
  let now = 0;
  const controller = new CursorCompaction(run, { ConversationAction: Action, SummarizeAction: class {}, controlled: () => ({}) }, (value: any) => updates.push(value), () => now, 1000);
  return { controller, args, calls, updates, data, ctx, add, state: () => state, growth: (n: number) => userGrowth = n, hold: (value: any) => hold = value,
    fail: (value: any) => failure = value, time: (value: number) => now = value, noCheckpoint: () => noCheckpoint = true, auto: () => nativeAuto = true };
}

test('actual encoded HTTP body stays below 1 MB; gzip is lossless and exact boundary is rejected before upload', async () => {
  const received: Buffer[] = [];
  const server = http.createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c); received.push(Buffer.concat(chunks)); res.end('ok'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const send = (body: Buffer) => new Promise<void>((resolve, reject) => {
    const req = guardRequest(http.request({ host: '127.0.0.1', port: (server.address() as any).port, method: 'POST' }, res => { res.resume(); res.on('end', resolve); }));
    req.on('error', reject); req.write(body.subarray(0, 11)); req.end(body.subarray(11));
  });
  try {
    const raw = Buffer.alloc(2_000_000, 'native context'), gzip = gzipSync(raw);
    await send(gzip); assert.deepEqual(gunzipSync(received[0]), raw);
    await send(Buffer.alloc(999_999));
    await assert.rejects(send(Buffer.alloc(1_000_000)), /压缩后仍达到 1 MB/);
    await assert.rejects(send(gzipSync(randomBytes(1_200_000))), /压缩后仍达到 1 MB/);
    assert.equal(received.length, 2);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
test('real Node preload intercepts Cursor paths with a base path and consumes its child-only activation flag', async () => {
  const sizes: number[] = [];
  const server = http.createServer(async (req, res) => { let size = 0; for await (const c of req) size += c.length; sizes.push(size); res.end('ok'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const program = `const http=require('node:http');
      function send(size){return new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port:${(server.address() as any).port},path:'/prefix/aiserver.v1.BidiService/BidiAppend',method:'POST'},s=>{s.resume();s.on('end',()=>resolve('ok'));});r.on('error',e=>resolve(e.code));r.end(Buffer.alloc(size));});}
      (async()=>console.log(JSON.stringify({flag:process.env.TEAM_AGENT_CURSOR_REQUEST_GUARD,results:[await send(999999),await send(1000000)]})))();`;
    const child = spawn(process.execPath, ['-e', program, 'acp'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...cursorNetworkEnvironment({ TEAM_AGENT_CURSOR_REQUEST_GUARD: '1' }) } });
    let output = '', error = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => error += b);
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, error); assert.deepEqual(JSON.parse(output), { results: ['ok', 'WB_CURSOR_REQUEST_TOO_LARGE'] });
    assert.deepEqual(sizes, [999999]);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
test('preflight compacts native context on the same session, reuses saved checkpoint, keeps archive and original turns', async () => {
  const f = fixture(); const old = f.state(); await f.controller.execute(...f.args);
  assert.deepEqual(f.calls.map(c => c.kind), ['summarizeAction', 'userMessageAction']);
  assert(f.calls.every(c => c.id === 'same-native-id'));
  assert.notEqual(f.calls[1].state, old); assert.deepEqual(f.state().turns, old.turns);
  assert.deepEqual(f.state().summaryArchives, old.rootPromptMessagesJson);
  assert.equal(f.data.size, 2); assert.equal(await promptBytes(f.ctx, f.state(), f.args[6]), 20_000);
  assert.deepEqual(f.updates.map(u => u.status), ['started', 'completed']);
  await f.controller.execute(...f.args); assert.equal(f.calls.filter(c => c.kind === 'summarizeAction').length, 1);
});
test('wire overflow cancels only its native operation to prevent reconnect/retry loops', async () => {
  const parent = context(); let nativeCtx: any, destroyed: any;
  const request: any = { write() {}, end() {}, destroy(error: Error) { destroyed = error; } };
  await assert.rejects(runGuarded(async (ctx: any) => {
    nativeCtx = ctx; guardRequest(request).end(Buffer.alloc(1_000_000));
    assert(ctx.canceled); throw Error('native cancelled');
  }, [parent]), /压缩后仍达到 1 MB/);
  assert.equal(destroyed.code, 'WB_CURSOR_REQUEST_TOO_LARGE'); assert(nativeCtx.canceled); assert(!parent.canceled);
});
test('post-turn native compaction holds queue until completion and emits no interaction output', async () => {
  const f = fixture(100); f.growth(1_100_000); const gate = deferred(); f.hold(gate);
  const running = f.controller.execute(...f.args);
  while (!f.updates.length) await new Promise(r => setTimeout(r, 1));
  assert.equal(f.updates[0].phase, 'after'); await assert.rejects(f.controller.execute(...f.args), /正在压缩/);
  gate.resolve(); await running;
  assert.deepEqual(f.calls.map(c => c.kind), ['userMessageAction', 'summarizeAction']);
  assert.notEqual(f.calls[1].args[4], f.args[4]); assert.equal(f.updates.at(-1).status, 'completed');
});
test('failed compact backs off, an acknowledgement without a native checkpoint is not success', async () => {
  const f = fixture(); f.noCheckpoint(); await f.controller.execute(...f.args);
  assert.equal(f.updates.at(-1).status, 'failed');
  await f.controller.execute(...f.args); assert.equal(f.calls.filter(c => c.kind === 'summarizeAction').length, 1);
  f.time(60_001); await f.controller.execute(...f.args); assert.equal(f.calls.filter(c => c.kind === 'summarizeAction').length, 2);
});
test('native automatic summary prevents a duplicate maintenance compact; pending tool calls are protected', async () => {
  const f = fixture(100); f.growth(1_100_000); f.auto(); await f.controller.execute(...f.args);
  assert.deepEqual(f.calls.map(c => c.kind), ['userMessageAction']);
  const pending = fixture(); pending.state().pendingToolCalls = ['unclosed-tool']; await pending.controller.execute(...pending.args);
  assert.deepEqual(pending.calls.map(c => c.kind), ['userMessageAction']);
});
test('cancellation stops before user action; a timed-out native job keeps an uncertainty barrier', async () => {
  const f = fixture(), gate = deferred(); f.hold(gate);
  const run = f.controller.execute(...f.args);
  while (!f.updates.length) await new Promise(r => setTimeout(r, 1));
  f.ctx.cancel(); gate.resolve(); await assert.rejects(run, /cancelled/); assert.equal(f.calls.length, 1);
  const timed = fixture(), wait = deferred(); timed.hold(wait); timed.controller.timeoutMs = 15;
  await assert.rejects(timed.controller.execute(...timed.args), /超时/);
  await assert.rejects(timed.controller.execute(...timed.args), /正在压缩/);
  assert.equal(timed.updates.at(-1).status, 'uncertain'); wait.resolve();
});
test('missing blobs cannot be mistaken for small context, unknown bundles cannot claim compatibility', async () => {
  const f = fixture(); f.data.clear(); await assert.rejects(f.controller.execute(...f.args), /记录不完整/); assert.equal(f.calls.length, 0);
  assert.equal(patchChunk({ modules: { irrelevant() {} } }), false);
  assert.throws(() => patchChunk({ modules: { './src/acp/agent-session.ts': () => {} } }), /尚未适配/);
});
test('HTTP/1 preference is scoped to this agent client and does not persist or drop proxy/auth options', () => {
  const config = { network: { useHttp1ForAgent: false }, privacyCache: { ghostMode: true } }; let observed: any;
  const source = { hO: (credentials: any, options: any) => { observed = { credentials, options, config: options.configProvider.get() }; } };
  const module = wrapServicesRequire(() => source)('./src/client.ts');
  module.hO('credential-owner', { configProvider: { get: () => config }, agentEndpoint: 'https://agent.example', serverHttp2Config: 3, requestMiddleware: 'keep' });
  assert.equal(observed.config.network.useHttp1ForAgent, true); assert.equal(config.network.useHttp1ForAgent, false);
  assert.equal(observed.options.agentEndpoint, 'https://agent.example'); assert.equal(observed.credentials, 'credential-owner'); assert.equal(observed.options.requestMiddleware, 'keep');
});
test('installed bundle adapter fingerprints and native summarize protobuf are verified offline', t => {
  const file = path.resolve('.tools/cursor/dist-package/index.js');
  if (!fs.existsSync(file)) { t.skip('bundled CLI is not present in this checkout'); return; }
  const localRequire = createRequire(file), chunk = localRequire('./8412.index.js');
  assert.equal(patchChunk({ ...chunk, modules: { ...chunk.modules } }), true);
  const entry = 'var __webpack_exports__=__webpack_require__("./src/main.tsx")';
  const source = fs.readFileSync(file, 'utf8'); assert(source.includes(entry));
  // Export the loader instead of executing CLI main: no auth, config or network.
  const sandbox: any = { require: localRequire, __filename: file, __dirname: path.dirname(file), module: { exports: {} }, Buffer, TextEncoder, TextDecoder };
  vm.runInNewContext(source.replace(entry, 'module.exports=__webpack_require__'), sandbox);
  const webpack = sandbox.module.exports;
  const proto = webpack('../proto/dist/generated/agent/v1/agent_pb.js');
  assert.equal(proto.SummarizeAction.typeName, 'agent.v1.SummarizeAction');
  const action = new proto.ConversationAction({ action: { case: 'summarizeAction', value: new proto.SummarizeAction() } });
  assert.equal(Buffer.from(action.toBinary()).toString('hex'), '2200');
  const state = new proto.ConversationStateStructure(); assert(Array.isArray(state.rootPromptMessagesJson));
  assert(Array.isArray(state.summaryArchives)); assert(Array.isArray(state.pendingToolCalls));
});

test('actual bundled ACP session invokes the adapter and native summarize action without sending slash-command text', async t => {
  const file = path.resolve('.tools/cursor/dist-package/index.js');
  if (!fs.existsSync(file)) { t.skip('bundled CLI is not present'); return; }
  const localRequire = createRequire(file), source = fs.readFileSync(file, 'utf8');
  const sandbox: any = { require: localRequire, __filename: file, __dirname: path.dirname(file), module: { exports: {} }, Buffer, TextEncoder, TextDecoder };
  vm.runInNewContext(source.replace('var __webpack_exports__=__webpack_require__("./src/main.tsx")', 'module.exports=__webpack_require__'), sandbox);
  const native = sandbox.module.exports, chunk = localRequire('./8412.index.js');
  const copy = { ...chunk, modules: { ...chunk.modules } }; patchChunk(copy);
  const stubs: Record<string, any> = {
    '../agent-core/dist/conversation-actions/controlled.js': { h: class {} },
    './src/bedrock/requested-model.ts': { y: (model: any) => model },
    './src/model-request-format.ts': { K: (v: any) => v, U: () => ({}) },
    './src/utils/interaction-utils.ts': { cT: () => 1 },
    './src/utils/blob-encryption-key-header.ts': { o: () => ({}) },
    './src/analytics.ts': { sx() {} },
    './src/state/session.ts': { d: { getLastParentAgentRequestId: () => null } },
    '../agent-client/dist/index.js': { cc: class extends Error {}, ao: class extends Error {} },
  };
  const loader: any = Object.assign((id: string) => id.startsWith('../proto/') ? native(id) : stubs[id] || {}, native);
  const module: any = { exports: {} }, protocol: string[] = [];
  const capture = t.mock.method(process.stdout, 'write', (value: any) => { protocol.push(String(value)); return true; });
  try {
    copy.modules['./src/acp/agent-session.ts'](module, module.exports, loader);
    const exports = await module.exports;
    const f = fixture();
    const session = Object.create(exports.m.prototype);
    Object.assign(session, { sessionId: 'same-native-id', sharedServices: { agentClient: { run: f.controller.run }, configProvider: {} },
      agentStore: { getMetadata: () => 'default', getId: () => 'same-native-id', getConversationStateStructure: f.state,
        getBlobStore: () => f.args[6], getLatestCheckpoint: f.state },
      currentModel: new (native('../proto/dist/generated/agent/v1/agent_pb.js').ModelDetails)({ modelId: 'fixture' }),
      resources: {}, mcpLease: { getTools: async () => [] }, sentToolCalls: new Set(), announcedToolCallShapes: new Map(), createPlanProgressPresenter: { clear() {} },
      handleSlashCommand: async () => ({ handled: false, cursorCommands: [], selectedSkills: [] }), buildPromptResourceContext: async () => [],
      maybeAutoNameSession() {}, buildRequestedModel: () => undefined, buildBedrockRequestedModelForRun: async () => undefined,
      sendAgentMessageChunk: async (text: string) => { throw Error('unexpected user-facing maintenance text: ' + text); },
    });
    await session.processPrompt({ prompt: [{ type: 'text', text: 'continue actual ACP' }] }, f.ctx);
    assert.deepEqual(f.calls.map(c => c.kind), ['summarizeAction', 'userMessageAction']);
    assert.equal(f.calls[1].args[2].action.value.userMessage.text, 'continue actual ACP');
    assert(protocol.some(line => line.includes('_workbench/cursorGuardReady')));
    assert(protocol.some(line => line.includes('"status":"completed"')));
    assert(f.calls.every(c => c.id === 'same-native-id'));
  } finally { capture.mock.restore(); }
});
