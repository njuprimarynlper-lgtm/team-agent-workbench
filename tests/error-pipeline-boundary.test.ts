import test from 'node:test';
import assert from 'node:assert/strict';

test('known background failures preserve their object while normal notification titles remain content', () => {
  for (const title of ['自动对话建议结束：排查 ECONNRESET','求助有后续：修复 EACCES','定时任务完成：调查 ECONNRESET','收到求助答复：排查 EACCES']) {
    const normal = publicErrorState({type:'notice',message:title},'session.status');
    assert.equal(normal.message,title); assert.equal((normal as any).failure,undefined);
  }
  for (const raw of ['定时任务后台：disk unavailable','会话记录保存失败：disk unavailable']) {
    const failure = publicErrorState({type:'notice',message:raw},'session.status') as any;
    assert.ok(failure.failure); assert.doesNotMatch(failure.message,/disk unavailable/);
    assert.match(failure.message,raw.startsWith('定时')?/定时任务.*运行记录/:/会话记录.*保留工作台窗口/);
  }
});

test('known asynchronous notice prefixes never leak plain-English backend diagnostics', () => {
  for (const prefix of ['定时任务执行记录未保存','项目资料引用未加入','个人成果接口暂不可用','AI 推荐参考暂未恢复','会话自动上传未完成','会话文件未上传','项目说明未更新','同步请求暂未完成']) {
    const shown=publicErrorState({type:'notice',message:prefix+'：disk unavailable'},'session.status') as any;
    assert.ok(shown.failure,prefix);assert.doesNotMatch(shown.message,/disk unavailable/);
    assert.doesNotMatch(shown.message,/这次操作有没有完成|更新会话失败/);
  }
});

test('an existing diagnostic reference survives UI projection and still resolves the original cause', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-original-log-')),logger=new LogService(root);
  try {
    const ref=logger.record('diagnostic','preparation.interrupted',accountLogScope(root),{level:'error',detail:'Network timeout: connection reset'});
    assert.ok(ref?.id);
    const failure={version:1 as const,code:'PREPARATION_CONNECTION_INTERRUPTED',outcome:'unknown' as const,message:'成果整理中断，结果需要核对。',logRef:ref};
    const notice=publicErrorState({type:'notice',message:failure.message,failure},'session.status',logger,root);
    const snapshot=publicErrorState({draft:{generationError:failure.message,generationErrorFailure:failure}},'snapshot',logger,root);
    assert.equal(notice.failure.logRef?.id,ref.id);assert.equal(snapshot.draft.generationErrorFailure.logRef?.id,ref.id);
    assert.equal(notice.failure.outcome,'unknown');
    const detail=await logger.get(ref.id!,{account:accountLogScope(root).account!});
    assert.match(detail.record?.detail||'',/Network timeout: connection reset/);
  } finally {await logger.close();await fs.rm(root,{recursive:true,force:true});}
});

test('partial notices retain completed facts and do not contradict them with a generic unknown operation', () => {
  for (const [raw,expected] of [
    ['引导已送达，但本地记录保存失败：EIO: write failed',/补充消息已发给 AI.*本机聊天记录还没保存/],
    ['会话已迁移，提问关联将在后台继续清理：EIO: cleanup failed',/会话已迁移.*求助关联还没清理完/],
    ['“验收会话”已关闭。停止后台进程时出现问题：EIO: close failed',/验收会话.*已关闭.*还没确认 AI 后台/],
    ['整理记录已删除，临时文件暂未清理：EIO: cleanup failed',/整理记录已删除.*临时文件还没清理完/],
  ] as const) {
    const shown=publicErrorState({type:'notice',message:raw},'session.status') as any;
    assert.equal(shown.failure.outcome,'partial');assert.match(shown.message,expected);
    assert.doesNotMatch(shown.message,/EIO|write failed|更新会话|这次操作有没有完成/);
  }
  const typed={version:1 as const,code:'CURSOR_SUBMISSION_UNCONFIRMED',outcome:'unknown' as const,message:'这条消息是否已发出还不知道。先查看会话，不要重发。'};
  const shown=publicErrorState({type:'notice',message:typed.message,failure:typed},'session.status');
  assert.equal(shown.failure.code,typed.code);assert.equal(shown.failure.outcome,'unknown');assert.equal(shown.message,typed.message);
});
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publicErrorState } from '../src/main/public-failures';
import { userFailure } from '../src/shared/user-failure';
import { preparationErrorMessage } from '../src/shared/preparation-error';
import { LogService, accountLogScope } from '../src/core/logging';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GuardConnectionError } from '../src/renderer/codex-request-guard';

