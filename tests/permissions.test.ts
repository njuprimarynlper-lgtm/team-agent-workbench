import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { codexPermissionParams, codexPermissions, cursorPermissionArgs, cursorPermissions, inspectPermissions, permissionIssue, setCursorManualReview } from '../src/core/permissions';
import { AgentRuntime } from '../src/core/agents';
import { Workbench } from '../src/core/workbench';
import { permissionReportDescription, sessionPermissionDescription, sessionPermissionLabel } from '../src/shared/permission-presentation';
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
  assert.deepEqual(codexPermissionParams({ purpose: 'work', permissionMode: 'review' }), { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' });
  assert.deepEqual(codexPermissionParams({ purpose: 'work', permissionMode: 'auto' }), { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
  for (const permissionMode of ['inherit', 'review', 'auto', 'full'] as const) {
    assert.deepEqual(codexPermissionParams({ purpose: 'prepare', permissionMode }), { sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' });
    assert.deepEqual(cursorPermissionArgs({ purpose: 'prepare', permissionMode }), ['--force', '--sandbox', 'disabled', 'acp']);
  }
  assert.deepEqual(cursorPermissionArgs({ purpose: 'work', permissionMode: 'full' }), ['--force', '--sandbox', 'disabled', 'acp']);
  assert.throws(() => cursorPermissionArgs({ purpose: 'work', permissionMode: 'auto' }), /暂不支持/);
  const r = codexPermissions({ config: { sandbox_mode: 'read-only', approval_policy: 'never', approvals_reviewer: 'auto_review', secret: 'DO_NOT_FORWARD' } }, 'config', { requirements: { allowedSandboxModes: ['read-only'], allowedApprovalPolicies: ['never'] } });
  assert(r.warnings.some(w => w.includes('审批已关闭'))); assert.deepEqual(r.allowedModes, ['inherit']); assert(!JSON.stringify(r).includes('DO_NOT_FORWARD'));
});

test('native permission names distinguish approval modes from filesystem restrictions and unverified selections', () => {
  const report = (sandbox: string, approval: string, reviewer = 'user') => codexPermissions({ sandbox: { type: sandbox }, approvalPolicy: approval, approvalsReviewer: reviewer }, 'runtime');
  assert.match(permissionReportDescription(report('workspaceWrite', 'on-request')), /^当前：请求批准。/);
  assert.equal(sessionPermissionLabel({ provider: 'codex', permissionMode: 'full', permissions: report('readOnly', 'on-request') }), '自定义设置（请求批准）');
  assert.equal(sessionPermissionLabel({ provider: 'codex', permissionMode: 'full' }), '完全访问');
  assert.match(permissionReportDescription(report('workspaceWrite', 'on-request', 'auto_review')), /^当前：帮我批准。/);
  assert.match(permissionReportDescription(report('dangerFullAccess', 'never')), /^当前：完全访问。/);
  assert.match(permissionReportDescription(report('readOnly', 'on-request')), /^当前：自定义设置（请求批准）。.*仅允许读取/);
  assert.match(permissionReportDescription(report('readOnly', 'never')), /^当前：自定义设置。不会请求批准.*无法修改文件/);
  assert.match(permissionReportDescription(report('dangerFullAccess', 'on-request')), /^当前：自定义设置（请求批准）/);
  assert.match(permissionReportDescription(report('workspaceWrite', 'untrusted')), /^当前：自定义设置。/);
  assert.match(sessionPermissionDescription({ provider: 'codex', permissionMode: 'full', permissions: report('readOnly', 'never') }), /^当前：自定义设置/);
  assert.match(sessionPermissionDescription({ provider: 'codex', permissionMode: 'auto' }), /^已选择：帮我批准/);
  for (const [approval, label] of [['allowlist', 'Allowlist（白名单）'], ['auto-review', 'Auto-review（自动审查）'], ['unrestricted', 'Run Everything（全部运行）']]) {
    const cursorReport = { ...report('unknown', approval), provider: 'cursor' as const, source: 'config' as const };
    assert(permissionReportDescription(cursorReport).startsWith('已保存设置：' + label));
  }
  const restricted = codexPermissions({}, 'config', { requirements: { allowedSandboxModes: ['workspace-write'], allowedApprovalPolicies: ['on-request'], allowedApprovalsReviewers: ['user'] } });
  assert.deepEqual(restricted.allowedModes, ['inherit', 'review']);
  const autoOnly = codexPermissions({}, 'config', { requirements: { allowedSandboxModes: ['workspace-write'], allowedApprovalPolicies: ['on-request'], allowedApprovalsReviewers: ['auto_review'] } });
  assert.deepEqual(autoOnly.allowedModes, ['inherit', 'auto']);
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

test('Codex native presets are explicit; administrator rejection never falls back to elevated permissions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-perm-modes-'));
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', permissionRuntime: true, turn: 'success' });
  try {
    for (const mode of ['review', 'auto', 'full'] as const) {
      const s = session('codex', root); s.permissionMode = mode;
      const runtime = new AgentRuntime(s, fixture.launcher, { changed: () => {}, done: () => {}, event: () => {} });
      try {
        await runtime.prompt('mode check'); await until(() => s.status === 'idle');
        assert.equal(s.permissions!.execution, 'passed'); assert.match(s.permissions!.executionDetail!, /不代表/);
        assert.equal(s.permissions!.approval, mode === 'full' ? 'never' : 'on-request');
        assert.equal(s.permissions!.sandbox, mode === 'full' ? 'dangerFullAccess' : 'workspaceWrite');
        assert.equal(s.permissions!.reviewer, mode === 'auto' ? 'auto_review' : 'user');
      } finally { await runtime.close(); }
    }
    await fixture.write({ status: 'ready', rejectPermissionMode: true });
    const s = session('codex', root); s.permissionMode = 'full';
    const runtime = new AgentRuntime(s, fixture.launcher, { changed: () => {}, done: () => {}, event: () => {} });
    try { await assert.rejects(runtime.prompt('blocked'), /administrator policy/); assert(s.permissionIssue); }
    finally { await runtime.close(); }
    const calls = (await fs.readFile(path.join(root, 'cli/rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(x => JSON.parse(x));
    assert.equal(calls.filter(x => x.method === 'turn/start').length, 3, 'blocked policy must not start a model turn');
    assert.equal(calls.filter(x => x.method === 'thread/start').length, 4, 'no fallback or hidden retries');
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('Codex refuses to claim auto-review when native runtime keeps another reviewer; Cursor auto switch is rejected without changing the session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-perm-mismatch-'));
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', permissionRuntime: true, permissionRuntimeOverride: { approvalsReviewer: 'user' } });
  const s = session('codex', root); s.permissionMode = 'auto';
  const runtime = new AgentRuntime(s, fixture.launcher, { changed: () => {}, done: () => {}, event: () => {} });
  const wb = new Workbench(path.join(root, 'store'), () => {}, () => {});
  try {
    await assert.rejects(runtime.prompt('do not run'), /权限策略未采用“帮我批准”/);
    assert.equal(s.permissionIssue?.kind, 'policy');
    const calls = (await fs.readFile(path.join(root, 'cli/rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(x => JSON.parse(x));
    assert.equal(calls.filter(x => x.method === 'turn/start').length, 0);
    await runtime.close();
    await fixture.write({ status: 'ready', permissionRuntime: true, permissionRuntimeOverride: { sandbox: { type: 'readOnly' } }, turn: 'success' });
    const limited = session('codex', root); limited.permissionMode = 'review';
    const limitedRuntime = new AgentRuntime(limited, fixture.launcher, { changed: () => {}, done: () => {}, event: () => {} });
    try {
      await limitedRuntime.prompt('read-only work can continue'); await until(() => limited.status === 'idle');
      assert.match(sessionPermissionDescription(limited), /^当前：自定义设置（请求批准）。.*仅允许读取/);
    } finally { await limitedRuntime.close(); }
    await wb.store.init(); const cursor = session('cursor', root); cursor.permissionMode = 'review'; cursor.nativeId = 'keep-native-id'; wb.store.sessions.push(cursor);
    await assert.rejects(wb.changePermissions(cursor.id, 'auto'), /暂不支持/);
    assert.equal(cursor.permissionMode, 'review'); assert.equal(cursor.nativeId, 'keep-native-id');
  } finally { await runtime.close(); await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
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
