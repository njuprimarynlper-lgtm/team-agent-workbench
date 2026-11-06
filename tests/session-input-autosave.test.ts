import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store';
import { SessionInputDrafts } from '../src/renderer/session-input-drafts';
import { submitOptimisticInput } from '../src/renderer/composer-input';
import type { SessionInput, WorkbenchAPI } from '../src/shared/types';

const input = (text: string): SessionInput => ({ text, sourceIds: ['reference'], answers: { question: 'answer' }, capabilities: [{ id: 'skill', name: '复核', kind: 'skill' }] });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('input subscribers are session/account scoped and synchronous; late save failures cannot replace later edits', async () => {
  const a = new SessionInputDrafts(), b = new SessionInputDrafts();
  let current = 0, other = 0, account = 0, reject!: (error: Error) => void;
  a.subscribe('session', () => current++); a.subscribe('other', () => other++); b.subscribe('session', () => account++);
  const first = input('中文输入'); a.write('session', first, () => new Promise<void>((_, fail) => { reject = fail; }));
  assert.equal(a.read('session'), first); assert.equal(current, 1); assert.equal(other, 0); assert.equal(account, 0);
  const latest = input('中文输入完成'); a.write('session', latest, async () => {});
  reject(Error('旧写入失败')); await tick();
  assert.equal(a.read('session'), latest); assert.equal(a.error('session'), ''); assert.equal(b.read('session').text, '');
  a.write('session', latest, async () => { throw Error('磁盘不可用'); }); await tick();
  assert.match(a.error('session'), /磁盘不可用/); assert.equal(a.read('session'), latest);
  await a.flush('session', async () => {}); assert.equal(a.error('session'), '');
});

test('isolated composers preserve optimistic failure recovery and never overwrite a newer draft', async () => {
  for (const edited of [false, true]) {
    const drafts = new SessionInputDrafts(), sent = input('待发送'), newer = input('下一轮草稿');
    const write = (value: SessionInput) => drafts.write('session', value, async () => {});
    let fail!: (error: Error) => void; write(sent);
    const api = { call: () => new Promise((_, reject) => { fail = reject; }) } as unknown as WorkbenchAPI;
    const pending = submitOptimisticInput(api, 'session', sent, () => drafts.read('session'), write);
    assert.equal(drafts.read('session').text, ''); if (edited) write(newer);
    fail(Error('发送失败')); await assert.rejects(pending, /发送失败/);
    assert.deepEqual(drafts.read('session'), edited ? newer : sent);
  }
});

test('a burst of keystrokes shares one 300ms durable save and keeps references/capabilities', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-input-burst-')), store = new Store(root);
  try {
    await store.init(); let writes = 0; const rename = fs.rename.bind(fs);
    t.mock.method(fs, 'rename', async (from: string, to: string) => { if (path.basename(to) === 'inputs.json') writes++; return rename(from, to); });
    const pending: Promise<void>[] = [];
    for (let i = 1; i <= 12; i++) { store.inputs.session = input('中文'.repeat(i)); pending.push(store.saveInputs()); }
    assert.equal(writes, 0); assert(pending.every(value => value === pending[0]));
    await Promise.all(pending); assert.equal(writes, 1);
    const restored = new Store(root); await restored.init(); assert.deepEqual(restored.inputs.session, input('中文'.repeat(12)));
  } finally { t.mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }); }
});

test('switch/send/shutdown barriers flush immediately and a pending old draft cannot resurrect cleared text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-input-flush-')), store = new Store(root);
  try {
    await store.init(); store.inputs.session = input('发送前'); const before = store.saveInputs();
    await store.flushInputs(); await before;
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'inputs.json'), 'utf8')).session.text, '发送前');
    store.inputs.session = input(''); const cleared = store.saveInputs(); await store.save(); await cleared;
    await new Promise(resolve => setTimeout(resolve, 350));
    const restored = new Store(root); await restored.init(); assert.equal(restored.inputs.session.text, '');
    store.inputs.session = input('关闭前最后一次编辑'); const closing = store.saveInputs(); await store.save(); await closing;
    const reopened = new Store(root); await reopened.init(); assert.equal(reopened.inputs.session.text, '关闭前最后一次编辑');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('flush waits for a write already in flight and later edits remain last on the shared store queue', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-input-order-')), store = new Store(root);
  let release!: () => void;
  try {
    await store.init(); const rename = fs.rename.bind(fs), gate = new Promise<void>(resolve => { release = resolve; }); let entered = false;
    t.mock.method(fs, 'rename', async (from: string, to: string) => { if (!entered && path.basename(to) === 'inputs.json') { entered = true; await gate; } return rename(from, to); });
    store.inputs.session = input('旧稿'); const saved = store.saveInputs(), first = store.flushInputs();
    while (!entered) await tick(); let finished = false;
    const barrier = store.flushInputs().then(() => { finished = true; }); await tick(); assert.equal(finished, false);
    store.inputs.session = input('最新稿'); const newest = store.saveInputs(), last = store.flushInputs();
    release(); await Promise.all([saved, first, barrier, newest, last]);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'inputs.json'), 'utf8')).session.text, '最新稿');
  } finally { release?.(); t.mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }); }
});

test('failed input save preserves the old file and latest in-memory text; an explicit flush can retry', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-input-retry-')), store = new Store(root);
  try {
    await store.init(); store.inputs.session = input('原稿'); await store.saveInputs();
    const mock = t.mock.method(fs, 'rename', async () => { throw Error('磁盘故障'); });
    store.inputs.session = input('不应丢失的新稿'); const pending = assert.rejects(store.saveInputs(), /磁盘故障/);
    await assert.rejects(store.flushInputs(), /磁盘故障/); await pending;
    assert.equal(store.inputs.session.text, '不应丢失的新稿'); assert.equal(JSON.parse(await fs.readFile(path.join(root, 'inputs.json'), 'utf8')).session.text, '原稿');
    mock.mock.restore(); await store.flushInputs();
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'inputs.json'), 'utf8')).session.text, '不应丢失的新稿');
  } finally { t.mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }); }
});