test('snapshot and delta failures preserve logs, isolate model text, and describe the correct connection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-error-boundary-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logger = new LogService(root), raw = 'connect ECONNREFUSED 192.0.2.1:22 token=NEVER_EXPOSE';
  const input = { connection: { workspaces: [{ accessError: raw }] }, session: { id: 'ceff9362-b795-436d-9b39-7e555589c6ad', provider: 'codex', error: 'turn/start 超时', desktopSyncError: raw, messages: [{ role: 'tool', text: raw }] } };
  try {
    const shown = publicErrorState(input, 'snapshot', logger, root);
    assert.match(shown.connection.workspaces[0].accessError, /中央节点/); assert.doesNotMatch(shown.connection.workspaces[0].accessError, /模型服务|ECONNREFUSED|NEVER_EXPOSE/);
    assert.doesNotMatch(shown.session.error, /turn\/start|尚未开始/); assert.doesNotMatch(shown.session.desktopSyncError, /ECONNREFUSED|NEVER_EXPOSE/);
    assert.equal(shown.session.messages[0].text, raw); assert.equal(input.session.error, 'turn/start 超时');
    const failure = (shown.connection.workspaces[0] as any).accessErrorFailure; assert.ok(failure.logRef.id);
    const scope = { account: accountLogScope(root).account! }, detail = await logger.get(failure.logRef.id, scope);
    assert.match(detail.record?.detail || '', /ECONNREFUSED/); assert.doesNotMatch(detail.record?.detail || '', /NEVER_EXPOSE/);
    const repeated = publicErrorState(input, 'snapshot', logger, root); assert.equal((repeated.connection.workspaces[0] as any).accessErrorFailure.logRef.id, failure.logRef.id);
  } finally { await logger.close(); }
});

test('failed notices are public failures while successful notices and user content remain unchanged', () => {
  const failed = publicErrorState({ type: 'notice', message: '定时任务执行记录未保存：ENOSPC: no space left on device' }, 'session.status');
  assert.doesNotMatch(failed.message, /ENOSPC|no space left on device/);
  const success = { type: 'notice', message: '文件已加入下载队列，可在传输记录查看结果' };
  assert.equal(publicErrorState(success, 'session.status').message, success.message);
});

test('public snapshots retain known submission results and codes independently of rewritten wording', () => {
  const failure = { version: 1, code: 'LOCAL_RECORD_SAVE_FAILED_AFTER_SUBMISSION', message: '消息已经发送，本机记录还没有保存。', outcome: 'accepted', phase: 'persist-session', recovery: 'retry' };
  const shown: any = publicErrorState({ sessions: [{ id: 'session', provider: 'codex', error: failure.message, failure }] }, 'snapshot');
  assert.equal(shown.sessions[0].failure.code, failure.code);
  assert.equal(shown.sessions[0].failure.outcome, 'accepted');
  assert.equal(shown.sessions[0].failure.phase, 'persist-session');
});

