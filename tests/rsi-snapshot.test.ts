import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RsiDailySnapshot, rsiSnapshotName } from '../src/core/rsi-snapshot';
import { RsiEngine } from '../src/core/rsi';
import type { AgentSession } from '../src/shared/types';

const day = (value: string) => new Date(value + 'T12:00:00');

test('AI recommendation snapshot rolls daily into one file and keeps the prior valid copy when source is damaged', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsi-snapshot-'));
  const source = path.join(root, 'rsi-v2.json'), snapshot = path.join(root, rsiSnapshotName);
  const write = (n: number) => fs.writeFile(source, JSON.stringify({ version: 3, projects: { p: { n } } }));
  const snapshots = new RsiDailySnapshot(root);
  try {
    await write(1);
    await snapshots.captureIfDue(day('2026-11-04'));
    await write(2);
    await snapshots.captureIfDue(day('2026-11-04'));
    assert.equal(JSON.parse(await fs.readFile(snapshot, 'utf8')).projects.p.n, 1);

    await snapshots.captureIfDue(day('2026-11-05'));
    assert.equal(JSON.parse(await fs.readFile(snapshot, 'utf8')).projects.p.n, 2);
    await fs.writeFile(source, Buffer.alloc(128));
    await assert.rejects(snapshots.captureIfDue(day('2026-11-06')), /JSON/);
    assert.equal(JSON.parse(await fs.readFile(snapshot, 'utf8')).projects.p.n, 2);
    assert.deepEqual((await fs.readdir(root)).filter(name => name.includes('snapshot')), [rsiSnapshotName]);

    await write(3);
    await snapshots.captureIfDue(day('2026-11-06'));
    assert.equal(JSON.parse(await fs.readFile(snapshot, 'utf8')).projects.p.n, 3);
  } finally { await snapshots.settled(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a structurally damaged source cannot replace the prior valid snapshot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsi-snapshot-shape-'));
  const source = path.join(root, 'rsi-v2.json'), snapshot = path.join(root, rsiSnapshotName);
  const snapshots = new RsiDailySnapshot(root, value => {
    const saved = value as { version?: number; projects?: Record<string, { config?: object }> };
    if (saved.version !== 3 || !saved.projects?.p?.config) throw new Error('invalid project');
  });
  try {
    await fs.writeFile(source, JSON.stringify({ version: 3, projects: { p: { config: {} } } }));
    await snapshots.captureIfDue(day('2026-11-04'));
    await fs.writeFile(source, JSON.stringify({ version: 3, projects: { p: {} } }));
    await assert.rejects(snapshots.captureIfDue(day('2026-11-05')), /invalid project/);
    assert.deepEqual(JSON.parse(await fs.readFile(snapshot, 'utf8')).projects.p, { config: {} });
  } finally { await snapshots.settled(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a damaged RSI file automatically recovers from the valid snapshot and preserves the damaged original', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsi-snapshot-retry-'));
  const session = { id: 's1', provider: 'codex', model: 'test', purpose: 'work', status: 'idle', messages: [], sources: [], approvals: [], createdAt: '', cwd: root, title: 'test', autoUpload: false, handoffPath: '' } as AgentSession;
  const notices: string[] = [];
  const host = { scope: (projectId: string) => ({ key: 'alice:' + projectId, account: 'alice', user: 'alice', projectId }), session: () => session, collect: async () => [], changed() {}, notice: (message: string) => notices.push(message) };
  const create = () => new RsiEngine(root, host, async () => { throw new Error('model should not run'); });
  const first = create();
  try {
    await first.configure('p1', { enabled: true });
    assert.equal((await fs.readdir(root)).filter(name => name === rsiSnapshotName).length, 1);
    await first.close();
    await fs.writeFile(path.join(root, 'rsi-v2.json'), Buffer.alloc(128));
    const reopened = create();
    try {
      const view = await reopened.view('p1');
      assert.equal(view.config.enabled, true);
      assert(view.recovery?.snapshotAt);
      assert.match(notices[0], /自动恢复/);
      assert.equal(JSON.parse(await fs.readFile(path.join(root, 'rsi-v2.json'), 'utf8')).version, 3);
      const archive = view.recovery.archivePath!;
      assert.equal((await fs.stat(archive)).size, 128);
      assert.deepEqual(await fs.readFile(archive), Buffer.alloc(128));
      assert.equal((await reopened.inbox('p1')).recovery?.snapshotAt, view.recovery.snapshotAt);
      assert.equal(notices.length, 1);
    } finally { await reopened.close(); }
  } finally { await first.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('an invalid snapshot cannot replace a damaged source, while a valid source is never rolled back', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsi-snapshot-safety-'));
  const source = path.join(root, 'rsi-v2.json'), snapshot = path.join(root, rsiSnapshotName);
  const session = { id: 's1', provider: 'codex', model: 'test', purpose: 'work', status: 'idle', messages: [], sources: [], approvals: [], createdAt: '', cwd: root, title: 'test', autoUpload: false, handoffPath: '' } as AgentSession;
  const host = { scope: (projectId: string) => ({ key: 'alice:' + projectId, account: 'alice', user: 'alice', projectId }), session: () => session, collect: async () => [], changed() {} };
  const create = () => new RsiEngine(root, host, async () => { throw new Error('model should not run'); });
  const first = create();
  try {
    await first.configure('p1', { enabled: true });
    await first.configureShadow('p1', { enabled: false });
    await first.close();
    const healthy = create();
    try { assert.equal((await healthy.view('p1')).config.enabled, false); assert.equal((await healthy.view('p1')).recovery, undefined); }
    finally { await healthy.close(); }

    const validSnapshot = await fs.readFile(snapshot);
    await fs.writeFile(source, Buffer.alloc(64));
    await fs.writeFile(snapshot, Buffer.alloc(64));
    const damaged = create();
    try {
      await assert.rejects(damaged.view('p1'), /每日快照未能自动恢复/);
      assert.deepEqual(await fs.readFile(source), Buffer.alloc(64));
      await fs.writeFile(snapshot, validSnapshot);
      assert.equal((await damaged.view('p1')).config.enabled, true);
    } finally { await damaged.close(); }

    await fs.writeFile(source, JSON.stringify({ version: 4, projects: {} }));
    const newer = create();
    try {
      await assert.rejects(newer.view('p1'), /版本不兼容/);
      assert.equal(JSON.parse(await fs.readFile(source, 'utf8')).version, 4);
    } finally { await newer.close(); }
  } finally { await first.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a missing main RSI file is restored from its snapshot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsi-snapshot-missing-'));
  const session = { id: 's1', provider: 'codex', model: 'test', purpose: 'work', status: 'idle', messages: [], sources: [], approvals: [], createdAt: '', cwd: root, title: 'test', autoUpload: false, handoffPath: '' } as AgentSession;
  const host = { scope: (projectId: string) => ({ key: 'alice:' + projectId, account: 'alice', user: 'alice', projectId }), session: () => session, collect: async () => [], changed() {} };
  const create = () => new RsiEngine(root, host, async () => { throw new Error('model should not run'); });
  const first = create();
  try {
    await first.configure('p1', { enabled: true });
    await first.close();
    await fs.rm(path.join(root, 'rsi-v2.json'));
    const reopened = create();
    try {
      const view = await reopened.view('p1');
      assert.equal(view.config.enabled, true);
      assert(view.recovery?.snapshotAt);
      assert.equal(view.recovery.archivePath, undefined);
      assert.equal(JSON.parse(await fs.readFile(path.join(root, 'rsi-v2.json'), 'utf8')).version, 3);
    } finally { await reopened.close(); }
  } finally { await first.close(); await fs.rm(root, { recursive: true, force: true }); }
});
