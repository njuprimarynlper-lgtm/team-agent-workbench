import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { LogService, accountLogScope, redactLogText } from '../src/core/logging';
import { exportLogs } from '../src/core/log-export';
import { traceDigest, traceLines, traceFiles, traceHistoryDigest } from '../src/core/trace-reader';
const { LogStorage } = createRequire(import.meta.url)('../src/core/log-storage.cjs');
async function temporary(t: any) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-log-test-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
export function zipContents(buffer: Buffer) {
  const result = new Map<string, string>(), end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let offset = buffer.readUInt32LE(end + 16);
  while (buffer.readUInt32LE(offset) === 0x02014b50) {
    const method = buffer.readUInt16LE(offset + 10), size = buffer.readUInt32LE(offset + 20), names = buffer.readUInt16LE(offset + 28), extras = buffer.readUInt16LE(offset + 30), comments = buffer.readUInt16LE(offset + 32), local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + names).toString(), data = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28), bytes = buffer.subarray(data, data + size);
    result.set(name, (method === 8 ? inflateRawSync(bytes) : bytes).toString()); offset += 46 + names + extras + comments;
  }
  return result;
}
test('ordinary log flood is bounded, repeated errors merge, trace content is not copied into metadata', async t => {
  const root = await temporary(t), logger = new LogService(root);
  try {
    for (let index = 0; index < 10000; index++) logger.record('workflow', 'session.send', { sessionId: randomUUID() }, { outcome: 'requested' });
    for (let index = 0; index < 1000; index++) logger.record('diagnostic', 'network.failed', {}, { level: 'error', detail: 'password=TOP_SECRET Bearer bearer-value TAE1.aabbccddeeff' });
    const status = await logger.status([]); assert.ok(status.queued <= 1000); assert.ok(status.queueBytes <= 2 * 1024 ** 2); assert.ok(status.suppressed > 9000);
    await logger.close();
    const storage = new LogStorage(root), files = await storage.files(); let text = '';
    for (const file of files) text += await fs.readFile(file.file, 'utf8');
    assert.ok(!text.includes('TOP_SECRET')); assert.ok(!text.includes('bearer-value')); assert.ok(!text.includes('TAE1.aabb'));
    const rows = text.trim().split('\n').map(line => JSON.parse(line)); assert.ok(rows.some(row => row.suppressed > 0)); assert.ok(rows.some(row => row.name === 'network.failed.repeated' && row.count === 1000));
  } finally { await logger.close(); }
});
test('rotation, retention, total byte caps and cleanup never delete unrelated files or full traces', async t => {
  const root = await temporary(t), now = Date.now(), limits = { diagnostic: { days: 14, bytes: 1024, rotate: 400 }, workflow: { days: 90, bytes: 700, rotate: 300 } };
  const storage = new LogStorage(root, { limits, now: () => now }); await fs.mkdir(path.join(root, 'logs')); await fs.writeFile(path.join(root, 'logs', 'keep.json'), 'business');
  const old = path.join(root, 'logs', `diagnostic-${now - 15 * 86400000}-${randomUUID()}.jsonl`); await fs.writeFile(old, '{"old":true}\n');
  for (let index = 0; index < 80; index++) await storage.append([{ category: index % 2 ? 'diagnostic' : 'workflow', id: randomUUID(), data: randomUUID().repeat(3) }]);
  let usage = await storage.usage(); assert.ok(usage.diagnostic.bytes <= 1024); assert.ok(usage.workflow.bytes <= 700); assert.equal(await fs.readFile(path.join(root, 'logs', 'keep.json'), 'utf8'), 'business');
  assert.ok(!await fs.stat(old).catch(() => undefined));
  const dir = path.join(root, 'sessions', randomUUID()); await storage.trace(dir, '{"tool":"full-private-output"}\n'); await storage.cleanup(true);
  assert.deepEqual(await Array.fromAsync(traceLines(dir)), ['{"tool":"full-private-output"}']); usage = await storage.usage([root]); assert.equal(usage.traces.sessions, 1); assert.equal(usage.diagnostic.bytes + usage.workflow.bytes, 0);
});
test('legacy and large complete traces retain byte order, evidence line IDs and content hashes across compression and restart', async t => {
  const root = await temporary(t), logger = new LogService(root), dir = path.join(root, 'sessions', randomUUID()); await fs.mkdir(dir, { recursive: true });
  const legacy = '{"at":"2026-01-01T00:00:00Z","event":{"method":"item/completed","params":{"content":"旧工具结果"}}}\n'; await fs.writeFile(path.join(dir, 'events.jsonl'), legacy);
  const before = await traceDigest(dir); await logger.seal(dir); assert.equal(await traceDigest(dir), before);
  const session = { nativeId: 'native-id', messages: [] };
  assert.equal(await traceHistoryDigest(session, dir), createHash('sha256').update(JSON.stringify([session.nativeId, session.messages, legacy])).digest('hex'));
  const pressure: boolean[] = []; logger.on('pressure', value => pressure.push(value));
  const large = { method: 'item/completed', params: { text: '完整执行结果'.repeat(240000) } };
  await logger.trace(dir, large); await logger.seal(dir); const after = await traceDigest(dir);
  assert.ok(pressure.includes(true)); assert.ok(pressure.includes(false));
  const lines = await Array.fromAsync(traceLines(dir)); assert.equal(lines.length, 2); assert.equal(lines[0] + '\n', legacy); assert.deepEqual(JSON.parse(lines[1]).event, large);
  await logger.close(); const restarted = new LogService(root); await restarted.seal(dir); assert.equal(await traceDigest(dir), after); await restarted.close();
  assert.ok((await traceFiles(dir)).every(file => file.endsWith('.gz')));
});
test('exports whitelist metadata, isolate accounts/projects, include summaries and preserve full traces only when explicitly selected', async t => {
  const root = await temporary(t), logger = new LogService(root), mine = accountLogScope(path.join(root, 'mine')), other = accountLogScope(path.join(root, 'other'));
  try {
    logger.record('workflow', 'result.attach', { ...mine, projectId: 'project-a', origin: 'user' }, { outcome: 'succeeded', durationMs: 15 });
    logger.record('workflow', 'PRIVATE_OTHER_ACCOUNT', { ...other, projectId: 'project-a' });
    logger.record('workflow', 'OTHER_PROJECT', { ...mine, projectId: 'project-b' });
    logger.record('diagnostic', 'failed', { ...mine, centralId: 'fixture-node' }, { level: 'error', detail: 'password=secret', cause: 'ENOSPC token=CAUSE_SECRET' });
    const file = path.join(root, 'workflow.zip'); await exportLogs(logger, file, { kind: 'workflow', projectId: 'project-a', description: 'password=description-secret' }, { account: mine.account });
    const entries = zipContents(await fs.readFile(file)), text = entries.get('workflow.jsonl')!; assert.match(text, /result.attach/); assert.ok(!text.includes('PRIVATE_OTHER_ACCOUNT')); assert.ok(!text.includes('OTHER_PROJECT')); assert.ok(!entries.get('report.json')!.includes('description-secret'));
    const report = JSON.parse(entries.get('report.json')!); assert.equal(report.coverage.emitted, 1); assert.equal(report.summary[0].durationMs, 15); assert.equal(report.traceContainsConversation, false);
    const diagnostics = path.join(root, 'diagnostic.zip'); await exportLogs(logger, diagnostics, { kind: 'diagnostic' }, { account: mine.account });
    const diagnostic = zipContents(await fs.readFile(diagnostics)).get('diagnostic.jsonl')!; assert.match(diagnostic, /ENOSPC/); assert.match(diagnostic, /fixture-node/); assert.ok(!diagnostic.includes('CAUSE_SECRET'));
    const directory = path.join(root, 'sessions', randomUUID()); await logger.trace(directory, { text: 'PRIVATE_TRACE_BODY' });
    const full = path.join(root, 'trace.zip'); await exportLogs(logger, full, { kind: 'trace' }, { traceDirectory: directory }); const traces = zipContents(await fs.readFile(full)); assert.match(traces.get('events.jsonl')!, /PRIVATE_TRACE_BODY/); assert.equal(JSON.parse(traces.get('report.json')!).traceContainsConversation, true);
  } finally { await logger.close(); }
});
test('failed writes retain visible incomplete state without recursive logs and unsafe paths cannot receive traces', async t => {
  const root = await temporary(t), logger = new LogService(root), dir = path.join(root, 'sessions', randomUUID()); await fs.mkdir(dir, { recursive: true }); await fs.mkdir(path.join(dir, 'events.jsonl'));
  try {
    let failures = 0; logger.on('storage-error', () => failures++);
    await assert.rejects(logger.trace(dir, { full: 'never-report-complete' })); await assert.rejects(logger.trace(dir, {}));
    assert.equal(failures, 1); assert.ok((await logger.status([root])).traceError);
    const storage = new LogStorage(root); await assert.rejects(storage.trace(path.join(root, '..', randomUUID()), 'unsafe'), /无效|越界/);
    assert.ok(!redactLogText('https://user:pass@example.test/private?token=secret').includes('pass'));
  } finally { await logger.close(); }
});

