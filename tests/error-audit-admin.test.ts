import { collaborationFailure } from '../src/renderer/collaboration-failure';
import { questionWorkSession } from '../src/renderer/question-session';
import { AccountSync } from '../src/core/account-sync';
import type { ConnectionProfile } from '../src/shared/types';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { AdminConnection } from '../src/admin/connection';
import { adminErrorMessage, adminOperationLabel, adminRecoverySummary } from '../src/admin/failure';
import { transferFailureMessage, transferRecordError } from '../src/shared/transfer-failure';
import type { Transfer } from '../src/shared/types';
import { existingAccountRecoveries, existingLinuxAccountCollision } from '../src/admin/member-recovery';
import type { AdminSnapshot } from '../src/admin/types';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DraftTaskList } from '../src/renderer/draft-list';
import type { Draft } from '../src/shared/types';
import { accountSyncFailureMessage } from '../src/shared/account-sync-failure';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TransferQueue } from '../src/core/transfers';
import { logsFor } from '../src/core/logging';
import type { Store } from '../src/core/store';
import type { SharedFiles } from '../src/core/shared-files';
import { publicErrorState } from '../src/main/public-failures';
import { publicFailure } from '../src/main/public-failures';
import { failureError } from '../src/shared/user-failure';
import { taskFailure } from '../src/renderer/task-failure';
import { ErrorLogLink, rememberFailure } from '../src/renderer/error-notice';
import { catalogProjects, purgeProject } from '../src/admin/project-purge';
import type { AdminState } from '../src/admin/types';

test('account-check timeout reports missing response, without diagnosing sudo permissions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connection = new AdminConnection('unused', () => {}) as any;
  connection.client = { exec: (_: string, callback: Function) => callback(undefined, Object.assign(new EventEmitter(), { close() {} })) };
  const pending = connection.simple('id -u');
  t.mock.timers.tick(15000);
  await assert.rejects(pending, error => {
    assert.match((error as Error).message, /未及时返回账号检查结果/);
    assert.doesNotMatch((error as Error).message, /root|sudo|组内管理/);
    return true;
  });
});

test('admin business reasons remain readable while protocol markers and technical failures do not reach the UI', () => {
  assert.equal(adminErrorMessage('[MEMBER_IMPORT] 原密码不正确'), '原密码不正确');
  for (const error of [new Error('read ECONNRESET'), new Error('TypeError: stack trace at fn(file.ts:1)'), new Error('listen EADDRINUSE: address already in use')]) {
    assert.doesNotMatch(adminErrorMessage(error), /ECONNRESET|TypeError|stack trace|EADDRINUSE|file\.ts/);
  }
  assert.equal(adminOperationLabel({ id: 'internal-op', op: 'user_create', request: { username: 'member', name: '验收成员' }, status: 'failed', completed: [] }), '创建用户「验收成员」');
});

test('uncertain transfer receipts preserve the safe retry contract after translating raw network errors', () => {
  const message = transferFailureMessage({ phase: 'awaiting_receipt', kind: 'history' }, new Error('read ECONNRESET'));
  assert.match(message, /文件可能已上传/); assert.match(message, /先检查这次上传，避免重复上传/);
  assert.doesNotMatch(message, /ECONNRESET|尚未开始|上传成功/);
  const prior = transferRecordError({ phase: 'awaiting_receipt', kind: 'upload', error: '服务器可能已接收；重试会先查询原请求回执。 read ECONNRESET' } as Transfer);
  assert.match(prior, /可能已上传/); assert.doesNotMatch(prior, /ECONNRESET/);
});

test('transfer file-system failures do not blame an unverified endpoint', () => {
  for (const detail of ['ENOENT: C:/cache/file.md', 'ENOSPC: remote target', 'EACCES: permission denied']) {
    const message = transferFailureMessage({ phase: 'streaming', kind: 'upload' }, new Error(detail));
    assert.match(message, /传输中断/);
    assert.doesNotMatch(message, /中央节点未找到|本机磁盘空间不足|ENOENT|ENOSPC|EACCES|C:\/cache/);
  }
});

