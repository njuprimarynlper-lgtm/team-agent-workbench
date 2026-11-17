import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { AgentRuntime } from '../src/core/agents';
import { logsFor } from '../src/core/logging';
import { scopeAccountSnapshot } from '../src/shared/account-scope';
import type { UserFailure } from '../src/shared/user-failure';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

const microtasks = () => new Promise<void>(resolve => setImmediate(resolve));
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(username = 'alice') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-background-save-'));
  const notices: { message: string; failure?: UserFailure }[] = [];
  const wb = new Workbench(root, () => {}, (message, failure) => notices.push({ message, failure }));
  await wb.store.init(); grantTestWorkspace(wb, root);
  wb.store.settings.workspaceSnapshot!.profile.username = username;
  const session = await wb.createSession('codex', root, offlineProjectId);
  const originalSave = wb.store.save.bind(wb.store), originalDelta = wb.store.saveSessionDeltas.bind(wb.store);
  let uploads = 0, models = 0;
  wb.remote.upload = async () => { uploads++; throw Error('record persistence must not upload'); };
  wb.requireAuth = async () => { models++; throw Error('record persistence must not authenticate or start a model'); };
  return { root, wb, session, notices, originalSave, originalDelta, calls: () => ({ uploads, models }),
    cleanup: async () => { wb.store.save = originalSave; wb.store.saveSessionDeltas = originalDelta; await wb.close(); await logsFor(root).close(); assert(root.startsWith(path.join(os.tmpdir(), 'wb-background-save-'))); await fs.rm(root, { recursive: true, force: true }); } };
}

for (const kind of ['full', 'delta'] as const) test(`background ${kind} plain-English save failure remains in snapshots until a successful full retry`, async t => {
  const f = await fixture(); t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const raw = `isolated ${kind} checkpoint writer unavailable`;
    const error = new Error(raw); let attempts = 0;
    if (kind === 'full') f.wb.store.save = async () => { attempts++; throw error; };
    else f.wb.store.saveSessionDeltas = async () => { attempts++; throw error; };
    const change = () => { if (kind === 'full') f.wb.changed(); else { f.session.messages.push({ id: randomUUID(), role: 'assistant', text: '尚在内存中的新回复', createdAt: new Date().toISOString() }); (f.wb as any).changedMessage(f.session.id); } };
    change(); t.mock.timers.tick(200); await microtasks();
    const first = f.wb.snapshot().localRecordSaveFailure!;
    assert.equal(first.code, 'LOCAL_BACKGROUND_RECORD_SAVE_FAILED'); assert.deepEqual(first.pendingSaves, [kind]); assert(first.logRef);
    assert.match(first.message, /这台电脑还没存好.*记录/); assert.match(first.message, /重试保存记录/); assert.doesNotMatch(first.message, /isolated|unavailable/);
    assert.equal(f.notices.length, 1); assert.equal(f.notices[0].failure?.code, first.code);
    // Closing/dismissing the notice cannot change the independent snapshot flag.
    f.notices.length = 0; assert(f.wb.snapshot().localRecordSaveFailure);
    first.failures[kind]!.message = 'mutated renderer copy'; assert.doesNotMatch(f.wb.snapshot().localRecordSaveFailure!.failures[kind]!.message, /mutated/);
    change(); t.mock.timers.tick(200); await microtasks();
    assert.equal(attempts, 2); assert.equal(f.notices.length, 0, 'the same pending background failure does not repeatedly interrupt work');
    if (kind === 'full') await assert.rejects(f.wb.retryBackgroundRecordSave(), e => (e as any).failure?.code === 'LOCAL_BACKGROUND_RECORD_SAVE_FAILED');
    else { f.wb.store.save = async () => { throw new Error('isolated retry writer unavailable'); }; await assert.rejects(f.wb.retryBackgroundRecordSave()); }
    assert(f.wb.snapshot().localRecordSaveFailure, 'failed explicit retry retains the warning');
    f.wb.store.save = f.originalSave; f.wb.store.saveSessionDeltas = f.originalDelta;
    assert.equal(await f.wb.retryBackgroundRecordSave(), true);
    assert.equal(f.wb.snapshot().localRecordSaveFailure, undefined); assert.deepEqual(f.calls(), { uploads: 0, models: 0 });
    const restored = new Store(f.root); await restored.init(); assert.equal(restored.sessions[0].messages.length, f.session.messages.length);
    const files = await logsFor(f.root).files(); const records = (await Promise.all(files.filter(file => file.category === 'diagnostic').map(async file => (await fs.readFile(file.file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))))).flat();
    assert(records.some(record => record.name === 'session.record.background_save_failed' && record.detail === raw), 'the exact technical error remains in diagnostic logs');
  } finally { t.mock.timers.reset(); await f.cleanup(); }
});