test('snapshot boundaries exclude later appends and failed exports never remove an existing destination', async t => {
  const root = await temporary(t), logger = new LogService(root), directory = path.join(root, 'sessions', randomUUID());
  try {
    await logger.trace(directory, { value: 'first' }); const snapshot = await logger.traceSnapshot(directory);
    await logger.trace(directory, { value: 'second' });
    const old = await Array.fromAsync(traceLines(directory, snapshot)); assert.equal(old.length, 1); assert.equal(JSON.parse(old[0]).event.value, 'first');
    const current = await logger.traceSnapshot(directory); assert.equal((await Array.fromAsync(traceLines(directory, current))).length, 2);
    const file = path.join(root, 'existing.zip'); await fs.writeFile(file, 'MUST_KEEP');
    await assert.rejects(exportLogs(logger, file, { kind: 'workflow' })); assert.equal(await fs.readFile(file, 'utf8'), 'MUST_KEEP');
    await exportLogs(logger, file, { kind: 'workflow' }, { replace: true }); assert.ok(zipContents(await fs.readFile(file)).has('report.json'));
  } finally { await logger.close(); }
});

test('partial crash tails are kept separate and incomplete status is explicit', async t => {
  const root = await temporary(t), logger = new LogService(root), directory = path.join(root, 'sessions', randomUUID()); await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(path.join(directory, 'events.jsonl'), '{"partial":'); let incomplete = '';
    logger.on('trace-incomplete', value => { incomplete = value; }); await logger.seal(directory); await logger.trace(directory, { next: 'valid' });
    const lines = await Array.fromAsync(traceLines(directory)); assert.equal(lines.length, 2); assert.equal(lines[0], '{"partial":'); assert.equal(JSON.parse(lines[1]).event.next, 'valid'); assert.equal(incomplete, directory); assert.ok((await logger.status([root])).traceError);
  } finally { await logger.close(); }
});

test('fatal fallback is bounded, sanitized and available before asynchronous flushing', async t => {
  const root = await temporary(t), logger = new LogService(root);
  try {
    logger.emergency(Error('fatal token=DO_NOT_EXPORT ' + '错误'.repeat(10000))); logger.emergency(Error('second fatal'));
    const files = await fs.readdir(path.join(root, 'logs')); assert.equal(files.length, 1);
    const text = await fs.readFile(path.join(root, 'logs', files[0]), 'utf8'); assert.ok(Buffer.byteLength(text) < 8192); assert.ok(!text.includes('DO_NOT_EXPORT')); assert.equal(JSON.parse(text).name, 'app.uncaught_exception');
  } finally { await logger.close(); }
});
