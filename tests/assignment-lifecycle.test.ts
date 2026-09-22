import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assignmentInScope, assignmentStatusSchema, transitionAssignment, type AssignmentStatus, type AssignmentStatusChange, type ProjectAssignment } from '../src/shared/assignments';
import { AssignmentLifecycle } from '../src/renderer/assignment-lifecycle';
import { SftpConnection } from '../src/core/sftp';
import type { RemoteBinding } from '../src/shared/types';

const base: ProjectAssignment = { id: randomUUID(), projectId: 'p', title: '验证方案是否值得继续', description: '比较两种方案并给出有依据的判断', acceptance: '依据可核实', assignee: 'bob', assigneeName: 'Bob', createdBy: 'alice', createdAt: '2026-09-22', updatedAt: '2026-09-22', revision: 1, status: 'assigned', references: [] };
const summary = { summary: '已比较，候选不优于基线，不建议继续。', references: [], uploadIds: [] };

test('new lifecycle protocol never falls back to an old worker that would bypass review', async () => {
  const remote = new SftpConnection(), requests: any[] = [], binding = { project: { id: 'p' } } as RemoteBinding;
  (remote as any).request = async (request: unknown) => { requests.push(request); throw new Error('不支持的任务操作'); };
  await assert.rejects(remote.assignmentStatus(binding, { id: base.id, revision: 1, status: 'completed' }), /更新服务端功能/);
  assert.equal(requests.length, 1); assert.equal(requests[0].op, 'assignment_lifecycle'); assert.equal(requests[0].projectId, 'p');
});

test('transition matrix requires human review, live roles, terminal-only deletion and explicit restoration', () => {
  const matrix: Record<string, Partial<Record<AssignmentStatus, string[]>>> = {
    assignee: { assigned: ['in_progress'], in_progress: ['in_progress', 'pending_review'] },
    admin: { assigned: ['cancelled'], in_progress: ['cancelled'], pending_review: ['in_progress', 'completed', 'cancelled'], completed: ['deleted'], cancelled: ['deleted'] },
    self: { assigned: ['in_progress', 'cancelled'], in_progress: ['in_progress', 'pending_review', 'completed', 'cancelled'], pending_review: ['in_progress', 'completed', 'cancelled'], completed: ['deleted'], cancelled: ['deleted'] },
    unrelated: {}
  };
  for (const role of Object.keys(matrix)) for (const status of ['assigned', 'in_progress', 'pending_review', 'completed', 'cancelled'] as const) for (const action of ['in_progress', 'pending_review', 'completed', 'cancelled', 'deleted', 'restored', 'purged'] as const) {
    const task = { ...base, status, ...(role === 'self' ? { assignee: 'alice' } : {}) };
    const actor = { username: role === 'assignee' ? 'bob' : role === 'unrelated' ? 'carol' : 'alice', admin: ['admin', 'self'].includes(role) };
    const change: AssignmentStatusChange = { id: task.id, revision: 1, status: action, reason: '有明确原因', ...(action === 'pending_review' || action === 'completed' && status === 'in_progress' ? { submission: summary } : {}) };
    const operation = () => transitionAssignment(task, change, actor, 'now');
    if (matrix[role][status]?.includes(action)) assert.doesNotThrow(operation, `${role}/${status}/${action}`);
    else assert.throws(operation, `${role}/${status}/${action}`);
    assert.equal(task.revision, 1, 'validation never mutates the input');
  }
  const admin = { username: 'alice', admin: true }, done = { ...base, status: 'completed' as const };
  const deleted = transitionAssignment(done, { id: done.id, revision: 1, status: 'deleted' }, admin, 'deleted');
  assert(!assignmentInScope(deleted, 'active')); assert(!assignmentInScope(deleted, 'all')); assert(assignmentInScope(deleted, 'deleted'));
  assert.throws(() => transitionAssignment(deleted, { id: done.id, revision: 2, status: 'restored' }, { username: 'bob', admin: false }, 'x'), /组管理员/);
  const restored = transitionAssignment(deleted, { id: done.id, revision: 2, status: 'restored' }, admin, 'restored');
  assert.equal(restored.status, 'completed'); assert(!restored.deletedAt); assert(assignmentInScope(restored, 'all'));
  const purged = transitionAssignment(deleted, { id: done.id, revision: 2, status: 'purged' }, admin, 'purged');
  assert(purged.purgedAt); assert.equal(purged.title, ''); assert.deepEqual(purged.history, []);
  assert.throws(() => transitionAssignment(purged, { id: done.id, revision: 3, status: 'restored' }, admin, 'x'), /不存在/);
});