test('successful delta persistence cannot erase a failed full checkpoint or unrelated CLI failure', async t => {
  const f = await fixture(); t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const unrelated: UserFailure = { version: 1, code: 'CLI_CONNECTION_CLOSED', message: '原来的CLI连接已关闭' };
    f.session.failure = unrelated; f.session.error = unrelated.message;
    f.wb.store.save = async () => { throw Error('full checkpoint writer unavailable'); };
    f.wb.changed(); t.mock.timers.tick(200); await microtasks();
    f.wb.store.saveSessionDeltas = async () => { throw Error('delta checkpoint writer unavailable'); };
    (f.wb as any).changedMessage(f.session.id); t.mock.timers.tick(200); await microtasks();
    assert.deepEqual(f.wb.snapshot().localRecordSaveFailure!.pendingSaves.toSorted(), ['delta', 'full']);
    f.wb.store.saveSessionDeltas = f.originalDelta;
    await f.originalDelta(); assert(f.wb.snapshot().localRecordSaveFailure, 'a delta-only success is not a complete checkpoint');
    f.wb.store.save = f.originalSave; await f.wb.store.saveSettings(); assert(f.wb.snapshot().localRecordSaveFailure, 'settings-only persistence cannot clear unsaved session records');
    await f.wb.store.save(); assert.equal(f.wb.snapshot().localRecordSaveFailure, undefined);
    assert.deepEqual(f.session.failure, unrelated); assert.equal(f.session.error, unrelated.message);
  } finally { t.mock.timers.reset(); await f.cleanup(); }
});

test('an earlier full-save completion cannot clear a newer failed delta', async t => {
  const original = Store.prototype.save, entered = gate(), release = gate(); let holdNext = false;
  t.mock.method(Store.prototype, 'save', function (this: Store, ...args: Parameters<Store['save']>) {
    const saved = original.apply(this, args);
    if (!holdNext) return saved;
    holdNext = false; entered.resolve(); return saved.then(() => release.promise);
  });
  const f = await fixture(); t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    holdNext = true; const earlier = f.wb.store.save(); await entered.promise;
    f.wb.store.saveSessionDeltas = async () => { throw Error('newer delta writer unavailable'); };
    (f.wb as any).changedMessage(f.session.id); t.mock.timers.tick(200); await microtasks();
    assert(f.wb.snapshot().localRecordSaveFailure);
    assert.equal(scopeAccountSnapshot({ ...f.wb.snapshot(), accountChanging: true }).localRecordSaveFailure, undefined, 'a window-level account switch also hides old-account save status');
    release.resolve(); await earlier;
    assert.deepEqual(f.wb.snapshot().localRecordSaveFailure!.pendingSaves, ['delta']);
    f.wb.store.saveSessionDeltas = f.originalDelta; await f.wb.retryBackgroundRecordSave();
    assert.equal(f.wb.snapshot().localRecordSaveFailure, undefined);
  } finally { release.resolve(); t.mock.timers.reset(); await f.cleanup(); }
});

