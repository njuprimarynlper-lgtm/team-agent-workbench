import test from 'node:test';
import assert from 'node:assert/strict';
import { accountIdentity } from '../src/shared/account-data';
import { conclusionUploadState, uploadBlocked, uploadFilesKey } from '../src/shared/conclusion-upload';
import { linkConclusionPublications } from '../src/core/conclusion-publications';
import type { ProjectConclusion, Transfer } from '../src/shared/types';

const profile = { host: 'server', port: 22, username: 'bob', fingerprint: 'SHA256:test' };
const personal: ProjectConclusion = { id: 'personal', projectId: 'project', accountOwner: accountIdentity(profile), title: '探索记录', content: '验证结果', category: 'exploration', version: 2, updatedAt: '2026-10-08', sources: [] };
const transfer: Transfer = {
  id: 'transfer', kind: 'upload', status: 'error', name: 'result.md', localPath: 'result.md', target: '/project/results/report.md', projectName: '优化项目', createdAt: '2026-10-08', bytes: 0, total: 100, sha256: 'a'.repeat(64),
  binding: { ...profile, connectionId: 'server', project: { id: 'project', name: '优化项目', groupName: 'team', remoteRoot: '/project', uploadPath: '/project/results', historyPath: '/project/trajectories' } },
  metadata: { kind: 'contribution', category: 'exploration', title: personal.title, description: personal.content, submission: { version: 1, submittedBy: 'bob', submittedAt: '2026-10-08', destination: { projectId: 'project', projectName: '优化项目', groupName: 'team' }, sources: [{ kind: 'personal_result', id: personal.id, version: personal.version }] } },
};

test('upload states match exact personal version, account, project and attachments; done outranks failed attempts', () => {
  assert.deepEqual(conclusionUploadState(personal), { status: 'ready' });
  for (const status of ['queued', 'running', 'done', 'error'] as const) {
    const state = conclusionUploadState(personal, [{ ...transfer, status }]);
    assert.equal(state.status, status); assert.equal(uploadBlocked(state), status !== 'error');
  }
  assert.equal(conclusionUploadState(personal, [transfer, { ...transfer, id: 'successful', status: 'done' }]).status, 'done');
  const variants = [
    { ...transfer, binding: { ...transfer.binding, username: 'alice' } },
    { ...transfer, binding: { ...transfer.binding, project: { ...transfer.binding.project, id: 'other' } } },
    { ...transfer, attachment: true },
    { ...transfer, metadata: { ...transfer.metadata!, kind: 'file' as const } },
    { ...transfer, metadata: { ...transfer.metadata!, submission: { ...transfer.metadata!.submission!, sources: [{ kind: 'personal_result' as const, id: personal.id, version: 1 }] } } },
    { ...transfer, metadata: { ...transfer.metadata!, submission: { ...transfer.metadata!.submission!, sources: [{ kind: 'personal_result' as const, id: 'same-title-different-result', version: 2 }] } } },
    { ...transfer, metadata: { ...transfer.metadata!, submission: { ...transfer.metadata!.submission!, sources: [{ kind: 'personal_result' as const, id: personal.id, version: 2 }, { kind: 'personal_result' as const, id: 'another', version: 1 }] } } },
  ];
  for (const other of variants) assert.equal(conclusionUploadState(personal, [other]).status, 'ready');
  const file = { id: 'file', name: '样本.csv', sha256: 'b'.repeat(64), size: 4, localPath: 'C:/samples.csv' };
  assert.equal(conclusionUploadState({ ...personal, localFiles: [file] }, [transfer]).status, 'ready');
  const uploaded = { ...transfer, status: 'done' as const, metadata: { ...transfer.metadata!, attachments: [{ name: file.name, sha256: file.sha256, size: file.size, path: '/project/files/samples.csv' }] } };
  assert.equal(conclusionUploadState({ ...personal, localFiles: [{ ...file, localPath: 'D:/another-machine/samples.csv' }] }, [uploaded]).status, 'done');
  assert.equal(uploadFilesKey([file, { ...file, name: 'b.csv' }]), uploadFilesKey([{ ...file, name: 'b.csv' }, file]));
});

