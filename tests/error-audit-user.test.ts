import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Workbench } from '../src/core/workbench';
import { CursorNativeRpc } from '../src/core/cursor-native-rpc';
import { checkedSessionFile, listSessionFiles } from '../src/core/session-files';
import { claudeAuth, cursorAuth } from '../src/core/provider-auth';
import { logsFor } from '../src/core/logging';
import { preparationErrorMessage, preparationFailure } from '../src/shared/preparation-error';
import { publicErrorState } from '../src/main/public-failures';
import { submissionMayHaveArrived } from '../src/renderer/submission-failure';
import { CliConnectionNotice } from '../src/renderer/cli-connection-notice';
import { PermissionSummary } from '../src/renderer/permissions';
import type { AgentSession, PermissionReport } from '../src/shared/types';

test('lost Cursor enqueue acknowledgement remains unknown and never claims the message was not sent', async () => {
  const rpc = new CursorNativeRpc({ provider: 'cursor', purpose: 'work', networkRoute: 'direct', nativeId: 'audit-native', cursorNative: { transport: 'ide-files-v1' } } as AgentSession);
  (rpc as any).descriptor = { expiresAt: '2099-01-01T00:00:00Z', endpoint: 'http://127.0.0.1:1/native/audit' };
  const original = globalThis.fetch; let requests = 0, submitted = 0;
  globalThis.fetch = async () => { requests++; throw Error('fetch failed ECONNRESET'); };
  try {
    await assert.rejects(rpc.request('cursor/nativeEnqueue', { id: 'same-id', text: 'audit' }, 1000, () => submitted++), (error: any) => {
      assert.equal(error.code, 'CURSOR_SUBMISSION_UNCONFIRMED'); assert.equal(error.failure.outcome, 'unknown');
      assert.match(error.message, /查看这个会话的最后一条消息/); assert.doesNotMatch(error.message, /ECONNRESET|fetch/); return true;
    });
    assert.equal(requests, 1); assert.equal(submitted, 0);
  } finally { globalThis.fetch = original; }
});

test('missing runtime makes approval explicitly not submitted while leaving the request untouched', () => {
  const request = { id: 'r', selection: 'accept' };
  const session = { status: 'approval', approvals: [request] } as unknown as AgentSession;
  assert.throws(() => Workbench.prototype.answer.call({ session: () => session, runtimes: new Map(), changedSession() {} } as any, 's', request.id, request.selection), (error: any) => {
    assert.equal(error.failure.outcome, 'not-started'); assert.equal(error.code, 'APPROVAL_NOT_SUBMITTED'); assert.match(error.message, /这次选择还没交给/); return true;
  });
  assert.equal(request.selection, 'accept'); assert.equal(session.status, 'error'); assert.deepEqual(session.approvals, [request]);
});

test('restoring a failed connection pauses queued inputs and never prompts or approves a task', async () => {
  const session = { id: 's', provider: 'codex', purpose: 'work', status: 'error', cwd: 'C:/audit', approvals: [{ id: 'old' }], inputQueue: { paused: false, items: [{ id: 'pending' }] } } as unknown as AgentSession;
  let starts = 0, saves = 0;
  const runtime = { ensureStarted: async () => { starts++; }, prompt: () => assert.fail('restore must not prompt'), answer: () => assert.fail('restore must not approve') };
  const host: any = { session: () => session, assertWorkspace() {}, assertCanWork() {}, questions: { lockedPeer: () => undefined }, sending: new Set(), steering: new Set(), stoppingSessions: new Set(), attachingCodex: new Set(), changingSettings: new Set(), runtimes: new Map(), broadcast() {}, requireAuth: async () => {}, runtime: async () => runtime, store: { saveSession: async () => { saves++; } }, sessionNotice() {} };
  assert.equal(await Workbench.prototype.reconnectSession.call(host, 's'), session);
  assert.equal(starts, 1); assert.equal(saves, 1); assert.equal(session.status, 'idle'); assert.equal(session.inputQueue?.paused, true); assert.deepEqual(session.approvals, []); assert.equal(host.sending.size, 0);
  host.runtimes.set('s', { activeTurnId: 'active' }); session.status = 'running';
  await assert.rejects(Workbench.prototype.reconnectSession.call(host, 's'), /任务正在运行/); assert.equal(starts, 1);
  host.runtimes.clear(); session.closedAt = 'now'; await assert.rejects(Workbench.prototype.reconnectSession.call(host, 's'), /先打开/);
});

