import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntime } from '../src/core/agents';
import type { AgentSession, Provider } from '../src/shared/types';
async function until(predicate: () => boolean) { const deadline = Date.now() + 10000; while (!predicate()) { if (Date.now() > deadline) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)); } }
for (const mode of ['codex', 'cursor', 'codex-files']) test(mode + ': native session mapping, streaming, approvals and completion', async () => {
  const provider: Provider = mode === 'cursor' ? 'cursor' : 'codex';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-agent-'));
  const script = path.join(root, 'rpc-agent.mjs');
  await fs.copyFile(path.resolve('tests/fixtures/rpc-agent.mjs'), script);
  const launcher = path.join(root, process.platform === 'win32' ? 'agent.cmd' : 'agent.sh');
  await fs.writeFile(launcher, process.platform === 'win32' ? `@echo off\r\nset TEST_PROVIDER=${mode}\r\n"${process.execPath}" "${script}"\r\n` : `#!/bin/sh\nTEST_PROVIDER=${mode} "${process.execPath}" "${script}"\n`, { mode: 0o755 });
  const s: AgentSession = { id: randomUUID(), provider, title: 'test', cwd: root, createdAt: new Date().toISOString(), purpose: 'work', status: 'idle', messages: [], approvals: [], sources: [], autoUpload: false, handoffPath: path.join(root, 'handoff.md') };
  const events: any[] = []; let completed = false;
  const runtime = new AgentRuntime(s, launcher, { changed: () => {}, event: x => events.push(x), done: () => { completed = true; } });
  try {
    const prompt = runtime.prompt('hello'); void prompt.catch(() => {}); await until(() => s.status === 'approval');
    assert.equal(s.nativeId, 'native-session-1'); assert.match(s.messages.find(x => x.role === 'assistant')!.text, /中文回复/);
    assert.equal(completed, false); assert.equal(s.approvals.length, 1);
    if (mode === 'codex-files') assert.deepEqual(JSON.parse(s.approvals[0].details).changes, [{ path: 'solution.py', kind: { type: 'update' }, diff: '-old\n+new' }]);
    assert.throws(() => runtime.answer('approval-1', 'unknown'), /无效/);
    runtime.answer('approval-1', provider === 'codex' ? 'decline' : 'reject-once');
    await prompt; await until(() => completed);
    assert.equal(s.status, 'idle'); assert.equal(s.approvals.length, 0);
    assert(events.some(e => e.direction === 'user' && e.result));
    if (mode === 'codex-files') {
      completed = false;
      await runtime.prompt('second turn'); await until(() => s.status === 'approval');
      assert.equal(JSON.parse(s.approvals[0].details).changes, undefined, 'never reuse a previous turn or another thread diff');
      runtime.answer('approval-1', 'decline'); await until(() => completed);
    }
  } finally { runtime.close(); await new Promise(r => setTimeout(r, 200)); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
});
