import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { sessionContext } from '../src/core/session-context';
import { checkedSessionFile, listSessionFiles } from '../src/core/session-files';
import { scheduledTaskInputSchema } from '../src/shared/scheduled-task';
import { projectBriefSchema } from '../src/shared/project-brief';
import { projectWorkSessions } from '../src/shared/project-session-scope';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Shared JavaScript CLI fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

test('offline scheduled execution freezes latest project material, isolates supplement and archives outside ordinary sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-workbench-'));
  const wb = new Workbench(root, () => {}, () => {}); await wb.store.init(); grantTestWorkspace(wb, root); await wb.projectSync.init(); await wb.scheduled.init(false);
  const brief = (background: string) => projectBriefSchema.parse({ background, objectives: '完成巡检', acceptance: '返回报告' });
  const observed: { project: string; supplement: string; prompt: string; desktop?: boolean; revision?: number }[] = [];
  wb.send = async (id, text, sourceIds) => {
    const s = wb.session(id), input = sessionContext(s, text, sourceIds || []);
    const source = s.sources.find(source => source.id === s.projectBrief?.sourceId)!;
    observed.push({ project: await fs.readFile(source.localPath, 'utf8'), supplement: await fs.readFile(s.sources.find(source => source.name === '本任务补充资料.md')!.localPath, 'utf8'), prompt: input.text, desktop: s.codexDesktop, revision: s.projectBrief?.revision });
    assert.equal(s.scheduledRun?.managed, true); assert.equal(s.autoUpload, false); assert.equal(input.context.workRecord, false);
    assert.equal(projectWorkSessions(wb.store.sessions, s.binding!.project, [s.binding!.project], false).length, 0);
    const report = path.join(root, 'report.md'); await fs.writeFile(report, '检查报告');
    s.messages.push({ id: randomUUID(), role: 'assistant', phase: 'final_answer', text: `本轮检查完成 [报告](${report})`, createdAt: new Date().toISOString() });
    s.status = 'idle'; await wb.scheduled.complete(id); return true;
  };
  const wait = async (count: number) => { for (let i = 0; i < 200; i++) { if (wb.scheduled.runs().items.filter(run => run.status === 'completed').length === count && !wb.store.sessions.some(session => session.scheduledRun?.managed)) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('scheduled workbench completion timeout'); };
  try {
    const first = await wb.projectSync.save(offlineProjectId, brief('第一版项目背景'), 0);
    const task = await wb.scheduled.saveTask(scheduledTaskInputSchema.parse({ projectId: offlineProjectId, name: '巡检', prompt: '检查当前项目', supplement: '任务私有说明', schedule: { kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai' } }));
    const a = await wb.scheduled.runNow(task.id); await wait(1);
    await wb.projectSync.save(offlineProjectId, brief('第二版项目背景'), first.revision);
    const b = await wb.scheduled.runNow(task.id); await wait(2);
    assert.notEqual(a.sessionId, b.sessionId); assert.equal(wb.store.sessions.length, 0); assert.equal(wb.remote.connected, false);
    assert.match(observed[0].project, /第一版项目背景/); assert.match(observed[1].project, /第二版项目背景/);
    assert.equal(observed[0].supplement, '任务私有说明'); assert.equal(observed[1].supplement, '任务私有说明');
    assert(observed.every(run => !run.desktop && !run.prompt.includes('项目个人会话日志')));
    assert(!JSON.stringify(await wb.projectSync.read(offlineProjectId)).includes('任务私有说明'));
    assert.match((await wb.scheduled.open(a.id)).run.summary!, /检查完成/);
    const archivedFiles = await wb.sessionForFiles(a.sessionId);
    assert((await listSessionFiles(archivedFiles)).some(file => file.path === path.join(root, 'report.md')));
    assert.equal((await checkedSessionFile(archivedFiles, path.join(root, 'report.md'))).target, path.join(root, 'report.md'));
    const session = await wb.scheduled.continueRun(a.id); assert.equal(wb.session(session.id).scheduledRun?.managed, false);
    assert.equal(projectWorkSessions(wb.store.sessions, session.binding!.project, [session.binding!.project], false).length, 1);
    assert.equal((await wb.scheduled.continueRun(a.id)).id, session.id);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('scheduled run uses the real private runtime completion path and can resume the original native thread', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-runtime-'));
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success' });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {}); await wb.store.init(); grantTestWorkspace(wb, root); await wb.projectSync.init(); await wb.scheduled.init(false);
  wb.store.settings.providerPaths.codex = fixture.launcher; wb.store.settings.codexRequestGuard = false;
  try {
    const task = await wb.scheduled.saveTask(scheduledTaskInputSchema.parse({ projectId: offlineProjectId, name: '真实执行路径', prompt: '简单检查', schedule: { kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai' } }));
    const run = await wb.scheduled.runNow(task.id);
    for (let i = 0; i < 500; i++) { if (wb.scheduled.runs().items[0]?.status === 'completed' && !wb.store.sessions.length) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(wb.scheduled.runs().items[0].status, 'completed'); assert.equal(wb.store.sessions.length, 0);
    const archived = await wb.scheduled.open(run.id); assert(archived.session.nativeId); assert.equal(archived.session.codexDesktop, undefined);
    const continued = await wb.scheduled.continueRun(run.id); assert.equal(continued.nativeId, archived.session.nativeId);
    await wb.send(continued.id, '继续检查');
    for (let i = 0; i < 300; i++) { if (!['starting', 'running', 'approval'].includes(continued.status)) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(continued.status, 'idle'); assert.equal(continued.nativeId, archived.session.nativeId);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