test('different account Workbench instances never clear or expose each other\'s failed-save status', async t => {
  const a = await fixture('alice'), b = await fixture('bob'); t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    a.wb.store.save = async () => { throw Error('alice local writer unavailable'); }; a.wb.changed(); t.mock.timers.tick(200); await microtasks();
    assert(a.wb.snapshot().localRecordSaveFailure); assert.equal(b.wb.snapshot().localRecordSaveFailure, undefined);
    await b.wb.store.save(); assert(a.wb.snapshot().localRecordSaveFailure);
    b.wb.store.save = async () => { throw Error('bob local writer unavailable'); }; b.wb.changed(); t.mock.timers.tick(200); await microtasks();
    a.wb.store.save = a.originalSave; await a.wb.retryBackgroundRecordSave();
    assert.equal(a.wb.snapshot().localRecordSaveFailure, undefined); assert(b.wb.snapshot().localRecordSaveFailure);
    assert.deepEqual(a.calls(), { uploads: 0, models: 0 }); assert.deepEqual(b.calls(), { uploads: 0, models: 0 });
  } finally { t.mock.timers.reset(); await a.cleanup(); await b.cleanup(); }
});

test('same-instance account filtering hides old failures; only a real full barrier can clear data from both accounts', async t => {
  const f = await fixture();
  const profileA = structuredClone(f.wb.store.settings.workspaceSnapshot!.profile), profileB = { ...structuredClone(profileA), id: 'other-account', username: 'bob' };
  // A full Store contains both owners; only its renderer snapshot is scoped.
  f.wb.store.settings.workspaceSnapshot!.profile = profileB;
  const b = await f.wb.createSession('codex', f.root, offlineProjectId);
  f.wb.store.settings.workspaceSnapshot!.profile = profileA;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    f.session.messages.push({ id: randomUUID(), role: 'assistant', text: 'Alice未保存的新回复', createdAt: new Date().toISOString() });
    f.wb.store.save = async () => { throw Error('alice checkpoint writer unavailable'); };
    f.wb.changed(); t.mock.timers.tick(200); await microtasks();
    assert(f.wb.snapshot().localRecordSaveFailure);
    (f.wb as any).configuring = true;
    assert.equal(f.wb.snapshot().localRecordSaveFailure, undefined, 'account-changing snapshots never expose an account error');
    f.wb.store.settings.workspaceSnapshot!.profile = profileB; (f.wb as any).configuring = false;
    assert.equal(f.wb.snapshot().localRecordSaveFailure, undefined, 'Alice failure is not shown in Bob snapshot');
    b.messages.push({ id: randomUUID(), role: 'assistant', text: 'Bob新的增量回复', createdAt: new Date().toISOString() });
    (f.wb as any).changedMessage(b.id); t.mock.timers.tick(200); await f.wb.store.saveSessionDeltas();
    await f.wb.store.saveSettings();
    f.wb.store.settings.workspaceSnapshot!.profile = profileA;
    assert(f.wb.snapshot().localRecordSaveFailure, 'Bob delta/settings successes cannot clear Alice unsaved full records');
    f.wb.store.settings.workspaceSnapshot!.profile = profileB; f.wb.store.save = f.originalSave;
    await f.wb.store.save();
    f.wb.store.settings.workspaceSnapshot!.profile = profileA;
    assert.equal(f.wb.snapshot().localRecordSaveFailure, undefined, 'Bob full checkpoint can clear Alice only because it really contains Alice data too');
    const restored = new Store(f.root); await restored.init();
    assert.equal(restored.sessions.find(s => s.id === f.session.id)!.messages.at(-1)?.text, 'Alice未保存的新回复');
    assert.equal(restored.sessions.find(s => s.id === b.id)!.messages.at(-1)?.text, 'Bob新的增量回复');
  } finally { (f.wb as any).configuring = false; t.mock.timers.reset(); await f.cleanup(); }
});