test('accepted prompt followed by local save failure returns accepted without changing running status to error', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-error-audit-'));
  const s = { id: 's', provider: 'codex', purpose: 'work', status: 'idle', cwd: root, messages: [], sources: [], approvals: [] } as unknown as AgentSession;
  let saves = 0, prompts = 0, submitted = 0; const notices: string[] = [];
  const runtime = { ensureStarted: async () => {}, resolveCapabilities: async () => [], prompt: async (_text: string, options: any) => { prompts++; s.status = 'running'; options.submitted(); return true; } };
  const host: any = { store: { root, sessions: [s], saveSession: async () => { if (++saves === 2) throw Object.assign(Error('ENOSPC: local disk full'), { code: 'ENOSPC' }); } },
    attachingCodex: new Set(), sending: new Set(), steering: new Set(), stoppingSessions: new Set(), changingSettings: new Set(), runtimeJobs: new Map(), canceledSends: new Set(),
    questions: { lockedPeer: () => undefined }, assertWorkspace() {}, session: () => s, assertCanWork() {}, providerEnvironment() {}, changedSession() {},
    applyDeferredSettings: async () => {}, adoptLatestProjectBrief: async () => {}, requireAuth: async () => {}, runtime: async () => runtime,
    openCodexDesktopIfClosed: async () => {}, availableSessionContext: async () => ({ text: 'audit', context: {}, sources: [] }), assertReferencesAvailable() {},
    sessionNotice: (_s: AgentSession, message: string) => notices.push(message),
  };
  try {
    assert.equal(await Workbench.prototype.send.call(host, 's', 'audit', [], [], () => submitted++), true);
    assert.equal(prompts, 1); assert.equal(submitted, 1); assert.equal(s.status, 'running'); assert.equal(s.error, undefined);
    assert.equal(s.failure?.outcome, 'accepted'); assert.match(notices[0], /消息已发给 Codex/); assert.doesNotMatch(notices[0], /ENOSPC/);
  } finally { await logsFor(root).close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('an unconfirmed plan remains locked across snapshots and explicit confirmation never resends it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-plan-audit-'));
  const s = { id: 's', provider: 'codex', purpose: 'work', status: 'idle', proposedPlan: { messageId: 'p', ready: true, text: 'audit' } } as AgentSession;
  let sends = 0;
  const host: any = { session: () => s, assertCanWork() {}, changeMode: async () => {}, send: async () => { sends++; throw Error('turn/start 超时'); }, store: { root, saveSession: async () => {} }, broadcast() {}, sending: new Set(), runtimes: new Map() };
  try {
    await assert.rejects(Workbench.prototype.executePlan.call(host, 's', 'p'), (error: any) => error.failure.outcome === 'unknown');
    assert.equal(structuredClone(s).proposedPlan?.submissionUnknown, true);
    await assert.rejects(Workbench.prototype.executePlan.call(host, 's', 'p'), /提交待确认/); assert.equal(sends, 1);
    await Workbench.prototype.confirmPlanRetry.call(host, 's', 'p'); assert.equal(sends, 1); assert.equal(s.proposedPlan?.submissionUnknown, undefined);
    host.assertCanWork = () => { throw Error('没有工作权限'); };
    await assert.rejects(Workbench.prototype.confirmPlanRetry.call(host, 's', 'p'), /没有工作权限/); assert.equal(sends, 1);
  } finally { await logsFor(root).close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('accepted plan whose acceptance record cannot be saved still returns accepted and stays non-repeatable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-plan-save-'));
  const s = { id: 's', provider: 'codex', purpose: 'work', status: 'idle', proposedPlan: { messageId: 'p', ready: true, text: 'audit' } } as AgentSession;
  const host: any = { session: () => s, assertCanWork() {}, changeMode: async () => {}, send: async () => true, store: { root, save: async () => { throw Error('ENOSPC'); } }, broadcast() {}, sessionNotice() {} };
  try {
    assert.equal(await Workbench.prototype.executePlan.call(host, 's', 'p'), true);
    assert.equal(s.proposedPlan?.accepted, true); assert.equal(s.failure?.outcome, 'accepted');
    await assert.rejects(Workbench.prototype.executePlan.call(host, 's', 'p'), /当前不能执行/);
  } finally { await logsFor(root).close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('file access errors propagate instead of becoming deleted files or an empty result', async () => {
  const original = fs.stat; const s = { cwd: process.cwd(), messages: [], outputFiles: ['audit.md'] } as unknown as AgentSession;
  fs.stat = (async () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); }) as typeof fs.stat;
  try {
    await assert.rejects(checkedSessionFile(s, 'audit.md'), { code: 'EACCES' });
    await assert.rejects(listSessionFiles(s), { code: 'EACCES' });
  } finally { fs.stat = original; }
});

