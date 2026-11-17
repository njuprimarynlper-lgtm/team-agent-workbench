import test from 'node:test';
import assert from 'node:assert/strict';
import { userFailure, failureError } from '../src/shared/user-failure';
import { publicErrorState, publicFailure } from '../src/main/public-failures';
import { teamAccessRevoked } from '../src/shared/team-cache';
import { errorMessage } from '../src/shared/errors';
import { ZodError } from 'zod';

test('shared Codex read timeouts do not ask users to inspect replies or imply another submission', () => {
  const message = '共享 Codex 操作未能确认完成；请核对已有回复，避免重复发送';
  const legacy = { failure: { version: 1, code: 'BUSINESS_RULE', message, outcome: 'unknown', logRef: { id: 'abcd-1234' } } };
  for (const error of [Error(message), legacy]) {
    const failure = userFailure(error, { domain: 'cli', operation: '读取工具连接状态' });
    assert.equal(failure.code, 'OPERATION_TIMEOUT');
    assert.match(failure.message, /读取工具连接状态.*没有返回结果.*重新读取/);
    assert.doesNotMatch(failure.message, /回复|发送|权限|登录/);
    if (error === legacy) { assert.equal(failure.outcome, 'unknown'); assert.equal(failure.logRef?.id, 'abcd-1234'); }
  }
  const write = userFailure(legacy, { domain: 'cli', operation: '发送消息' });
  assert.equal(write.code, 'BUSINESS_RULE'); assert.equal(write.message, message); assert.equal(write.outcome, 'unknown');
});

test('public errors classify known evidence without showing internal protocol or credentials', () => {
  const values = [
    ['All configured authentication methods failed', 'CENTRAL_AUTH_REJECTED'],
    ['connect ECONNREFUSED 192.0.2.1:22', 'CONNECTION_UNAVAILABLE'],
    ['socket hang up ECONNRESET', 'CONNECTION_INTERRUPTED'],
    ['turn/start 超时', 'OPERATION_TIMEOUT'],
    ['HTTP 403 Forbidden token=TEST_SECRET', 'MODEL_ACCESS_REJECTED'],
    ['HTTP 429 rate limit', 'MODEL_REQUEST_LIMITED'],
    ['PASSWORD_CHANGE_REQUIRED: first login', 'PASSWORD_CHANGE_REQUIRED'],
    ['TypeError: internal token=TEST_SECRET\n at fn (C:/secret.ts:12:1)', 'UNCLASSIFIED_FAILURE'],
  ];
  for (const [input, code] of values) {
    const result = userFailure(Error(input), { domain: 'central', operation: '连接中央节点' });
    assert.equal(result.code, code); assert(!/TEST_SECRET|turn\/start|TypeError|192\.0\.2/.test(result.message));
  }
});
test('unknown results and storage location remain uncertain, never reported as definitely unsent or local', () => {
  assert.match(userFailure(Error('turn/start 超时')).message, /还没收到确认/);
  assert(!/本机|中央节点/.test(userFailure(Object.assign(Error('ENOSPC'), { code: 'ENOSPC' }), { domain: 'transfer' }).message));
  assert(!/中央节点未找到/.test(userFailure(Error('ENOENT'), { domain: 'transfer' }).message));
  assert.match(userFailure(Error('ETIMEDOUT'), { outcome: 'not-started' }).message, /还没开始/);
});
test('generic model and relay authentication errors never ask the user to change central SSH credentials', () => {
  assert.match(userFailure(Error('Authentication failed'), { domain: 'cli', provider: 'cursor' }).message, /Cursor 账号验证没通过/);
  assert.match(userFailure(Error('Authentication failed'), { domain: 'relay' }).message, /代理账号/);
  assert.equal(userFailure(Error('Authentication failed'), { domain: 'central' }).code, 'CENTRAL_AUTH_REJECTED');
});
test('public failure carries code and original outcome through serializable Electron rejection', () => {
  const f = userFailure(Error('PASSWORD_CHANGE_REQUIRED'), { operation: '连接中央节点', phase: 'remote.connect', logRef: { operationId: 'test-operation' }, outcome: 'not-started' });
  const rejection = JSON.parse(JSON.stringify({ message: f.message, code: f.code, failure: f }));
  assert.equal(rejection.code, 'PASSWORD_CHANGE_REQUIRED'); assert.equal(errorMessage(rejection), f.message);
  assert.equal(userFailure(rejection).outcome, 'not-started'); assert.equal(failureError(f).failure.logRef?.operationId, 'test-operation');
  assert.equal(userFailure(rejection).operation, '连接中央节点'); assert.equal(userFailure(rejection).phase, 'remote.connect');
  assert.equal(userFailure({ ...rejection, failure: { ...f, operation: '读取 C:/private/token' } }).operation, undefined, 'untrusted technical operation labels are not exposed');
});
test('snapshot public conversion is immutable, preserves business data and gives async errors metadata', () => {
  const input = { sessions: [{ id: 's', provider: 'codex', error: 'HTTP 403 token=TEST_SECRET', messages: [{ role: 'assistant', text: 'literal HTTP 403 token=USER_TEXT' }] }], connection: { connectionError: 'connect ECONNREFUSED x:22' }, settings: { value: 'unchanged' } };
  const output: any = publicErrorState(input, 'snapshot');
  assert.equal(input.sessions[0].error, 'HTTP 403 token=TEST_SECRET'); assert.equal(output.sessions[0].failure.code, 'MODEL_ACCESS_REJECTED');
  assert.equal(output.sessions[0].messages, input.sessions[0].messages); assert.match(output.connection.connectionError, /中央节点/);
  assert.equal(output.settings.value, 'unchanged');
});
test('access revocation uses stable code, while transport and generic model 403 never revoke project caches', () => {
  const revoked = failureError(userFailure(Error('没有此项目的访问权限')));
  assert(teamAccessRevoked(revoked));
  for (const error of [Error('ECONNREFUSED'), Error('HTTP 403'), Error('ETIMEDOUT')]) assert(!teamAccessRevoked(failureError(userFailure(error))));
});
test('Zod public validation retains field guidance and technical errors are not guessed to be version issues', () => {
  const zod = new ZodError([{ code: 'custom', path: ['port'], message: 'Invalid number' }]);
  assert.match(publicFailure(zod, 'connect').message, /端口/);
  assert(!/更新|重新登录/.test(userFailure(Error('SyntaxError: Unexpected token in JSON')).message));
});