test('a confirmed transfer stays completed when saving its local record fails', async () => {
  for (const permanent of [false, true]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'error-audit-transfer-save-'));
    try {
      const localPath = path.join(root, 'result.md'), body = '已确认的内容'; await fs.writeFile(localPath, body);
      const task = { id: 'transfer', kind: 'history', name: 'result.md', phase: 'queued', status: 'queued', bytes: 0, total: Buffer.byteLength(body), localPath, sha256: createHash('sha256').update(body).digest('hex'), target: '/project/history/result.md', createdAt: new Date().toISOString(), binding: { username: 'demo', project: { id: 'project', name: '验收项目', remoteRoot: '/project' } } } as Transfer;
      let saveFailed = false, persistBlocked = permanent, uploads = 0;
      const store = { root, transfers: [task], conclusions: [], drafts: [], sessions: [], save: async () => { if ((task.phase === 'completed' && !saveFailed) || persistBlocked && saveFailed) { saveFailed = true; throw new Error('ENOSPC: state.json'); } } } as unknown as Store;
      const remote = { projectConnected: () => true, loadManifest: async () => [], channel: () => ({}), ensurePersonalFolder: async () => {}, upload: async () => { uploads++; return ({ id: 'result', revision: 1, path: task.target, sha256: task.sha256, size: task.total, author: 'demo' }); } } as unknown as SharedFiles;
      const queue = new TransferQueue(store, remote, () => {}); queue.resume();
      for (let attempt = 0; (queue as any).active && attempt < 500; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal((queue as any).active, false); assert.equal(saveFailed, true);
      assert.equal(task.status, 'done'); assert.equal(task.phase, 'completed');
      if (permanent) { assert.match(task.error!, /文件已上传，无需重新上传/); assert.match(task.error!, /上传记录没存好/); assert.doesNotMatch(task.error!, /尚未通过校验|ENOSPC/); assert.equal(transferRecordError(task), task.error); assert.equal(publicErrorState({ transfers: [task] }, 'snapshot').transfers[0].error, task.error); await assert.rejects(queue.retrySave(task.id), /ENOSPC/); assert.equal(task.status, 'done'); assert.equal(task.phase, 'completed'); persistBlocked = false; await queue.retrySave(task.id); assert.equal(task.error, undefined); assert.equal(uploads, 1, 'retrying record persistence never retransmits the file'); }
      else assert.equal(task.error, undefined);
    } finally { await logsFor(root).close(); await fs.rm(root, { recursive: true, force: true }); }
  }
});

test('existing-account recovery follows stable failure codes after public text changes', () => {
  const failure = { version: 1 as const, code: 'EXISTING_ACCOUNT_COLLISION', message: '服务器上已有同名账号。请核对后接入。' };
  assert.equal(existingLinuxAccountCollision(failure.message, failure), true);
  assert.equal(existingLinuxAccountCollision('Linux 账号已存在，不能重复创建'), true);
  const snapshot = { connected: false, verified: false, busy: false, state: { initialized: true, users: {}, groups: {}, operations: { a: { id: 'a', op: 'user_create', request: { username: 'demo' }, status: 'failed', completed: [], error: failure.message, failure } } }, memberSync: { teamId: 't', pending: [{ id: 'p', status: 'blocked', createdAt: '', command: { op: 'user_create', username: 'demo', name: '验收成员', groups: [], contentAdminGroups: [] }, error: failure.message, failure }] } } as AdminSnapshot;
  assert.deepEqual(existingAccountRecoveries(snapshot), [{ username: 'demo', name: '验收成员' }]);
});

test('a queued or failed submission record is not described as an independently saved result', () => {
  const draft = { id: 'draft', sessionId: 'session', title: '验收成果', body: '待提交的内容', createdAt: '2026-11-16T02:00:00.000Z', submitted: 'transfer' } as unknown as Draft;
  const render = (status: Transfer['status']) => renderToStaticMarkup(React.createElement(DraftTaskList, { drafts: [draft], sessions: [], transfers: [{ id: 'transfer', status } as Transfer], open() {} }));
  for (const status of ['queued', 'running', 'error'] as const) { assert.match(render(status), /草稿和上传记录仍保留/); assert.doesNotMatch(render(status), /成果已单独保存/); }
  assert.match(render('done'), /成果已单独保存/);
});

test('account sync failures retain local-work continuity without diagnosing an old server', () => {
  const message = accountSyncFailureMessage(new Error('read ECONNRESET'));
  assert.match(message, /资料还在这台电脑上/); assert.match(message, /自动再试/);
  assert.doesNotMatch(message, /ECONNRESET|旧服务器|更新存储服务/);
  assert.equal(accountSyncFailureMessage(message), message);
});