test('unparseable auth response does not diagnose an outdated CLI', () => {
  for (const auth of [claudeAuth('unexpected output', 1), cursorAuth('', 1)]) {
    assert.equal(auth.status, 'error'); assert.match(auth.detail, /暂时查不到.*是否已登录/); assert.doesNotMatch(auth.detail, /请更新 CLI 后重试|请使用支持/);
  }
});

test('preparation retains explicit connection interruption and CLI exit without diagnosing ordinary timeouts', () => {
  const reset = preparationErrorMessage(Error('Network timeout: connection reset'));
  assert.match(reset, /网络断开了/); assert.match(reset, /没拿到完整的整理结果/); assert.equal(preparationFailure(Error('Network timeout: connection reset')).code, 'PREPARATION_CONNECTION_INTERRUPTED'); assert.equal(preparationFailure(Error('Network timeout: connection reset')).outcome, 'unknown'); assert.doesNotMatch(reset, /connection reset|timeout/i);
  const exited = preparationErrorMessage(Error('CLI 进程已退出（9）'));
  assert.match(exited, /整理程序 意外停止/); assert.match(exited, /没有整理完成/); assert.equal(preparationFailure(Error('CLI 进程已退出（9）')).code, 'PREPARATION_PROCESS_EXITED'); assert.doesNotMatch(exited, /进程已退出|（9）/);
  for (const error of ['initialize timeout', 'turn/start 超时', 'Network timeout', 'CLI 登录检测超时']) assert.doesNotMatch(preparationErrorMessage(Error(error)), /网络连接中断|CLI 意外停止|登录已失效/);
});

test('known reconnect cause and unreadable permission configuration remain understandable without technical details', () => {
  const connection = renderToStaticMarkup(React.createElement(CliConnectionNotice, { provider: 'codex', value: { state: 'reconnecting', kind: 'authentication', httpStatus: 401, at: '2026-11-16T08:00:00Z' } }));
  assert.match(connection, /登录验证失败/); assert.match(connection, /自动重试/); assert.match(connection, /重新检测连接与登录/); assert.doesNotMatch(connection, /HTTP 401/);
  const report = { provider: 'cursor', source: 'config', sandbox: 'unknown', approval: 'unknown', warnings: ['无法读取 Cursor 权限配置：C:/private/cli.json'], checkedAt: '' } as PermissionReport;
  const permission = renderToStaticMarkup(React.createElement(PermissionSummary, { report }));
  assert.match(permission, /有些权限设置没读出来/); assert.doesNotMatch(permission, /C:\/private|cli.json/);
});


