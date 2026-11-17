import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { LogService, logErrorCause } from '../src/core/logging';
import type { LogRecord } from '../src/shared/logs';
import { logTitle } from '../src/shared/log-labels';
const { LogStorage } = createRequire(import.meta.url)('../src/core/log-storage.cjs');
async function temporary(t: any) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-log-query-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
const scope = { account: 'account-a', centralId: 'node-a' };
function record(overrides: Partial<LogRecord> = {}): LogRecord { return { schema: 1, id: randomUUID(), at: new Date(Date.now() - 1000).toISOString(), version: '2.3.46', instance: randomUUID(), category: 'diagnostic', name: 'fixture.failed', level: 'error', ...scope, ...overrides }; }

test('query pagination is stable and bounded; filters and cursors cannot expand account/node/project/session scope', async t => {
  const root = await temporary(t), storage = new LogStorage(root), operationId = randomUUID(), sessionId = randomUUID();
  const rows = Array.from({ length: 7 }, (_, index) => record({ at: new Date(Date.now() - 20000 + index).toISOString(), operationId, sessionId, projectId: 'project-a' }));
  await storage.append([...rows, record({ account: 'account-b' }), record({ centralId: 'node-b' }), record({ projectId: 'project-b', operationId }), record({ level: 'info' })]);
  const input = { limit: 3, operationId, projectId: 'project-a', sessionId };
  const first = await storage.query(input, scope); assert.equal(first.items.length, 3); assert.ok(first.nextCursor);
  const added = record({ at: new Date(Date.now() + 2000).toISOString(), operationId, sessionId, projectId: 'project-a' }); await storage.append([added]);
  const second = await storage.query({ ...input, cursor: first.nextCursor }, scope), third = await storage.query({ ...input, cursor: second.nextCursor }, scope);
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(row => row.id), [...rows].reverse().map(row => row.id)); assert.equal(third.nextCursor, undefined);
  await assert.rejects(storage.query({ ...input, cursor: first.nextCursor }, { ...scope, account: 'account-b' }), /分页已失效/);
  await assert.rejects(storage.query({ ...input, projectId: 'project-b', cursor: first.nextCursor }, scope), /分页已失效/);
  await assert.rejects(storage.query({ cursor: '../logs' }, scope), /分页已失效/);
  assert.equal((await storage.query({ sessionId }, { ...scope, projectId: 'project-b' })).items.length, 0);
  assert.equal((await storage.query({ limit: 10000 }, scope)).items.some((row: LogRecord) => row.account !== scope.account || row.centralId !== scope.centralId), false);
  assert.equal((await storage.query({ from: rows[2].at, to: rows[4].at, code: 'not-present' }, scope)).items.length, 0);
  assert.equal((await storage.query({ from: rows[2].at, to: rows[4].at, projectId: 'project-a' }, scope)).items.length, 3);
});

test('detail reads whitelist and redact existing disk records, and return the same missing result for cross-scope IDs', async t => {
  const root = await temporary(t), logger = new LogService(root), row = record({ detail: 'token=SECRET_VALUE Bearer PRIVATE_VALUE Basic BASIC_SECRET https://user:pass@example.test/private?secret=abc \x1b[31mred\x00 password="QUOTED SECRET VALUE"', stack: 'password=STACK_SECRET', cause: 'api_key=CAUSE_SECRET' });
  await fs.mkdir(path.join(root, 'logs'));
  await fs.writeFile(path.join(root, 'logs', `diagnostic-${Date.now()}-${randomUUID()}.jsonl`), JSON.stringify({ ...row, payload: 'NEVER_COPY', request: { password: 'PRIVATE' } }) + '\n');
  try {
    const list = await logger.query({}, scope); assert.equal(list.items.length, 1); assert.ok(!('detail' in list.items[0])); assert.ok(!('payload' in list.items[0]));
    const detail = await logger.get(row.id, scope), text = JSON.stringify(detail); assert.equal(detail.record?.id, row.id);
    for (const secret of ['SECRET_VALUE', 'PRIVATE_VALUE', 'BASIC_SECRET', 'QUOTED', 'SECRET VALUE', 'STACK_SECRET', 'CAUSE_SECRET', 'NEVER_COPY', 'user:pass', '/private', '\\u001b', '\\u0000']) assert.ok(!text.includes(secret), secret);
    const absent = await logger.get(randomUUID(), scope), otherAccount = await logger.get(row.id, { ...scope, account: 'account-b' }), otherNode = await logger.get(row.id, { ...scope, centralId: 'node-b' });
    assert.equal(absent.record, undefined); assert.equal(otherAccount.record, undefined); assert.equal(otherNode.record, undefined);
    assert.equal((await logger.get(row.id, { ...scope, sessionId: randomUUID() })).record, undefined);
    await logger.cleanup(); assert.equal((await logger.get(row.id, scope)).record, undefined);
  } finally { await logger.close(); }
});

