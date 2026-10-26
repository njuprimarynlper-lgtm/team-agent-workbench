import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Workbench } from '../src/core/workbench';
import { assertPersonalRelay, isNativeSessionRecordAction } from '../src/core/personal-relay';
import { backgroundTextTask } from '../src/core/background-text';
// @ts-expect-error Shared protocol fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

test('personal ownership and relay authentication are independent axes', () => {
  for (const account of [undefined, 'alice', 'bob']) {
    assert.doesNotThrow(() => assertPersonalRelay('direct', true, account, { relayAccount: 'alice' }));
    assert.doesNotThrow(() => assertPersonalRelay('management', false, account, { relayAccount: 'alice' }));
  }
  assert.throws(() => assertPersonalRelay('management', true, undefined), /连接中央节点/);
  assert.throws(() => assertPersonalRelay('management', true, 'bob', { relayAccount: 'alice' }), /原来使用的中央账号/);
  assert.doesNotThrow(() => assertPersonalRelay('management', true, 'alice', { relayAccount: 'alice' }));
});

test('native record operations are separated from model execution and desktop attachment', () => {
  for (const action of ['session.native.list', 'session.native.link', 'session.native.linkMany', 'session.native.refresh']) {
    assert.equal(isNativeSessionRecordAction(action), true, action);
  }
  // Do not turn the exception into a prefix rule: future native execution must
  // still pass the existing relay check, as must sends and desktop operations.
  for (const action of ['session.native.send', 'session.send', 'session.retry', 'session.create', 'session.codexDesktop.sync', 'session.desktopSync.restore', 'provider.auth', 'provider.catalog', 'draft.prepare', 'rsi.run']) {
    assert.equal(isNativeSessionRecordAction(action), false, action);
  }
});

test('disconnected model relay does not block native listing, single/batch import or history refresh', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-offline-relay-'));
  const previousHome = process.env.CODEX_HOME;
  const home = path.join(root, 'codex'), workspace = path.join(root, 'workspace');
  let executionChecks = 0;
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {}, undefined, (route, session) => {
    executionChecks++;
    assertPersonalRelay(route, true, undefined, session);
    return {};
  }, undefined, undefined, undefined, true);
  try {
    process.env.CODEX_HOME = home;
    await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const message = (id: string, text: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', completed_at_ms: 1700000000000, item: { type: 'UserMessage', id, content: [{ type: 'text', text }] } } }) + '\n';
    const files = ids.map(id => path.join(home, 'sessions', `rollout-2026-10-26T00-00-00-${id}.jsonl`));
    for (const [index, file] of files.entries()) await fs.writeFile(file, message('u1', `离线历史 ${index + 1}`));
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    try {
      db.exec('CREATE TABLE thread_sections (id TEXT, name TEXT); CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, project_id TEXT, thread_section_id TEXT, archived INTEGER, recency_at_ms INTEGER, model TEXT)');
      const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const [index, id] of ids.entries()) insert.run(id, `离线会话 ${index + 1}`, '', '', workspace, null, null, 0, index + 1, null);
    } finally { db.close(); }
    await wb.store.init(); await wb.restoreLocalWorkspace();
    const egress = { enabled: true, viaSharedServer: true, host: 'relay.invalid', port: 443, certificateFingerprint: '' };
    wb.store.settings.egress = { ...egress };
    assert.equal(wb.remote.connected, false);
    const catalog = await wb.listNativeSessions('codex');
    assert.equal(catalog.sessions.length, 3);
    const first = await wb.linkNativeSession('codex', ids[0], '__personal__');
    const batch = await wb.linkNativeSessions('codex', ids.slice(1), '__personal__');
    for (const [index, session] of [first, ...batch].entries()) {
      assert.equal(session.messages[0].text, `离线历史 ${index + 1}`);
      assert.equal(session.networkRoute, 'management', 'import must not silently switch model routing');
      assert.equal(session.relayAccount, undefined, 'reading records must not bind a relay identity');
      assert.equal(session.codexDesktop, undefined, 'import does not bypass desktop sync restrictions');
      assert.equal(await fs.readFile(files[index], 'utf8'), message('u1', `离线历史 ${index + 1}`));
    }
    await fs.appendFile(files[0], message('u2', '原生客户端后续消息'));
    await wb.refreshNativeTranscript(first.id);
    assert.equal(first.messages.at(-1)?.text, '原生客户端后续消息');
    assert.deepEqual(wb.store.settings.egress, egress);
    assert.equal(executionChecks, 0, 'record operations must never request a model environment');
    await assert.rejects(wb.linkNativeSession('codex', ids[0], '__personal__'), /不能重复导入/);
    const before = structuredClone(first.messages);
    await assert.rejects(wb.send(first.id, '未连接时不能发送'), /请先连接中央节点/);
    assert.equal(executionChecks, 1);
    assert.deepEqual(first.messages, before);
    await assert.rejects(wb.syncCodexDesktop(first.id), /当前使用管理端访问，暂不支持桌面同步/);
  } finally {
    await wb.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('cached runtimes, preparation helpers and background summaries keep the original relay identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-relay-'));
  const cli = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success' });
  let account: string | undefined = 'alice';
  const env = (route: any, session?: any) => { assertPersonalRelay(route, true, account, session); return {}; };
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {}, undefined, env, undefined, undefined, undefined, true);
  try {
    await wb.store.init(); await wb.restoreLocalWorkspace();
    wb.store.settings.providerPaths.codex = cli.launcher;
    wb.store.settings.egress = { enabled: true, viaSharedServer: true, host: 'test', port: 443, certificateFingerprint: '' };
    const session = await wb.createSession('codex', root, undefined, 'work', undefined, undefined, 'inherit', false, 'management');
    session.relayAccount = 'alice';
    // Keep the automatic summarizer out of this targeted runtime test.
    await wb.activity.pause();
    await wb.send(session.id, 'first');
    for (let i = 0; session.status !== 'idle' && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(session.status, 'idle'); const count = session.messages.length;
    account = 'bob'; await assert.rejects(wb.send(session.id, 'must not send'), /原来使用的中央账号/);
    account = undefined; await assert.rejects(wb.send(session.id, 'must not send'), /连接中央节点/);
    assert.equal(session.messages.length, count);
    const helper = await wb.createSession('codex', root, undefined, 'prepare', session.id);
    assert.equal(helper.relayAccount, 'alice');
    account = 'bob';
    const summarize = backgroundTextTask(root, () => cli.launcher, s => env(s.networkRoute, s));
    await assert.rejects(summarize(session, 'summarize', new AbortController().signal), /原来使用的中央账号/);
    await wb.changeNetworkRoute(session.id, 'direct'); assert.equal(session.relayAccount, undefined);
    await wb.send(session.id, 'direct still works');
    await assert.rejects(wb.archive(session.id), /先将会话迁移/);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