test('task failures replace raw and IPC operation prefixes once and keep the original log reference', () => {
  const raw = taskFailure(new Error('TypeError: isolated task choice failure'), '读取任务负责人列表');
  assert.match(raw, /成员列表没加载出来/); assert.match(raw, /刷新成员和成果/); assert.doesNotMatch(raw, /TypeError/);
  const ownPrefix = taskFailure(new Error('派发任务：负责人已离开项目，请刷新后重新选择。'), '派发任务');
  assert.equal(ownPrefix.split('派发任务').length - 1, 1);
  const logRef = { id: 'b'.repeat(32), operationId: 'assignment-create-audit' };
  const input = failureError(publicFailure(new Error('TypeError: isolated assignment create failure'), 'assignment.create', logRef));
  const message = taskFailure(input, '派发任务');
  assert.match(message, /没收到派发结果/); assert.match(message, /不会多建一条/); assert.doesNotMatch(message, /处理项目任务|执行此操作|TypeError/);
  const target = new EventTarget(), previous = (globalThis as any).window; let detail: unknown;
  target.addEventListener('workbench:view-logs', event => { detail = (event as CustomEvent).detail; });
  try { (globalThis as any).window = target; const link = ErrorLogLink({ message }); (link.props as any).onClick(); assert.deepEqual(detail, logRef); }
  finally { if (previous === undefined) delete (globalThis as any).window; else (globalThis as any).window = previous; }
});

test('task read-status strings inherit remembered log references and keep ambiguous references unscoped', () => {
  const logRef = { id: 'c'.repeat(32), operationId: 'assignment-read-status-audit' };
  const failure = publicFailure(new Error('读取项目任务：任务列表本次未返回，请稍后重新读取。'), 'assignment.list', logRef);
  rememberFailure(failure);
  const accepted = '任务「状态回执测试」已派发，任务列表尚未刷新。请刷新核对，不要重复派发。';
  const message = taskFailure(failure.message, '刷新任务列表', accepted);
  assert.equal(message, accepted); assert.doesNotMatch(message, /读取项目任务：/);
  const target = new EventTarget(), previous = (globalThis as any).window; let detail: unknown;
  target.addEventListener('workbench:view-logs', event => { detail = (event as CustomEvent).detail; });
  try {
    (globalThis as any).window = target; (ErrorLogLink({ message }).props as any).onClick(); assert.deepEqual(detail, logRef);
    rememberFailure({ ...failure, logRef: { id: 'd'.repeat(32), operationId: 'another-read-operation' } });
    const ambiguous = taskFailure(failure.message, '刷新任务列表', accepted);
    (ErrorLogLink({ message: ambiguous }).props as any).onClick(); assert.deepEqual(detail, {}, 'ambiguous same-text operations open the log list instead of guessing an operation');
  } finally { if (previous === undefined) delete (globalThis as any).window; else (globalThis as any).window = previous; }
});