test('technical mixed-language messages, untrusted failure objects and uncertain transfer locations never leak or guess an endpoint', () => {
  for (const raw of ['本地 sessions.json 无法读取，原文件已保留：C:\\fixture\\sessions.json', '服务器操作失败：[Errno 13] Permission denied: /srv/fixture/file', '已拦截未声明的会话移除，原账号资料未覆盖。恢复快照：D:\\fixture\\recovery.json']) {
    assert.doesNotMatch(userFailure(Error(raw)).message, /[A-Z]:\\|\[Errno|\/srv\/fixture/);
  }
  const forged = userFailure({ failure: { version: 1, code: 'UNTRUSTED', message: '发生错误 password=PRIVATE', raw: 'DO_NOT_COPY' } });
  assert.doesNotMatch(JSON.stringify(forged), /PRIVATE|DO_NOT_COPY/);
  assert.doesNotMatch(userFailure(Error('EACCES: permission denied, open C:\\fixture\\upload.json'), { domain: 'transfer' }).message, /中央节点账号/);
  assert.doesNotMatch(userFailure(Error('ENOENT: open C:\\fixture\\upload.json'), { domain: 'transfer' }).message, /中央节点未找到/);
  assert.doesNotMatch(userFailure(Error('[Errno 28] No space left on device'), { domain: 'transfer' }).message, /本机磁盘/);
  assert.doesNotMatch(userFailure(Error('turn/start 超时'), { domain: 'cli', outcome: 'unknown' }).message, /尚未开始|请直接重试/);
});

test('transfer state presentation retains receipt uncertainty and validation/rejection stages', () => {
  const shown = publicErrorState({ transfers: [
    { kind: 'upload', phase: 'awaiting_receipt', status: 'error', error: '服务器可能已接收；重试会先查询原请求回执。 connect ECONNREFUSED 192.0.2.1:22' },
    { kind: 'download', phase: 'verifying', status: 'error', error: '传输已结束但结果尚未通过校验；不会标记为成功。 EIO: bad file descriptor' },
    { kind: 'upload', phase: 'rejected', status: 'error', error: '服务器已拒绝此次请求；重试前会重新核对账号和项目权限。 [Errno 13] Permission denied' },
  ] }, 'snapshot');
  assert.match(shown.transfers[0].error, /可能已上传|还没收到|暂时没查到/);
  assert.equal((shown.transfers[0] as any).failure.outcome, 'unknown');
  assert.equal((shown.transfers[0] as any).failure.phase, 'awaiting_receipt');
  assert.match(shown.transfers[1].error, /校验|完整/); assert.match(shown.transfers[2].error, /拒绝|权限/);
  assert.doesNotMatch(JSON.stringify(shown), /ECONNREFUSED|bad file descriptor|\[Errno/);
});

test('preparation keeps business reasons and does not diagnose network or expired login from an unclassified timeout', () => {
  assert.match(preparationErrorMessage(Error('本次整理超过 5 项，请重新精简整理')), /5|精简/);
  assert.match(preparationErrorMessage(Error('AI 返回了未选择的“项目经验”，请重试整理。')), /AI.*未选.*项目经验.*没有保存/);
  assert.doesNotMatch(preparationErrorMessage(Error('initialize timeout')), /网络连接中断|登录已失效/);
  assert.doesNotMatch(preparationErrorMessage(Error('CLI 登录检测超时')), /登录已失效/);
});

test('new network metadata and legacy markers preserve certificate recovery without exposing protocol text', () => {
  const marker = '[WB_NET|certificate|CERT_HAS_EXPIRED|proxy]';
  const failure = userFailure(Error(marker));
  const controls = { configure() {}, async testConnection() { return { ok: true, message: '连接检查通过' }; } };
  const modern = renderToStaticMarkup(React.createElement(GuardConnectionError, { message: failure.message, problem: failure.networkProblem, ...controls }));
  const legacy = renderToStaticMarkup(React.createElement(GuardConnectionError, { message: marker, ...controls }));
  for (const shown of [modern, legacy]) { assert.match(shown, /设置企业证书/); assert.match(shown, /重新检测/); assert.doesNotMatch(shown, /WB_NET|CERT_HAS_EXPIRED/); }
});
