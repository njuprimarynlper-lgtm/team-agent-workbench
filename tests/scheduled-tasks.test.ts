import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ScheduledTasks } from '../src/core/scheduled-tasks';
import { nextScheduledTime, scheduledTaskInputSchema, scheduledLocalInput, scheduledInstant, type ScheduledSchedule } from '../src/shared/scheduled-task';
import type { AgentSession } from '../src/shared/types';

const at = Date.parse('2026-11-10T00:00:00Z');
async function waitFor(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('condition timed out'); }
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-tasks-')), sessions = new Map<string, AgentSession>(), executions: string[] = [];
  let now = at;
  const host = {
    resolve: async (projectId: string) => ({ cwd: root, projectName: projectId, followsDirectory: true }),
    prepare: async (task: any, run: any): Promise<AgentSession> => { const session: AgentSession = { id: run.sessionId, title: task.name, cwd: root, provider: 'codex', purpose: 'work', status: 'running', messages: [], sources: [], approvals: [], autoUpload: false, handoffPath: '', createdAt: new Date(now).toISOString(), scheduledRun: { taskId: task.id, runId: run.id, managed: true } }; sessions.set(session.id, session); return session; },
    execute: async (_task: any, run: any) => { executions.push(run.id); }, session: (id: string) => sessions.get(id),
    unload: async (session: AgentSession) => { sessions.delete(session.id); }, restore: async (session: AgentSession) => { sessions.set(session.id, session); return session; },
    stop: async (id: string) => { const s = sessions.get(id)!; s.stoppedAt = new Date(now).toISOString(); s.status = 'idle'; await service.complete(id); },
    changed: () => {}, notice: () => {},
  };
  const service = new ScheduledTasks(root, host, () => now); await service.init(false);
  const input = (schedule: ScheduledSchedule = { kind: 'hourly', intervalHours: 1, anchor: new Date(at).toISOString(), timezone: 'Asia/Shanghai' }) => scheduledTaskInputSchema.parse({ name: '项目巡检', prompt: '检查项目并返回结果', projectId: 'project-a', schedule });
  return { root, service, host, sessions, executions, input, advance: (ms: number) => { now += ms; }, setNow: (value: number) => { now = value; }, close: async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('all schedule kinds use the saved timezone, not the host timezone', () => {
  const zone = { timezone: 'Asia/Shanghai' };
  assert.equal(nextScheduledTime({ kind: 'daily', time: '09:00', ...zone }, at), '2026-11-10T01:00:00.000Z');
  assert.equal(nextScheduledTime({ kind: 'weekdays', time: '09:00', ...zone }, Date.parse('2026-11-13T02:00Z')), '2026-11-16T01:00:00.000Z');
  assert.equal(nextScheduledTime({ kind: 'weekly', days: [1], time: '09:00', ...zone }, at), '2026-11-16T01:00:00.000Z');
  assert.equal(nextScheduledTime({ kind: 'hourly', intervalHours: 3, anchor: new Date(at).toISOString(), ...zone }, at + 3600000), '2026-11-10T03:00:00.000Z');
  assert.equal(nextScheduledTime({ kind: 'once', at: new Date(at).toISOString(), ...zone }, at), undefined);
  assert.equal(nextScheduledTime({ kind: 'daily', time: '02:30', timezone: 'America/New_York' }, Date.parse('2026-03-08T05:00Z')), '2026-03-09T06:30:00.000Z');
  assert.equal(scheduledLocalInput('2026-11-10T01:00:00Z', 'America/New_York'), '2026-11-09T20:00');
  assert.equal(scheduledInstant('2026-11-09T20:00', 'America/New_York'), '2026-11-10T01:00:00.000Z');
  assert.equal(scheduledInstant('2026-03-08T02:30', 'America/New_York'), undefined);
});

test('requires a real project and rejects empty weekly dates or an invalid timezone', () => {
  const input = { name: '检查', prompt: '检查', projectId: '__personal__', schedule: { kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai' } };
  assert.equal(scheduledTaskInputSchema.safeParse(input).success, false);
  assert.equal(scheduledTaskInputSchema.safeParse({ ...input, projectId: 'p', schedule: { kind: 'weekly', time: '09:00', timezone: 'Invalid/Zone', days: [] } }).success, false);
});

test('waiting for authorization blocks the account queue, task deletion cancels queued work and preserves current work', async () => {
  const f = await fixture();
  try {
    const a = await f.service.saveTask(f.input()), b = await f.service.saveTask({ ...f.input(), name: '待删除任务' });
    const run = await f.service.runNow(a.id); await waitFor(() => f.executions.length === 1);
    f.sessions.get(run.sessionId)!.status = 'approval'; await f.service.tick();
    assert.equal(f.service.runs().items.find(item => item.id === run.id)?.status, 'waiting');
    const queued = await f.service.runNow(b.id); await f.service.remove(b.id); await f.service.tick();
    assert.equal(f.service.runs().items.find(item => item.id === queued.id)?.status, 'stopped'); assert.equal(f.executions.length, 1);
    await f.service.remove(a.id); assert.equal(f.service.runs().items.find(item => item.id === run.id)?.status, 'waiting');
    await f.service.stop(run.id); assert.equal(f.service.runs().items.find(item => item.id === run.id)?.status, 'stopped');
  } finally { await f.close(); }
});

test('serialized execution, deduplication, pause, and stopped runs', async () => {
  const f = await fixture();
  try {
    const a = await f.service.saveTask(f.input()), b = await f.service.saveTask({ ...f.input(), name: '第二任务' });
    const first = await f.service.runNow(a.id); await waitFor(() => f.executions.length === 1);
    await assert.rejects(f.service.runNow(a.id), /已有/);
    const second = await f.service.runNow(b.id); assert.equal(f.executions.length, 1);
    await f.service.pause(a.id, true); assert.equal(f.service.list().find(task => task.id === a.id)?.paused, true);
    await f.service.stop(first.id); assert.equal(f.service.runs().items.find(run => run.id === first.id)?.status, 'stopped');
    await f.service.tick(); await waitFor(() => f.executions.length === 2);
    await assert.rejects(f.service.deleteRuns([second.id]), /先停止/);
    const session = f.sessions.get(second.sessionId)!; session.status = 'idle'; await f.service.complete(session.id);
    assert.equal(f.sessions.size, 0);
  } finally { await f.close(); }
});

test('clock ticks trigger once, skip sleep gaps and never overlap the same task', async () => {
  const f = await fixture();
  try {
    const task = await f.service.saveTask(f.input({ kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai' }));
    // Continuous clock observation until the due slot.
    for (let i = 0; i < 60; i++) { f.advance(60000); await f.service.tick(); }
    await waitFor(() => f.executions.length === 1); await f.service.tick(); assert.equal(f.executions.length, 1);
    const run = f.service.runs().items[0]; assert.equal(run.scheduledAt, '2026-11-10T01:00:00.000Z');
    f.advance(86400000); await f.service.tick(); assert.equal(f.service.runs().total, 1);
    f.sessions.get(run.sessionId)!.status = 'idle'; await f.service.complete(run.sessionId);
    f.advance(86400000); await f.service.tick(); assert.equal(f.service.runs().total, 1);
    assert.equal(f.service.list()[0].nextRunAt, '2026-11-13T01:00:00.000Z');
  } finally { await f.close(); }
});

test('short suspend/resume skips an expired one-time slot instead of firing on wake', async () => {
  const f = await fixture();
  try {
    await f.service.saveTask(f.input({ kind: 'once', at: new Date(at + 3000).toISOString(), timezone: 'Asia/Shanghai' }));
    f.service.suspend(); f.advance(10000); await f.service.tick(); assert.equal(f.service.runs().total, 0);
    await f.service.resumeAfterSleep(); await f.service.tick(); assert.equal(f.service.runs().total, 0); assert.equal(f.service.list()[0].nextRunAt, undefined);
  } finally { await f.close(); }
});

test('archives long sessions in 160-message pages and continues the same conversation only once', async () => {
  const f = await fixture();
  try {
    const task = await f.service.saveTask(f.input()), run = await f.service.runNow(task.id); await waitFor(() => f.executions.length === 1);
    const session = f.sessions.get(run.sessionId)!; session.status = 'idle'; session.nativeId = randomUUID();
    session.messages = Array.from({ length: 501 }, (_, i) => ({ id: 'm-' + i, role: 'user', text: String(i), createdAt: new Date(at).toISOString() }));
    session.messages[0] = { id: 'm-0', role: 'assistant', text: `[输出文件](${path.join(f.root, 'old-report.md')})`, createdAt: new Date(at).toISOString() };
    await f.service.complete(session.id); assert.equal(f.sessions.size, 0);
    const opened = await f.service.open(run.id); assert.equal(opened.session.messages.length, 160); assert.equal(opened.earlierCount, 341);
    assert.equal(opened.session.messages[0].id, 'm-341');
    assert(opened.session.outputFiles?.includes(path.join(f.root, 'old-report.md')));
    const older = await f.service.page(run.id, opened.earlierCount); assert.equal(older.before, 181); assert.equal(older.messages[0].id, 'm-181');
    const restored = await f.service.continueRun(run.id); assert.equal(restored.messages.length, 501); assert.equal(restored.nativeId, session.nativeId); assert.equal(restored.scheduledRun?.managed, false);
    assert.equal((await f.service.continueRun(run.id)).id, restored.id); assert.equal(f.sessions.size, 1);
    await f.service.remove(task.id); assert.equal(f.service.list().length, 0); assert.equal(f.service.runs().total, 1);
    await f.service.deleteRuns([run.id]); assert.equal(f.sessions.size, 1); assert.equal(f.service.runs().total, 0);
  } finally { await f.close(); }
});

test('attachments are frozen per account and missing or changed content prevents execution', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.root, 'reference.md'); await fs.writeFile(file, '项目参考');
    const sources = await f.service.stage([file]);
    const task = await f.service.saveTask({ ...f.input(), sourceIds: sources.map(source => source.id) });
    await fs.writeFile(file, '原文件后续更新不影响已选附件');
    await fs.writeFile(task.sources[0].localPath, '损坏');
    const run = await f.service.runNow(task.id); await waitFor(() => f.service.runs().items[0].status === 'failed');
    assert.equal(f.executions.length, 0); assert.match(f.service.runs().items[0].error!, /附件已变化/);
    await assert.rejects(f.service.open(run.id), /附件已变化/);
    await assert.rejects(f.service.saveTask({ ...f.input(), sourceIds: [randomUUID()] }), /附件已不可用/);
  } finally { await f.close(); }
});

test('account directory lock, interrupted recovery and local-only persistence', async () => {
  const f = await fixture();
  try {
    const duplicate = new ScheduledTasks(f.root, f.host);
    await assert.rejects(duplicate.init(false), /已有定时任务后台/);
    const task = await f.service.saveTask(f.input()), run = await f.service.runNow(task.id); await waitFor(() => f.executions.length === 1);
    await f.service.close();
    const restored = new ScheduledTasks(f.root, f.host, () => at + 2 * 86400000); await restored.init(false);
    try {
      assert.equal(restored.runs().items[0].status, 'interrupted'); assert.equal(restored.list().length, 1);
      await restored.tick(); assert.equal(f.executions.length, 1);
      assert((await restored.open(run.id)).session.error);
      const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-other-'));
      const other = new ScheduledTasks(otherRoot, f.host, () => at);
      try { await other.init(false); assert.equal(other.list().length, 0); assert.equal(other.runs().total, 0); }
      finally { await other.close(); await fs.rm(otherRoot, { recursive: true, force: true }); }
    } finally { await restored.close(); }
  } finally { await f.close(); }
});

test('restart recovers a crash after the terminal receipt but before session unloading', async () => {
  const f = await fixture();
  try {
    const task = await f.service.saveTask(f.input()), run = await f.service.runNow(task.id); await waitFor(() => f.executions.length === 1);
    f.sessions.get(run.sessionId)!.status = 'idle'; await f.service.complete(run.sessionId); await f.service.close();
    const orphan = (await f.service.open(run.id)).session; f.sessions.set(orphan.id, orphan);
    const recovered = new ScheduledTasks(f.root, f.host, () => at); await recovered.init(false);
    try { assert.equal(f.sessions.size, 0); assert.equal(recovered.runs().items[0].status, 'completed'); }
    finally { await recovered.close(); }
  } finally { await f.close(); }
});