test('unreadable local project directories are unknown, not an empty cleanup catalog', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'error-audit-catalog-'));
  const group = path.join(root, 'projects', 'audit'), state = { groups: { audit: { workspace: '/projects/audit', label: '验收项目' } } } as unknown as AdminState;
  await fs.mkdir(path.join(group, 'registered'), { recursive: true });
  const original = fs.readdir as (...args: any[]) => Promise<any>;
  const mocked = t.mock.method(fs, 'readdir', async (...args: any[]) => { if (path.resolve(String(args[0])) === group) throw Object.assign(new Error('EACCES: isolated catalog denial'), { code: 'EACCES' }); return original(...args); });
  try { await assert.rejects(catalogProjects(root, state), (error: any) => { assert.equal(error.code, 'PROJECT_CATALOG_INCOMPLETE'); assert.match(error.message, /暂未完整读取/); assert.doesNotMatch(error.message, /EACCES/); return true; }); }
  finally { mocked.mock.restore(); await logsFor(root).close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('keep-trajectories cleanup stops before deletion when a result index cannot be read', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'error-audit-purge-'));
  try {
    const projectId = 'project_' + 'a'.repeat(32), directory = path.join(root, 'projects', 'audit', 'registered');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, '.workbench-project.json'), JSON.stringify({ id: projectId, name: '验收项目' }));
    await fs.writeFile(path.join(directory, '.workbench-content.json'), '{broken');
    const file = path.join(directory, 'existing-result.txt'); await fs.writeFile(file, '保留原文件');
    const state = { groups: { audit: { workspace: '/projects/audit', label: '验收项目' } } } as unknown as AdminState;
    await assert.rejects(purgeProject(root, state, projectId, 'keep_trajectories'), /成果索引暂未读取成功/);
    assert.equal(await fs.readFile(file, 'utf8'), '保留原文件');
    assert.equal(await fs.readFile(path.join(directory, '.workbench-content.json'), 'utf8'), '{broken');
    await fs.writeFile(path.join(directory, '.workbench-project.json'), '{broken');
    await assert.rejects(catalogProjects(root, state), /项目目录暂未完整读取/);
  } finally { await logsFor(root).close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('admin recovery describes the next real server checkpoint instead of importing an unrelated password error', () => {
  const job = {id:'create:demo',op:'user_create',request:{username:'demo'},status:'failed' as const,completed:['专用账号已创建']};
  assert.match(adminRecoverySummary(job), /账号「demo」已创建，初始登录密码还没设置/);
  assert.match(adminRecoverySummary({...job,completed:[...job.completed,'初始密码已设置']}), /初始密码已设置好，项目权限还没配完/);
  assert.doesNotMatch(adminRecoverySummary(job), /原密码不正确|root|sudo/);
});
test('a same-ID task collision points to the original sent task rather than another dispatch', () => {
  const message = taskFailure(new Error('任务编号已使用，请重新派发'), '派发任务');
  assert.match(message, /任务已存在.*内容与当前表单不同/); assert.match(message, /我派发的/); assert.doesNotMatch(message, /请重新派发/);
});

test('an unreadable account sync record retains local data and reports that automatic sync did not start', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'error-audit-account-cache-'));
  const profile = {id:'cache-audit',host:'audit.invalid',port:22,username:'demo',fingerprint:'fixture',projects:[]} as unknown as ConnectionProfile;
  const cache = path.join(root,'accounts',createHash('sha256').update(JSON.stringify(['audit.invalid',22,'demo','fixture'])).digest('hex')+'.json');
  const body = '{invalid-json'; await fs.mkdir(path.dirname(cache),{recursive:true}); await fs.writeFile(cache,body);
  let networkCalls = 0;
  const store = {root,settings:{},conclusions:[{id:'retained',content:'隔离本机成果'}],drafts:[],sessions:[]} as unknown as Store;
  const sync = new AccountSync(store,{connected:true,profile,accountSnapshot:async()=>{networkCalls++;throw Error('must not sync after a cache read error');}} as unknown as SharedFiles,()=>{});
  try {
    await sync.activate(profile);
    assert.equal(sync.state.status,'error'); assert.equal(sync.state.failure?.code,'ACCOUNT_SYNC_CACHE_UNREADABLE'); assert(sync.state.failure?.logRef);
    assert.match(accountSyncFailureMessage(sync.state.detail),/同步记录读不了，自动同步没能启动/);
    assert.doesNotMatch(accountSyncFailureMessage(sync.state.detail),/自动再试|后台会继续尝试/);
    assert.equal(store.conclusions[0].id,'retained'); assert.equal(await fs.readFile(cache,'utf8'),body); assert.equal(networkCalls,0); assert.equal((sync as any).polling,undefined);
    const files = await logsFor(root).files(); const records = (await Promise.all(files.filter(file=>file.category==='diagnostic').map(async file=>(await fs.readFile(file.file,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))))).flat();
    assert(records.some(record=>record.name==='account.sync.cache_unreadable'&&record.detail), 'the original parse failure remains in diagnostic logs');
  } finally { await sync.conflicts.close(); await logsFor(root).close(); await fs.rm(root,{recursive:true,force:true}); }
});

test('a newly created same-project work session enables question automation without reusing an unavailable source', () => {
  const create = (id: string, overrides: object = {}) => ({id,purpose:'work',binding:{project:{id:'project'}},...overrides}) as unknown as import('../src/shared/types').AgentSession;
  assert.equal(questionWorkSession(undefined,undefined,'project'),undefined);
  const fresh = create('new-session'), old = create('old-session',{closedAt:'2026-11-16T02:00:00Z'});
  assert.equal(questionWorkSession(fresh,old,'project')?.id,'new-session');
  for (const invalid of [create('prepare',{purpose:'prepare'}),create('native',{cursorNative:{}}),create('closed',{closedAt:'now'}),create('other',{binding:{project:{id:'other-project'}}})]) assert.equal(questionWorkSession(invalid,undefined,'project'),undefined);
  assert.equal(questionWorkSession(undefined,fresh,'project')?.id,'new-session');
});

test('a partial collaboration outcome retains confirmed items even when a later group is rejected', () => {
  const message = '成果A已移到目录甲。成果B的移动尚未完成，请刷新目录。';
  const error = failureError({version:1,code:'PROJECT_ACCESS_REVOKED',message:'没有此项目的访问权限',logRef:{id:'f'.repeat(32)}});
  assert.equal(collaborationFailure(error,message,{domain:'central',operation:'移动成果',outcome:'partial'}),message);
});
