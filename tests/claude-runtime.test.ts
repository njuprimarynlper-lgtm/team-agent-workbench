import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentSession } from '../src/shared/types';
import { ClaudeRuntime, claudeNativeMode } from '../src/core/claude-runtime';
import { claudeAuth } from '../src/core/provider-auth';
import { claudeCapabilities } from '../src/core/provider-capabilities';
import { settingsSchema } from '../src/core/config';

const fixture = path.resolve('tests/fixtures/claude-cli.cjs');
const removeTemp = async (dir: string) => { if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected temporary directory'); await fs.rm(dir, { recursive: true, force: true }); };
test('Claude mode and legacy settings migration', () => {
  assert.equal(claudeNativeMode('review', 'work'), 'manual');
  assert.equal(claudeNativeMode('inherit', 'work'), undefined);
  assert.equal(claudeNativeMode('auto', 'work'), 'auto');
  assert.equal(claudeNativeMode('full', 'work'), 'bypassPermissions');
  assert.equal(claudeNativeMode('review', 'prepare'), 'bypassPermissions');
  assert.equal(settingsSchema.parse({ connections: [], providerPaths: { codex: '', cursor: '' }, lastWorkspace: '' }).providerPaths.claude, '');
  assert.equal(claudeAuth('{"loggedIn":true,"email":"alice@example.test"}', 0).identity, 'alice@example.test');
  assert.equal(claudeAuth('{"loggedIn":false}', 1).status, 'unauthenticated');
});

test('Claude discovers project skills and installed plugins without a model call', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'team-agent-claude-skills-'));
  try {
    await fs.mkdir(path.join(cwd, '.claude', 'skills', 'review'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.claude', 'skills', 'review', 'SKILL.md'), 'description: Review this project\n');
    const catalog = await claudeCapabilities(cwd, fixture);
    assert(catalog.skills.some(item => item.invocation === 'review' && item.source === '当前项目'));
    assert(catalog.plugins.some(item => item.name === 'sample-plugin'));
  } finally { await removeTemp(cwd); }
});

test('Claude streams, requests approval and answers, then resumes the same conversation', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'team-agent-claude-'));
  try {
    const session: AgentSession = { id: randomUUID(), title: 'Claude test', provider: 'claude', cwd, purpose: 'work', createdAt: new Date().toISOString(), status: 'idle', messages: [], approvals: [], sources: [], permissionMode: 'review', autoUpload: false, handoffPath: path.join(cwd, 'handoff.md') };
    let runtime: ClaudeRuntime, questions = 0, approvals = 0, done = 0;
    runtime = new ClaudeRuntime(session, fixture, {
      changed: () => { for (const request of [...session.approvals]) { if (request.method !== 'claude/can_use_tool') continue; if (request.questions?.length) { questions++; runtime.answer(request.id, 'answer', { '0': 'B' }); } else { approvals++; runtime.answer(request.id, 'accept'); } } },
      event: () => {}, done: () => { done++; },
    });
    assert.equal(await runtime.prompt('first task'), true);
    const id = session.nativeId;
    assert.ok(id);
    assert.equal(session.messages.find(m => m.role === 'assistant')?.text, 'first');
    assert.equal(await runtime.prompt('second task'), true);
    assert.equal(session.nativeId, id);
    assert.equal(session.messages.filter(m => m.role === 'assistant').at(-1)?.text, 'continued');
    assert.equal(approvals, 2); assert.equal(questions, 2); assert.equal(done, 2);
    assert.equal(session.status, 'idle'); assert.equal(session.approvals.length, 0);
    await runtime.close();
  } finally { await removeTemp(cwd); }
});
