import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { codexPermissionParams, codexPermissions, cursorPermissionArgs, cursorPermissions, inspectPermissions, permissionIssue, setCursorManualReview } from '../src/core/permissions';
import { AgentRuntime } from '../src/core/agents';
import { Workbench } from '../src/core/workbench';
import type { AgentSession, Provider } from '../src/shared/types';
// @ts-expect-error Shared CLI fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';
const until = async (predicate: () => boolean) => { const end = Date.now() + 25000; while (!predicate()) { if (Date.now() > end) throw new Error('permission test timeout'); await new Promise(r => setTimeout(r, 20)); } };
const session = (provider: Provider, cwd: string): AgentSession => ({ id: randomUUID(), title: '权限验证', provider, cwd, purpose: 'work', createdAt: new Date().toISOString(), status: 'idle', messages: [], approvals: [], sources: [], autoUpload: false, handoffPath: path.join(cwd, 'handoff.md') });

test('permission findings distinguish sandbox, policy and filesystem errors from login/network/model text', () => {
  assert.equal(permissionIssue('Windows sandbox CreateProcessAsUser failed')?.kind, 'sandbox');
  assert.equal(permissionIssue('sandbox mode not allowed by administrator policy')?.kind, 'sandbox');
  assert.equal(permissionIssue('blocked by policy')?.kind, 'policy');
  assert.equal(permissionIssue('EACCES: permission denied')?.kind, 'filesystem');
  assert.equal(permissionIssue('401 unauthorized: login required'), undefined); assert.equal(permissionIssue('fetch failed ECONNRESET'), undefined);
  assert.deepEqual(codexPermissionParams({ purpose: 'work', permissionMode: 'inherit' }), {});
  assert.equal(codexPermissionParams({ purpose: 'work', permissionMode: 'review' }).approvalsReviewer, 'user');
  assert.equal(codexPermissionParams({ purpose: 'prepare', permissionMode: 'full' }).sandbox, 'read-only');
  assert.deepEqual(cursorPermissionArgs({ purpose: 'prepare', permissionMode: 'full' }), ['acp']);
  assert.deepEqual(cursorPermissionArgs({ purpose: 'work', permissionMode: 'full' }), ['--force', '--sandbox', 'disabled', 'acp']);
  const r = codexPermissions({ config: { sandbox_mode: 'read-only', approval_policy: 'never', approvals_reviewer: 'auto_review', secret: 'DO_NOT_FORWARD' } }, 'config', { requirements: { allowedSandboxModes: ['read-only'], allowedApprovalPolicies: ['never'] } });
  assert(r.warnings.some(w => w.includes('审批已关闭'))); assert.deepEqual(r.allowedModes, ['inherit']); assert(!JSON.stringify(r).includes('DO_NOT_FORWARD'));
});

