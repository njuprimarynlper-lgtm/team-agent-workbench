import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, atomicJson } from '../src/core/store';
import type { AgentSession } from '../src/shared/types';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wb-store-integrity-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert(path.basename(root).startsWith('wb-store-integrity-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const store = new Store(root); await store.init();
  return store;
}
const session = (): AgentSession => ({ id: randomUUID(), title: '原有工作', provider: 'codex', purpose: 'work', status: 'idle', createdAt: new Date().toISOString(), cwd: '', handoffPath: '', messages: [], sources: [], approvals: [], autoUpload: false });
const files = ['settings', 'sessions', 'inputs', 'transfers', 'drafts', 'conclusions', 'activity-assistant'];
async function bytes(store: Store) { return Promise.all(files.map(name => fs.readFile(path.join(store.root, name + '.json'), 'utf8'))); }

test('unexpected empty memory is blocked before any account file changes and keeps a recoverable index with origin', async t => {
  const store = await fixture(t), original = session(); store.sessions.push(original);
  store.inputs[original.id] = { text: '未发送内容', sourceIds: [], answers: {} };
  await store.save(); const before = await bytes(store);
  let notifications = 0; store.saved = () => { notifications++; };
  store.sessions = []; store.inputs = {}; store.settings.lastWorkspace = 'must-not-save';
  await assert.rejects(store.save(), /已拦截未声明的会话移除/);
  assert.deepEqual(await bytes(store), before); assert.equal(notifications, 0);
  const snapshots = await fs.readdir(path.join(store.root, 'recovery'));
  assert.equal(snapshots.length, 1);
  const snapshot = JSON.parse(await fs.readFile(path.join(store.root, 'recovery', snapshots[0]), 'utf8'));
  assert.deepEqual(snapshot.previousSessions, [original]); assert.deepEqual(snapshot.unexpectedIds, [original.id]);
  assert.deepEqual(snapshot.incomingIds, []); assert.match(snapshot.source, /store-session-integrity/);
  // A rejected write must not poison the queue; restoring the index permits saving.
  store.sessions = [original]; await store.save(); assert.equal(notifications, 1);
});

test('an old Store cannot erase sessions added by a newer instance', async t => {
  const store = await fixture(t), original = session(); store.sessions = [original]; await store.save();
  const stale = new Store(store.root); await stale.init();
  const added = session(); store.sessions.push(added); await store.save();
  const before = await bytes(store); stale.settings.lastWorkspace = 'stale';
  await assert.rejects(stale.save(), /未声明/); assert.deepEqual(await bytes(store), before);
});

test('concurrent Stores serialize the index check and write for the same directory', async t => {
  const first = await fixture(t), second = new Store(first.root); await second.init();
  const a = session(), b = session(); first.sessions = [a]; second.sessions = [b];
  const results = await Promise.allSettled([first.save(), second.save()]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  const disk = JSON.parse(await fs.readFile(path.join(first.root, 'sessions.json'), 'utf8'));
  assert.deepEqual(disk.map((item: AgentSession) => item.id), [a.id]);
});

test('only explicitly listed removals are allowed and authorization does not leak to later saves', async t => {
  const store = await fixture(t), a = session(), b = session(); store.sessions = [a, b]; await store.save();
  const before = await bytes(store); store.sessions = [];
  await assert.rejects(store.save({ removedSessionIds: [a.id], source: 'test:delete-one' }), /未声明/);
  assert.deepEqual(await bytes(store), before);
  store.sessions = [b]; await store.save({ removedSessionIds: [a.id], source: 'test:delete-one' });
  store.sessions = []; await assert.rejects(store.save(), /未声明/);
  await store.save({ removedSessionIds: [b.id], source: 'test:delete-last' });
  const reopened = new Store(store.root); await reopened.init(); assert.deepEqual(reopened.sessions, []);
});

test('removal authorization is captured when enqueued and cannot be broadened while awaiting I/O', async t => {
  const store = await fixture(t), a = session(), b = session(); store.sessions = [a, b]; await store.save();
  const ids = [a.id]; store.sessions = [];
  const saving = store.save({ removedSessionIds: ids, source: 'test:delete-one' }); ids.push(b.id);
  await assert.rejects(saving, /未声明/);
});

test('account stores remain independent when another account has a blocked save', async t => {
  const a = await fixture(t), b = new Store(path.join(a.root, 'another-account')); await b.init();
  const first = session(), second = session(); a.sessions = [first]; b.sessions = [second];
  await Promise.all([a.save(), b.save()]); const before = await bytes(a);
  a.sessions = []; b.sessions = [];
  const results = await Promise.allSettled([a.save(), b.save({ removedSessionIds: [second.id], source: 'test:other-account' })]);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled');
  assert.deepEqual(await bytes(a), before);
});

test('streamed changes write a small overlay and recover without rewriting the full history', async t => {
  const store = await fixture(t), active = session();
  active.messages = Array.from({ length: 1200 }, (_, index) => ({ id: randomUUID(), role: 'tool', text: `history-${index}:` + 'x'.repeat(1000), createdAt: active.createdAt }));
  store.sessions = [active]; await store.save();
  const indexFile = path.join(store.root, 'sessions.json'), before = await fs.readFile(indexFile, 'utf8');
  active.messages.push({ id: randomUUID(), role: 'assistant', text: '输出第一段', createdAt: active.createdAt });
  const latest = active.messages.at(-1)!;
  store.recordSessionDelta(active.id, latest.id); await store.saveSessionDeltas();
  latest.text += '，第二段'; store.recordSessionDelta(active.id, latest.id); await store.saveSessionDeltas();
  assert.equal(await fs.readFile(indexFile, 'utf8'), before);
  const deltaFile = path.join(store.sessionDir(active.id), 'delta.json');
  assert((await fs.stat(deltaFile)).size < Buffer.byteLength(before) / 10);
  const recovered = new Store(store.root); await recovered.init();
  assert.equal(recovered.sessions[0].messages.at(-1)?.text, '输出第一段，第二段');
  assert.equal(recovered.sessions[0].messages.length, 1201);
  await store.save();
  await assert.rejects(fs.stat(deltaFile), { code: 'ENOENT' });
  const checkpoint = new Store(store.root); await checkpoint.init();
  assert.equal(checkpoint.sessions[0].messages.at(-1)?.text, latest.text);
});

test('routine session saves update the overlay and a new session still gets an index entry', async t => {
  const store = await fixture(t), active = session();
  active.messages.push({ id: randomUUID(), role: 'assistant', text: '原始内容', createdAt: active.createdAt });
  store.sessions = [active]; await store.save();
  const indexFile = path.join(store.root, 'sessions.json'), before = await fs.readFile(indexFile, 'utf8');
  active.title = '增量标题'; active.messages[0].text = '增量内容';
  store.recordSessionDelta(active.id, active.messages[0].id);
  await store.saveSession(active.id);
  assert.equal(await fs.readFile(indexFile, 'utf8'), before);
  let reopened = new Store(store.root); await reopened.init();
  assert.equal(reopened.sessions[0].title, '增量标题');
  assert.equal(reopened.sessions[0].messages[0].text, '增量内容');
  const added = session(); store.sessions.push(added); await store.saveSession(added.id);
  reopened = new Store(store.root); await reopened.init();
  assert.deepEqual(reopened.sessions.map(item => item.id), [active.id, added.id]);
});

test('restarting with an overlay keeps earlier uncheckpointed messages in later overlays', async t => {
  const store = await fixture(t), active = session();
  store.sessions = [active]; await store.save();
  const first = { id: randomUUID(), role: 'assistant' as const, text: '第一轮', createdAt: active.createdAt };
  active.messages.push(first); store.recordSessionDelta(active.id, first.id); await store.saveSessionDeltas();
  const resumed = new Store(store.root); await resumed.init();
  const second = { id: randomUUID(), role: 'assistant' as const, text: '第二轮', createdAt: active.createdAt };
  resumed.sessions[0].messages.push(second); resumed.recordSessionDelta(active.id, second.id); await resumed.saveSessionDeltas();
  const reopened = new Store(store.root); await reopened.init();
  assert.deepEqual(reopened.sessions[0].messages.map(message => message.text), ['第一轮', '第二轮']);
});

test('a delta queued after a checkpoint preserves later output', async t => {
  const store = await fixture(t), active = session();
  active.messages.push({ id: randomUUID(), role: 'assistant', text: '原文', createdAt: active.createdAt });
  store.sessions = [active]; await store.save();
  const checkpoint = store.save();
  active.messages[0].text = '后续输出'; store.recordSessionDelta(active.id, active.messages[0].id);
  await Promise.all([checkpoint, store.saveSessionDeltas()]);
  const reopened = new Store(store.root); await reopened.init();
  assert.equal(reopened.sessions[0].messages[0].text, '后续输出');
});

test('a stale Store cannot erase another instance’s newer message overlay', async t => {
  const store = await fixture(t), active = session();
  active.messages.push({ id: randomUUID(), role: 'assistant', text: '原文', createdAt: active.createdAt });
  store.sessions = [active]; await store.save();
  const stale = new Store(store.root); await stale.init();
  active.messages[0].text = '新输出'; store.recordSessionDelta(active.id, active.messages[0].id);
  await store.saveSessionDeltas();
  await assert.rejects(stale.save(), /过期会话覆盖/);
  const reopened = new Store(store.root); await reopened.init();
  assert.equal(reopened.sessions[0].messages[0].text, '新输出');
});

test('legacy session identifiers remain compatible with full checkpoints', async t => {
  const store = await fixture(t), legacy = { ...session(), id: 'legacy-helper' };
  store.sessions = [legacy]; await store.save();
  assert.equal(store.recordSessionDelta(legacy.id), false);
  const reopened = new Store(store.root); await reopened.init();
  assert.equal(reopened.sessions[0].id, legacy.id);
});

test('a migrated account missing its index refuses both initialization and ordinary save', async t => {
  const store = await fixture(t); store.sessions = [session()]; await store.save();
  await atomicJson(path.join(store.root, 'migration.json'), { version: 2, owner: 'account' });
  await fs.unlink(path.join(store.root, 'sessions.json'));
  const settings = await fs.readFile(path.join(store.root, 'settings.json'), 'utf8');
  const reopened = new Store(store.root);
  await assert.rejects(reopened.init(), /索引.*缺失/);
  await assert.rejects(reopened.save(), /索引.*缺失/);
  assert.equal(await fs.readFile(path.join(store.root, 'settings.json'), 'utf8'), settings);
  await assert.rejects(fs.stat(path.join(store.root, 'sessions.json')), { code: 'ENOENT' });
});

test('a loaded index disappearing from disk is not silently recreated even without migration metadata', async t => {
  const store = await fixture(t); store.sessions = [session()]; await store.save();
  await fs.unlink(path.join(store.root, 'sessions.json'));
  await assert.rejects(store.save(), /索引.*缺失/);
});

for (const invalid of ['{broken', '{}', '[{"id":"same"},{"id":"same"}]']) test('invalid disk index is preserved before any overwrite: ' + invalid, async t => {
  const store = await fixture(t); store.sessions = [session()]; await store.save();
  await fs.writeFile(path.join(store.root, 'sessions.json'), invalid); const before = await bytes(store);
  await assert.rejects(store.save(), /sessions.json 无法读取/);
  await assert.rejects(new Store(store.root).init(), /sessions.json 无法读取/);
  assert.deepEqual(await bytes(store), before);
});

test('new accounts and intentionally empty migrated accounts can still save', async t => {
  const store = await fixture(t); await store.save();
  await atomicJson(path.join(store.root, 'migration.json'), { version: 2, owner: 'account' });
  const reopened = new Store(store.root); await reopened.init(); await reopened.save();
  assert.deepEqual(reopened.sessions, []);
});
