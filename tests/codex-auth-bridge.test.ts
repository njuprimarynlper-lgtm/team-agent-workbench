import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntime } from '../src/core/agents';
import { prepareCodexStorage } from '../src/core/codex-storage';
import type { AgentSession } from '../src/shared/types';
// @ts-expect-error Shared CLI fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';
test('isolated Codex uses personal login and refreshes in memory without leaking credentials; changed accounts fail closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-auth-bridge-'));
  const f = await authLauncher(path.join(root, 'cli'), { status: 'ready', refreshAuth: true });
  const events: unknown[] = [];
  const s: AgentSession = { id: randomUUID(), title: '登录桥接', provider: 'codex', cwd: root, purpose: 'work', createdAt: new Date().toISOString(), status: 'idle', messages: [], approvals: [], sources: [], autoUpload: false, handoffPath: path.join(root, 'handoff.md') };
  const storage = await prepareCodexStorage(path.join(root, 'data'), s, path.join(root, 'personal'));
  const runtime = new AgentRuntime(s, f.launcher, { changed: () => {}, done: () => {}, event: e => events.push(e) }, storage);
  const finished = async () => { const end = Date.now() + 20000; while (s.status === 'running') { if (Date.now() > end) throw new Error('refresh timeout'); await new Promise(r => setTimeout(r, 20)); } };
  try {
    await runtime.prompt('refresh'); await finished(); assert.equal(s.status, 'idle'); assert((await f.calls()).includes('auth-refresh-ok'));
    await f.write({ status: 'ready', refreshAuth: true, accountId: 'different-person' });
    await runtime.prompt('must not change accounts'); await finished(); assert.equal(s.status, 'error'); assert((await f.calls()).includes('auth-refresh-rejected'));
    assert(!JSON.stringify({ events, session: s }).includes('PRIVATE_FIXTURE_TOKEN'));
    assert(!JSON.stringify(events).includes('account/chatgptAuthTokens/refresh'));
    await assert.rejects(fs.access(path.join(storage.home, 'auth.json')));
  } finally { await runtime.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