test('Cursor manual review is explicit, backs up originals, preserves deny rules/auth, clears global and project allows', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-cursor-perm-')), prior = process.env.CURSOR_CONFIG_DIR; process.env.CURSOR_CONFIG_DIR = path.join(root, 'config');
  const globalFile = path.join(process.env.CURSOR_CONFIG_DIR, 'cli-config.json'), projectFile = path.join(root, '.cursor', 'cli.json');
  try {
    await fs.mkdir(path.dirname(globalFile)); await fs.mkdir(path.dirname(projectFile));
    const global = { version: 1, approvalMode: 'unrestricted', sandbox: { mode: 'enabled' }, permissions: { allow: ['Shell(*)'], deny: ['Read(.env)'] }, auth: { token: 'PRIVATE' } };
    const project = { permissions: { allow: ['Write(*)'], deny: ['Shell(rm)'] }, unrelated: true };
    await fs.writeFile(globalFile, JSON.stringify(global)); await fs.writeFile(projectFile, JSON.stringify(project));
    const before = await cursorPermissions(root); assert.equal(before.approval, 'unrestricted'); assert(!JSON.stringify(before).includes('PRIVATE'));
    assert.equal(JSON.parse(await fs.readFile(globalFile, 'utf8')).approvalMode, 'unrestricted', 'inspection must never edit configuration');
    const after = await setCursorManualReview(root); assert.equal(after.approval, 'allowlist'); assert.deepEqual(after.cursorConfig!.allow, []); assert.deepEqual(after.cursorConfig!.deny, ['Read(.env)', 'Shell(rm)']);
    const changed = JSON.parse(await fs.readFile(globalFile, 'utf8')); assert.equal(changed.auth.token, 'PRIVATE'); assert.equal(changed.sandbox.mode, 'enabled');
    const backup = (await fs.readdir(path.dirname(globalFile))).find(f => f.endsWith('.bak'))!; assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(globalFile), backup), 'utf8')), global);
    await fs.writeFile(globalFile, JSON.stringify(global)); await fs.writeFile(projectFile, '{broken');
    assert.equal((await cursorPermissions(root)).approval, 'unknown');
    await assert.rejects(setCursorManualReview(root));
    assert.deepEqual(JSON.parse(await fs.readFile(globalFile, 'utf8')), global, 'invalid project config must not partially change global policy');
  } finally { if (prior === undefined) delete process.env.CURSOR_CONFIG_DIR; else process.env.CURSOR_CONFIG_DIR = prior; await fs.rm(root, { recursive: true, force: true }); }
});