test('completion needs a result, rejection/cancellation need reasons, stale actions cannot overwrite, and review belongs in pending work', () => {
  const self = { ...base, status: 'in_progress' as const, assignee: 'alice' }, admin = { username: 'alice', admin: true };
  assert.throws(() => transitionAssignment(self, { id: self.id, revision: 1, status: 'completed' }, admin, 'x'), /状态/);
  assert.throws(() => transitionAssignment(self, { id: self.id, revision: 1, status: 'cancelled' }, admin, 'x'), /原因/);
  const pending = { ...base, status: 'pending_review' as const };
  assert(assignmentInScope(pending, 'active'));
  assert.throws(() => transitionAssignment(pending, { id: pending.id, revision: 1, status: 'in_progress' }, admin, 'x'), /原因/);
  const rejected = transitionAssignment(pending, { id: pending.id, revision: 1, status: 'in_progress', reason: '还缺失败样本' }, admin, 'x');
  assert.equal(rejected.history?.at(-1)?.action, 'rejected'); assert.equal(rejected.history?.at(-1)?.note, '还缺失败样本');
  assert.throws(() => transitionAssignment(rejected, { id: pending.id, revision: 1, status: 'cancelled', reason: '撤回' }, admin, 'x'), /已更新/);
  assert.throws(() => transitionAssignment(pending, { id: pending.id, revision: 1, status: 'completed', submission: summary }, admin, 'x'), /不能修改/);
  for (const value of ['', '   ', 'a'.repeat(6001)]) assert(!assignmentStatusSchema.safeParse({ id: base.id, revision: 1, status: 'pending_review', submission: { summary: value } }).success);
});

test('task UI offers only relevant actions and renders frozen review evidence without launching a browser', () => {
  const render = (task: ProjectAssignment, admin: boolean, username: string) => renderToStaticMarkup(createElement(AssignmentLifecycle, { task, admin, username, projectId: 'p', refresh: async () => {}, start: () => {}, hasSession: false, download: async () => {} }));
  const active = render({ ...base, status: 'in_progress' }, false, 'bob'); assert(active.includes('提交验收')); assert(!active.includes('确认完成')); assert(!active.includes('取消任务')); assert(!active.includes('删除任务'));
  const self = render({ ...base, assignee: 'alice', status: 'in_progress' }, true, 'alice'); assert(self.includes('确认完成'));
  const pending = render({ ...base, status: 'pending_review', submissions: [{ ...summary, files: [], submittedBy: 'bob', submittedAt: '2026-09-22' }] }, true, 'alice');
  for (const caption of ['验收通过', '退回继续工作', '候选不优于基线', '验收结果']) assert(pending.includes(caption));
  assert(!pending.includes('删除任务'));
  const done = render({ ...base, status: 'completed' }, true, 'alice'); assert(done.includes('删除任务')); assert(!done.includes('提交验收'));
  const deleted = render({ ...base, status: 'completed', deletedAt: 'now', deletedBy: 'alice' }, true, 'alice');
  assert(deleted.includes('恢复任务')); assert(deleted.includes('彻底删除')); assert(!deleted.includes('开始工作'));
});