test('rotated gzip logs are browsable, legacy scope is explicit, and incomplete lines do not become records', async t => {
  const root = await temporary(t), storage = new LogStorage(root, { limits: { diagnostic: { days: 14, bytes: 100000, rotate: 600 }, workflow: { days: 90, bytes: 100000, rotate: 600 } } });
  const rows = Array.from({ length: 8 }, () => record({ detail: 'error details '.repeat(10) })); await storage.append(rows);
  assert.ok((await storage.files()).some((file: { file: string }) => file.file.endsWith('.gz')));
  await storage.append([record({ centralId: undefined }), record({ account: undefined, centralId: undefined })]);
  const file = path.join(root, 'logs', `diagnostic-${Date.now()}-${randomUUID()}.jsonl`); await fs.writeFile(file, '{broken}\n' + JSON.stringify(record({ id: randomUUID() })).slice(0, -3));
  const result = await storage.query({ limit: 100 }, scope); assert.equal(result.items.length, 8); assert.ok(result.coverage.legacyScopeSkipped >= 2); assert.ok(result.coverage.malformed >= 2);
  const noNode = await storage.query({}, { account: scope.account }); assert.equal(noNode.items.length, 1); assert.equal(noNode.items[0].centralId, undefined);
});

test('compressed input scanning is bounded and log reader failures never create recursive records', async t => {
  const root = await temporary(t), logger = new LogService(root); await fs.mkdir(path.join(root, 'logs'));
  const bomb = path.join(root, 'logs', `diagnostic-${Date.now()}-${randomUUID()}.jsonl.gz`); await fs.writeFile(bomb, gzipSync(Buffer.alloc(34 * 1024 ** 2, 65)));
  try {
    const result = await logger.query({}, scope); assert.equal(result.coverage.truncated, true); assert.ok(result.coverage.scannedBytes <= 33 * 1024 ** 2); assert.equal(result.items.length, 0);
    await fs.rm(bomb); await fs.rmdir(path.join(root, 'logs')); await fs.writeFile(path.join(root, 'logs'), 'unreadable directory');
    await assert.rejects(logger.query({}, scope), /目录不可读取/); await assert.rejects(logger.get(randomUUID(), scope), /目录不可读取/);
    assert.equal(await fs.readFile(path.join(root, 'logs'), 'utf8'), 'unreadable directory'); assert.equal((await fs.readdir(root)).length, 1);
  } finally { await logger.close(); }
});

test('record references survive repetition, preserve node scope and bound nested causes', async t => {
  const root = await temporary(t), logger = new LogService(root), operationId = randomUUID();
  try {
    const first = logger.record('diagnostic', 'fixture.failed', { ...scope, operationId }, { level: 'error', detail: 'same failure' });
    const repeated = logger.record('diagnostic', 'fixture.failed', { ...scope, operationId }, { level: 'error', detail: 'same failure' });
    assert.equal(repeated?.id, first?.id); assert.equal((await logger.get(first!.id!, scope)).record?.centralId, scope.centralId);
    const cause = Object.assign(Error('disk token=PRIVATE'), { code: 'ENOSPC' }); (cause as any).cause = cause;
    const value = logErrorCause(Error('save failed', { cause })); assert.match(value!, /ENOSPC/); assert.ok(!value!.includes('PRIVATE')); assert.ok(value!.length < 2000);
  } finally { await logger.close(); }
});
test('log titles preserve unknown interruption and identify a local sync startup failure', () => {
  assert.equal(logTitle({ name: 'session.record.background_save_failed', level: 'error', provider: 'codex' }), '本机会话记录保存失败');
  assert.equal(logTitle({ name: 'remote.download', level: 'error', code: 'REMOTE_FILE_MISSING' }), '下载文件失败');
  assert.equal(logTitle({ name: 'content.attachment.download', level: 'error', code: 'REMOTE_FILE_MISSING' }), '下载附件失败');
  assert.equal(logTitle({ name: 'preparation.interrupted', level: 'error' }), '成果整理中断');
  assert.equal(logTitle({ name: 'account.sync.cache_unreadable', level: 'error' }), '账号自动同步未能启动');
  assert.equal(logTitle({ name: 'ipc.failed', code: 'ACCOUNT_SYNC_CACHE_UNREADABLE', level: 'error' }), '账号自动同步未能启动');
  assert.equal(logTitle({ name: 'account.sync.remote_failure', level: 'error' }), '账号资料同步出现问题');
});