test('submission uncertainty follows typed outcomes and never turns a read or rejected preflight into an unknown send', () => {
  for (const code of ['OPERATION_TIMEOUT', 'CONNECTION_INTERRUPTED', 'UNCLASSIFIED_FAILURE', 'CURSOR_SUBMISSION_UNCONFIRMED']) {
    const failure = { version: 1 as const, code, message: '新版消息不包含旧协议短语' };
    assert.equal(submissionMayHaveArrived(failure, true), true);
    assert.equal(submissionMayHaveArrived(failure, false), false);
    for (const outcome of ['not-started', 'accepted', 'partial'] as const) assert.equal(submissionMayHaveArrived({ ...failure, outcome }, true), false);
    assert.equal(submissionMayHaveArrived({ ...failure, operation: '读取模型列表' }, true), false);
    assert.equal(submissionMayHaveArrived({ ...failure, phase: 'preflight/auth' }, true), false);
  }
  assert.equal(submissionMayHaveArrived({ version: 1, code: 'BUSINESS_RULE', message: '此模型不允许发送' }, true), false);
  assert.equal(submissionMayHaveArrived({ version: 1, code: 'SHARED_CODEX_SUBMISSION_UNCONFIRMED', outcome: 'unknown', message: '新版文字' }, true), true);
});

