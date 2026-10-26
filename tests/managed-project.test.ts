import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from './fixtures/member-profile';
import type { TeamGroup } from '../src/shared/team-groups';
import { readRegistry } from '../src/core/local-space';

test('creating a central project creates its member scope once, survives lost responses, and enforces project permissions', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-project-'))), share = path.join(root, 'share');
  await fs.mkdir(share);
  const admin = new LocalAdminConnection(() => {});
  const alice = new Workbench(path.join(root, 'alice'), () => {}, () => {}), bob = new Workbench(path.join(root, 'bob'), () => {}, () => {});
  const personal = new Workbench(path.join(root, 'personal'), () => {}, () => {}, undefined, () => ({}), undefined, undefined, undefined, true);
  try {
    await personal.store.init(); await personal.restoreLocalWorkspace();
    await assert.rejects(personal.createProject('禁止本机创建'), /连接中央节点/);
    assert.equal(personal.projectSync.projects().length, 1, 'only the unassigned workspace remains');
    await admin.connect({ mode: 'local', localRoot: share, host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
    await admin.operation({ op: 'initialize' });
    for (const name of ['alice', 'bob']) await admin.operation({ op: 'user_create', username: name, name, password: '123' });
    for (const [name, client] of [['alice', alice], ['bob', bob]] as const) {
      await client.store.init(); await client.configureWorkspace(memberProfile(admin.snapshot.profile!, admin.snapshot.state!, name), '123', root, async () => false);
    }
    assert.equal(alice.remote.workspaces.length, 0);
    const requestId = 'project_' + 'a'.repeat(32);
    const project = await alice.createManagedProject('算法实验', undefined, requestId);
    assert.equal(project.name, '算法实验'); assert.equal(project.groupLabel, project.name);
    assert.equal(project.id, requestId); assert(alice.projectConnected(project.id));
    assert.equal(alice.projectSync.states()[project.id].pending, false);
    assert.equal(alice.remote.workspaces.length, 1); assert.equal(alice.remote.profile!.projects.length, 1);
    assert.equal((await alice.createManagedProject('算法实验', undefined, requestId)).id, project.id);
    const scope = await alice.groupCommand({ action: 'details', group: project.groupName! }) as TeamGroup;
    assert.equal(scope.creator, 'alice'); assert.equal(scope.projects.length, 1);
    await bob.refreshGroups(); assert.equal(bob.remote.profile!.projects.length, 0);
    await assert.rejects(bob.groupCommand({ action: 'details', group: scope.id }), /没有.*权限/);
    await alice.groupCommand({ action: 'member', group: scope.id, revision: scope.revision, username: 'bob', role: 'member' });
    await bob.refreshGroups(); await bob.connectProject(project.id);
    const bobScope = await bob.groupCommand({ action: 'details', group: scope.id }) as TeamGroup;
    assert.equal(bobScope.role, 'member');
    await assert.rejects(bob.groupCommand({ action: 'delete', group: scope.id, revision: bobScope.revision }), /创建者/);
    await assert.rejects(bob.createManagedProject('算法实验', undefined, requestId), /原身份/);
    // Lose the response after the permission scope exists; retry must recover it.
    const groupCall = alice.remote.groupCommand.bind(alice.remote); let loseGroup = true;
    alice.remote.groupCommand = async command => { const result = await groupCall(command); if (command.action === 'create' && loseGroup) { loseGroup = false; throw new Error('group response lost'); } return result; };
    const groupRetryId = 'project_' + 'b'.repeat(32);
    await assert.rejects(alice.createManagedProject('响应重试', undefined, groupRetryId), /group response lost/);
    const second = await alice.createManagedProject('响应重试', undefined, groupRetryId);
    assert.equal(second.id, groupRetryId);
    // Lose the response after the shared project exists; no local phantom or duplicate.
    const createCall = alice.remote.createProject.bind(alice.remote); let loseProject = true;
    alice.remote.createProject = async (...args) => { const result = await createCall(...args); if (loseProject) { loseProject = false; throw new Error('project response lost'); } return result; };
    const projectRetryId = 'project_' + 'c'.repeat(32);
    await assert.rejects(alice.createManagedProject('创建重试', undefined, projectRetryId), /project response lost/);
    assert.equal(alice.projectSync.states()[projectRetryId], undefined);
    const third = await alice.createManagedProject('创建重试', undefined, projectRetryId);
    assert.equal(third.id, projectRetryId);
    const registry = await readRegistry(share); assert.equal(Object.keys(registry.state.groups).length, 3);
    assert.equal(alice.remote.profile!.projects.length, 3);
    alice.remote.disconnect();
    await assert.rejects(alice.createManagedProject('断网创建'), /连接中央节点/);
    assert.equal(Object.keys((await readRegistry(share)).state.groups).length, 3);
  } finally {
    admin.disconnect(); await Promise.all([alice.close(), bob.close(), personal.close()]);
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir())); assert(path.basename(root).startsWith('managed-project-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