test('Codex manual/full modes are explicit; administrator rejection never falls back to elevated permissions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-perm-modes-'));
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', permissionRuntime: true, turn: 'success' });
  try {
    for (const mode of ['review', 'full'] as const) {
      const s = session('codex', root); s.permissionMode = mode;
      const runtime = new AgentRuntime(s, fixture.launcher, { changed: () => {}, done: () => {}, event: () => {} });
      try {
        await runtime.prompt('mode check'); await until(() => s.status === 'idle');
        assert.equal(s.permissions!.execution, 'passed'); assert.match(s.permissions!.executionDetail!, /不代表/);
        assert.equal(s.permissions!.approval, mode === 'review' ? 'untrusted' : 'never');
        assert.equal(s.permissions!.sandbox, mode === 'review' ? 'workspaceWrite' : 'dangerFullAccess');
      } finally { await runtime.close(); }
    }
    await fixture.write({ status: 'ready', rejectPermissionMode: true });
    const s = session('codex', root); s.permissionMode = 'full';
    const runtime = new AgentRuntime(s, fixture.launcher, { changed: () => {}, done: () => {}, event: () => {} });
    try { await assert.rejects(runtime.prompt('blocked'), /administrator policy/); assert(s.permissionIssue); }
    finally { await runtime.close(); }
    const calls = (await fs.readFile(path.join(root, 'cli/rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(x => JSON.parse(x));
    assert.equal(calls.filter(x => x.method === 'turn/start').length, 2, 'blocked policy must not start a model turn');
    assert.equal(calls.filter(x => x.method === 'thread/start').length, 3, 'no fallback or hidden retries');
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('Native approval limits: deny-only Codex request and Cursor without one-time options never offer broader grants', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-perm-options-'));
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', toolApproval: true, denyOnly: true, noOnce: true });
  try {
    for (const provider of ['codex', 'cursor'] as const) {
      const s = session(provider, root), events: any[] = [];
      const runtime = new AgentRuntime(s, fixture.launcher, { changed: () => {}, done: () => {}, event: e => events.push(e) });
      try {
        const pending = runtime.prompt('check limited options');
        if (provider === 'codex') {
          await until(() => s.approvals.length > 0); assert.deepEqual(s.approvals[0].options.map(o => o.id), ['decline']);
          assert.throws(() => runtime.answer(s.approvals[0].id, 'accept'), /无效/); runtime.answer(s.approvals[0].id, 'decline');
        }
        await pending; await until(() => s.status === 'idle');
        if (provider === 'cursor') { assert.equal(s.approvals.length, 0); assert(s.messages.some(m => m.text.includes('一次性授权选项'))); assert(!events.some(e => e.direction === 'user' && e.result)); }
      } finally { await runtime.close(); }
    }
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('Codex live protocol: config restrictions, effective runtime, sandbox execution failure, no hidden elevation or auth misclassification', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-codex-perm-'));
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', permissionRuntime: true, permissionConfig: { sandbox: 'read-only', approval: 'never' }, probeBlocked: true, permissionDenied: 'sandbox command execution denied' });
  const s = session('codex', root), authFailures: unknown[] = [];
  const runtime = new AgentRuntime(s, fixture.launcher, { changed: () => {}, done: () => {}, event: () => {}, authFailed: e => authFailures.push(e) });
  try {
    const config = await inspectPermissions('codex', fixture.launcher, root); assert.equal(config.sandbox, 'read-only'); assert(!JSON.stringify(config).includes('DO_NOT_FORWARD'));
    await runtime.prompt('test'); await until(() => s.status === 'idle');
    assert.equal(s.permissions!.sandbox, 'readOnly'); assert.equal(s.permissions!.execution, 'blocked'); assert.equal(s.permissionIssue!.kind, 'sandbox'); assert.deepEqual(authFailures, []);
    const calls = (await fs.readFile(path.join(root, 'cli/rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(x => JSON.parse(x));
    const start = calls.find(x => x.method === 'thread/start'); assert.equal(start.params.sandbox, undefined); assert.equal(start.params.approvalPolicy, undefined);
    assert.equal(calls.filter(x => x.method === 'turn/start').length, 1); assert.equal(calls.find(x => x.method === 'command/exec').params.sandboxPolicy.type, 'readOnly');
    const wb = new Workbench(path.join(root, 'store'), () => {}, () => {}); await wb.store.init(); wb.store.sessions.push(s);
    await wb.changePermissions(s.id, 'review'); assert.equal(s.permissionMode, 'review'); assert.equal(s.nativeId, 'fake-thread'); assert.equal(s.permissions, undefined); await wb.close();
  } finally { await runtime.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

for (const provider of ['codex', 'cursor'] as const) test(provider + ': approval notification, explicit allow/deny, no persistent grant, stale response rejection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-approval-'));
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', toolApproval: true }); const s = session(provider, root);
  let notices = 0; const events: any[] = [];
  const runtime = new AgentRuntime(s, fixture.launcher, { changed: () => {}, done: () => {}, event: e => events.push(e), needsApproval: () => notices++ });
  try {
    if (provider === 'codex') {
      await fixture.write({ status: 'ready', turn: 'success', turnId: 'fast-complete' });
      await runtime.prompt('fast completion before approval'); await until(() => s.status === 'idle');
      await fixture.write({ status: 'ready', toolApproval: true, turnId: 'review-turn-1' });
    }
    const first = runtime.prompt('do work'); await until(() => s.approvals.length > 0); const request = s.approvals[0];
    assert.equal(notices, 1); assert(!request.options.some(o => o.id === 'always')); assert.equal(events.some(x => x.direction === 'user' && x.result), false);
    runtime.answer(request.id, request.options.find(o => o.kind === 'deny')!.id); await first; await until(() => s.status === 'idle');
    if (provider === 'codex') await fixture.write({ status: 'ready', toolApproval: true, turnId: 'review-turn-2' });
    const second = runtime.prompt('try next operation'); await until(() => s.approvals.length > 0); assert.notEqual(s.approvals[0].id, request.id);
    assert.throws(() => runtime.answer(request.id, request.options[0].id), /过期/);
    runtime.answer(s.approvals[0].id, s.approvals[0].options.find(o => o.kind === 'allow')!.id); await second; await until(() => s.status === 'idle');
    assert.equal(notices, 2); assert.equal(events.filter(x => x.direction === 'user' && x.result).length, 2);
  } finally { await runtime.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
