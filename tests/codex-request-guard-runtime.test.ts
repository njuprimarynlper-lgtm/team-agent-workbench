import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime } from '../src/core/agents';
import { Store } from '../src/core/store';
import type { AgentRpc } from '../src/core/rpc';
import type { AgentSession } from '../src/shared/types';

class GuardRpc extends EventEmitter implements AgentRpc {
  calls: { method: string; params: any }[] = [];
  constructor(private honor = true, private storedProvider?: string) { super(); }
  async request(method: string, params: any = {}) {
    this.calls.push({ method, params });
    if (method === 'initialize') return {};
    if (method === 'config/read') return { config: { model_provider: 'custom', model_providers: { custom: { name: 'Fixture', base_url: 'http://127.0.0.1:1', wire_api: 'responses' } } } };
    if (method === 'thread/read') return { thread: { id: 'fixture', modelProvider: this.storedProvider } };
    if (method === 'thread/resume' && this.storedProvider === 'workbench_guard_openai' && !params.modelProvider) throw Error('Model provider `workbench_guard_openai` not found');
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'fixture', status: { type: 'idle' } }, modelProvider: this.honor ? params.config?.model_provider || 'custom' : 'unexpected', sandbox: { type: 'readOnly' }, approvalPolicy: 'never' };
    if (method === 'turn/start') return { turn: { id: 'fixture-turn' } };
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
    throw Error('Unexpected ' + method);
  }
  notify() {} respond() {} reject() {}
  async close() { this.emit('closed', Error('closed')); }
}
const makeSession = () => ({ id: 'guard-session', provider: 'codex', purpose: 'work', cwd: process.cwd(), status: 'idle', messages: [], approvals: [], sources: [], permissionMode: 'inherit' } as unknown as AgentSession);
const hooks = { changed() {}, event() {}, done() {} };

test('request guard saves and reloads, with old settings defaulting off', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-store-'));
  try {
    const store = new Store(root); await store.init(); assert.equal(!!store.settings.codexRequestGuard, false);
    store.settings.codexRequestGuard = true; await store.save();
    const reopened = new Store(root); await reopened.init(); assert.equal(reopened.settings.codexRequestGuard, true);
    reopened.settings.codexRequestGuard = false; await reopened.save();
    const again = new Store(root); await again.init(); assert.equal(again.settings.codexRequestGuard, false);
  } finally { assert(root.startsWith(path.join(os.tmpdir(), 'guard-store-'))); await fs.rm(root, { recursive: true, force: true }); }
});

test('enabled runtime installs protection before sending; disabled runtime keeps original route', async () => {
  for (const enabled of [false, true]) {
    const rpc = new GuardRpc(), runtime = new AgentRuntime(makeSession(), 'unused', hooks, undefined, {}, rpc, false, enabled);
    try {
      assert.equal(await runtime.prompt('hello'), true);
      const start = rpc.calls.find(call => call.method === 'thread/start')!;
      assert.equal(!!start.params.config?.['model_providers.custom'], enabled);
      if (enabled) assert.match(start.params.config['model_providers.custom'].base_url, /^http:\/\/127\.0\.0\.1:/);
    } finally { await runtime.close(); }
  }
});

test('a CLI that does not confirm the guarded provider never receives the user turn', async () => {
  const rpc = new GuardRpc(false), runtime = new AgentRuntime(makeSession(), 'unused', hooks, undefined, {}, rpc, false, true);
  try { await assert.rejects(runtime.ensureStarted(), /未确认请求保护/); assert(!rpc.calls.some(call => call.method === 'turn/start')); }
  finally { await runtime.close(); }
});

test('turning protection off restores the configured provider for a previously guarded native thread', async () => {
  const rpc = new GuardRpc(true, 'workbench_guard_openai');
  const runtime = new AgentRuntime({ ...makeSession(), nativeId: 'fixture' }, 'unused', hooks, undefined, {}, rpc, false, false);
  try {
    await runtime.prompt('continue');
    const resumed = rpc.calls.filter(call => call.method === 'thread/resume').at(-1)!;
    assert.equal(resumed.params.modelProvider, 'custom'); assert.equal(resumed.params.config.model_provider, 'custom');
    assert.equal(resumed.params.threadId, 'fixture'); assert.equal((runtime as any).requestGuard, undefined);
  } finally { await runtime.close(); }
});

test('desktop, remote, Cursor and shared connections do not acquire local protection', async () => {
  for (const patch of [{ codexDesktop: true }, { codexRemote: { cwd: '/remote' } }, { provider: 'cursor' }]) {
    const runtime = new AgentRuntime({ ...makeSession(), ...patch } as any, 'unused', hooks, undefined, {}, new GuardRpc(), false, true);
    try { assert.equal((runtime as any).guardEnabled, false); } finally { await runtime.close(); }
  }
});