test('completed publication persists without transfer history, while edits and added files remain uploadable', () => {
  const item = structuredClone(personal), completed = { ...transfer, status: 'done' as const };
  assert.equal(linkConclusionPublications([item], [], [completed]), true);
  assert.equal(linkConclusionPublications([item], [], [completed]), false);
  assert.equal(conclusionUploadState(JSON.parse(JSON.stringify(item))).status, 'done');
  assert.equal(conclusionUploadState(item, [transfer]).status, 'error', 'a receipt followed by a local save failure must still allow retry of the original task');
  assert.equal(conclusionUploadState(item, [{ ...transfer, status: 'running' }]).status, 'running');
  assert.equal(conclusionUploadState(item, [{ ...transfer, target: '/different-failed-attempt.md' }]).status, 'done', 'a different failed attempt must not replace a known successful publication');
  assert.equal(conclusionUploadState({ ...item, titleAlias: '自己看的别名' }).status, 'done');
  assert.equal(conclusionUploadState({ ...item, version: item.version + 1 }).status, 'ready');
  assert.equal(conclusionUploadState({ ...item, localFiles: [{ id: 'file', name: '新增文件', sha256: 'b'.repeat(64), size: 1, localPath: 'new.txt' }] }).status, 'ready');
  const later = { ...item, version: 3 };
  linkConclusionPublications([later], [], [completed]);
  assert.equal(conclusionUploadState(later).status, 'ready', 'old upload cannot mark a later edited version as public');
  for (const other of [{ ...completed, status: 'error' as const }, { ...completed, binding: { ...completed.binding, username: 'alice' } }]) {
    const untouched = structuredClone(personal);
    assert.equal(linkConclusionPublications([untouched], [], [other]), false);
    assert.equal(untouched.publication, undefined);
  }
});

test('a saved session result follows its original upload, including pending work and failed retries', () => {
  const item = { ...personal, sources: [{ id: 'artifact', kind: 'session' as const, title: '本地整理', content: personal.content, updatedAt: personal.updatedAt }] };
  const task = { ...transfer, conclusionSourceId: 'artifact', metadata: { ...transfer.metadata!, submission: { ...transfer.metadata!.submission!, sources: [{ kind: 'session' as const, id: 'session' }] } } };
  for (const status of ['queued', 'running', 'done', 'error'] as const) assert.equal(conclusionUploadState(item, [{ ...task, status }]).status, status);
  for (const changed of [{ ...item, title: '另一个正式标题' }, { ...item, content: '新的内容' }, { ...item, category: 'project_material' as const }]) assert.equal(conclusionUploadState(changed, [task]).status, 'ready');
  assert.equal(conclusionUploadState({ ...item, titleAlias: '本地别名' }, [task]).status, 'error');
  const todo = { ...item, category: 'todo' as const, resultStatus: 'pending' as const };
  const legacyTodo = { ...task, metadata: { ...task.metadata!, category: 'todo' as const, resultStatus: undefined } };
  assert.equal(conclusionUploadState(todo, [legacyTodo]).status, 'error', 'legacy missing default status still represents the same todo');
  assert.equal(conclusionUploadState({ ...todo, resultStatus: 'completed' }, [legacyTodo]).status, 'ready');
  const file = { id: 'file', name: '样本.csv', sha256: 'b'.repeat(64), size: 4, localPath: 'C:/samples.csv' };
  const legacyCopy = { ...item, localFiles: [file], sources: [{ ...item.sources[0], publication: { path: task.target, sha256: task.sha256!, revision: 1 } }] };
  const withFiles = { ...task, status: 'done' as const, metadata: { ...task.metadata!, attachments: [{ name: file.name, sha256: file.sha256, size: file.size, path: '/project/files/sample.csv' }] } };
  assert.equal(linkConclusionPublications([legacyCopy], [], [withFiles]), true);
  assert.equal(linkConclusionPublications([legacyCopy], [], [withFiles]), false);
  assert.equal(conclusionUploadState(legacyCopy).status, 'done', 'legacy links with attachments are backfilled before transferring account records to another computer');
});