test('actual configureWorkspace cannot switch identity before its old-account full checkpoint succeeds', async t => {
  const f = await fixture(), a = structuredClone(f.wb.store.settings.workspaceSnapshot!.profile), b = { ...structuredClone(a), username: 'bob' };
  let connections = 0; const changingFlags: unknown[] = [];
  f.wb.remote.connect = async () => { connections++; throw Error('must not connect after failed old-account persistence'); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    f.wb.store.save = async () => { throw Error('old account full checkpoint writer unavailable'); };
    f.wb.changed(); t.mock.timers.tick(200); await microtasks();
    assert(f.wb.snapshot().localRecordSaveFailure);
    (f.wb as any).broadcast = () => { if (f.wb.snapshot().accountChanging) changingFlags.push(f.wb.snapshot().localRecordSaveFailure); };
    await assert.rejects(f.wb.configureWorkspace(b, 'isolated-password', '', async () => true), /old account full checkpoint/);
    assert.equal(connections, 0); assert(changingFlags.length); assert(changingFlags.every(value => value === undefined));
    assert.equal(f.wb.store.settings.workspaceSnapshot!.profile.username, 'alice');
    assert(f.wb.snapshot().localRecordSaveFailure, 'the failed switch returns to Alice with her pending record state intact');
    f.wb.store.save = f.originalSave; await f.wb.retryBackgroundRecordSave(); assert.equal(f.wb.snapshot().localRecordSaveFailure, undefined);
  } finally { t.mock.timers.reset(); await f.cleanup(); }
});

for (const viaQuestion of [false, true]) test(`${viaQuestion ? 'automatic question' : 'manual'} accepted steer keeps delivery known while its local record awaits saving`, async () => {
  const f = await fixture(); let sends = 0;
  // Exercise the Workbench's accepted-steer boundary without starting a CLI.
  // Keep the real prototype for the active-turn getter and instanceof checks.
  const runtime = Object.assign(Object.create(AgentRuntime.prototype), { session: f.session, close: async () => {} }) as AgentRuntime;
  try {
    f.session.status = 'running'; (runtime as any).turnActive = true; (runtime as any).turnId = 'active-turn';
    (runtime as any).resolveCapabilities = async () => [];
    runtime.steer = async () => { sends++; f.session.messages.push({ id: randomUUID(), role: 'user', text: '已送达的补充', createdAt: new Date().toISOString(), context: { accepted: true, workRecord: false, nativeId: '', sourceHashes: {} } }); return true; };
    (f.wb as any).runtimes.set(f.session.id, runtime);
    (f.wb as any).availableSessionContext = async () => ({ text: '已送达的补充', sources: [], context: { accepted: false, workRecord: false, nativeId: '', sourceHashes: {} } });
    f.wb.store.save = async () => { throw Error('accepted steer checkpoint writer unavailable'); };
    assert.equal(viaQuestion ? await (f.wb as any).steerQuestion(f.session.id, '补充', '协作追问', 'question-run') : await f.wb.steer(f.session.id, 'active-turn', '补充'), true);
    const failure = f.wb.snapshot().localRecordSaveFailure!;
    assert.equal(failure.code, 'LOCAL_BACKGROUND_RECORD_SAVE_FAILED'); assert.equal(failure.outcome, 'accepted'); assert.deepEqual(failure.pendingSaves, ['steer']); assert.match(failure.message, /补充已发出.*不用再次发送补充/);
    assert.equal(f.session.status, 'running'); assert.equal(f.session.messages.at(-1)?.context?.accepted, true); assert.match(f.notices.at(-1)!.message, /^引导已送达，但本地记录保存失败/);
    await assert.rejects(f.wb.retryBackgroundRecordSave()); assert.equal(f.wb.snapshot().localRecordSaveFailure!.outcome, 'accepted');
    f.wb.store.save = f.originalSave; await f.wb.retryBackgroundRecordSave();
    assert.equal(f.wb.snapshot().localRecordSaveFailure, undefined); assert.equal(sends, 1); assert.deepEqual(f.calls(), { uploads: 0, models: 0 });
    const restored = new Store(f.root); await restored.init(); assert.equal(restored.sessions[0].messages.at(-1)?.context?.accepted, true);
  } finally { (runtime as any).turnActive = false; (f.wb as any).runtimes.delete(f.session.id); await runtime.close(); await f.cleanup(); }
});