test('retrying an accepted conversation save only persists the record and never sends a task', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-save-retry-'));
  const s = { id: 's', purpose: 'work', status: 'running', failure: { version: 1, code: 'LOCAL_RECORD_SAVE_FAILED_AFTER_SUBMISSION', outcome: 'accepted', message: '待保存' } } as AgentSession;
  let saves = 0, notices = 0;
  const host: any = { assertWorkspace() {}, assertCanWork() {}, session: () => s, broadcast() {}, sessionNotice() { notices++; }, store: { root, saveSession: async () => { saves++; } }, runtime: () => assert.fail('saving must not create a runtime'), send: () => assert.fail('saving must not send') };
  try {
    assert.equal(await Workbench.prototype.retrySessionSave.call(host, 's'), true);
    assert.equal(saves, 1); assert.equal(notices, 1); assert.equal(s.status, 'running'); assert.equal(s.failure, undefined);
    await assert.rejects(Workbench.prototype.retrySessionSave.call(host, 's'), /没有等待保存/); assert.equal(saves, 1);
    s.failure = { version: 1, code: 'LOCAL_RECORD_SAVE_FAILED_AFTER_SUBMISSION', outcome: 'accepted', message: '待保存' };
    host.store.saveSession = async () => { throw Error('ENOSPC: private path'); };
    await assert.rejects(Workbench.prototype.retrySessionSave.call(host, 's'), (e: any) => { assert.equal(e.failure.outcome, 'accepted'); assert.match(e.message, /聊天记录还是没存下来/); assert.doesNotMatch(e.message, /ENOSPC|private path/); return true; });
    assert.equal(s.failure?.outcome, 'accepted'); assert.equal(s.status, 'running');
  } finally { await logsFor(root).close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('failed background settlement after project disconnect keeps the confirmed disconnected outcome', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-disconnect-'));
  const host: any = { store: { root }, connectedProjects: new Set(['p']), pausedProjects: new Set(), disconnectingProjects: new Set(), assertAccountReady() {}, broadcast() {}, accountSync: { connectionChanged() {}, settle: async () => {} }, projectSync: { settle: async () => {} }, remote: { settleProject: async () => { throw Error('EIO: settle'); } } };
  try {
    await assert.rejects(Workbench.prototype.disconnectProject.call(host, 'p'), (e: any) => { assert.equal(e.code, 'PROJECT_DISCONNECTED_WITH_PENDING_SYNC'); assert.equal(e.failure.outcome, 'accepted'); assert.match(e.message, /本项目已经断开/); return true; });
    assert.equal(host.connectedProjects.has('p'), false); assert.equal(host.disconnectingProjects.has('p'), false);
  } finally { await logsFor(root).close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});


test('retrying a record save rejects a session owned by another account before touching storage', async () => {
  let writes = 0;
  const foreign = { id: 'foreign', binding: { profile: { username: 'other' }, project: { id: 'p' } }, failure: { version: 1, code: 'LOCAL_RECORD_SAVE_FAILED_AFTER_SUBMISSION', outcome: 'accepted', message: '待保存' } } as unknown as AgentSession;
  const host: any = { assertWorkspace() {}, assertAccountReady() {}, assertCanWork() { assert.fail('foreign session must not reach work permission check'); }, movingIds: new Set(), linkingProjects: new Set(), ownsLocal: () => false, store: { sessions: [foreign], saveSession: async () => { writes++; } } };
  host.session = (id: string) => Workbench.prototype.session.call(host, id);
  await assert.rejects(Workbench.prototype.retrySessionSave.call(host, 'foreign'), /不属于当前账号/);
  assert.equal(writes, 0); assert.equal(foreign.failure?.outcome, 'accepted');
});


test('failed session rename rolls back the title, preserves ownership checks, and saves once per attempt', async () => {
  let writes = 0, broadcasts = 0;
  const session = { id: 's', title: '原名称' } as AgentSession;
  const host: any = { assertAccountReady() {}, movingIds: new Set(), linkingProjects: new Set(), ownsLocal: () => true, store: { sessions: [session], save: async () => { writes++; throw Object.assign(Error('denied'), { code: 'EACCES' }); } }, broadcast() { broadcasts++; } };
  host.session = (id: string) => Workbench.prototype.session.call(host, id);
  await assert.rejects(Workbench.prototype.renameSession.call(host, 's', '新名称'), { code: 'EACCES' });
  assert.equal(session.title, '原名称'); assert.equal(writes, 1); assert.equal(broadcasts, 0);
  host.ownsLocal = () => false;
  await assert.rejects(Workbench.prototype.renameSession.call(host, 's', '别名'), /不属于当前账号/); assert.equal(writes, 1);
  host.ownsLocal = () => true; host.store.save = async () => { writes++; };
  assert.equal((await Workbench.prototype.renameSession.call(host, 's', '新名称')).title, '新名称'); assert.equal(writes, 2); assert.equal(broadcasts, 1);
});

test('actual preparation failures emit the named task and typed unknown outcome without a contradictory failed prefix', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-preparation-notice-'));
  const events: any[] = [], helper = { id: 'helper', provider: 'codex', approvals: [], status: 'running' };
  let saves = 0, closed = 0;
  const host: any = { store: { root, save: async () => { saves++; } }, session: () => helper, runtimes: new Map([['helper', { close: async () => { closed++; } }]]), broadcast() {}, notice: (message: string, failure: unknown) => events.push({ type: 'notice', message, failure }) };
  try {
    const unknown: any = { id: 'draft', title: '本轮成果整理', sessionId: 'work', prepareSessionId: helper.id };
    await (Workbench.prototype as any).failPreparation.call(host, unknown, 'Network timeout: connection reset');
    assert.equal(unknown.generation, 'error'); assert.equal(events[0].failure.code, 'PREPARATION_CONNECTION_INTERRUPTED'); assert.equal(events[0].failure.outcome, 'unknown');
    assert.match(events[0].message, /本轮成果整理.*成果整理中断/); assert.match(events[0].message, /左侧“更多”打开“成果整理”/); assert.doesNotMatch(events[0].message, /整理失败|下面|connection reset/);
    assert.deepEqual(events[0].failure.logRef, unknown.generationErrorFailure.logRef);
    const displayed = publicErrorState(events[0], 'session.status'); assert.equal(displayed.message, events[0].message); assert.equal(displayed.failure.outcome, 'unknown');
    const known: any = { id: 'stopped', title: '周报整理', sessionId: 'work', prepareSessionId: helper.id };
    await (Workbench.prototype as any).failPreparation.call(host, known, 'CLI 进程已退出（9）');
    assert.equal(events[1].failure.code, 'PREPARATION_PROCESS_EXITED'); assert.notEqual(events[1].failure.outcome, 'unknown'); assert.match(events[1].message, /周报整理.*成果整理未完成/); assert.match(events[1].message, /Codex 意外停止/);
    assert.equal(saves, 2); assert.equal(closed, 1);
  } finally { await logsFor(root).close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
