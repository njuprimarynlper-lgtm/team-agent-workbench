import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { accountIdentity } from '../src/shared/account-data';
import { memberProfile } from './fixtures/member-profile';
import { syncedProject } from './fixtures/synced-project';
import { logsFor } from '../src/core/logging';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() >= end) assert.fail('Background synchronization did not reach the expected state'); await delay(5); }
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-auto-sync-'));
  const admin = new LocalAdminConnection(() => {}), clients: Workbench[] = [];
  const make = async (name: string) => { const client = new Workbench(path.join(root, name), () => {}, () => {}); clients.push(client); await client.store.init(); return client; };
  try {
    await fs.mkdir(path.join(root, 'share'));
    await admin.connect({ mode: 'local', localRoot: path.join(root, 'share'), host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
    await admin.operation({ op: 'initialize' });
    for (const label of ['alpha', 'beta', 'gamma', 'private']) await admin.operation({ op: 'group_create', label });
    await admin.operation({ op: 'user_create', username: 'alice', name: 'Alice', password: '123', groups: ['local_alpha', 'local_beta', 'local_gamma'], contentAdminGroups: ['local_alpha', 'local_beta', 'local_gamma'] });
    await admin.operation({ op: 'user_create', username: 'bob', name: 'Bob', password: '123', groups: ['local_private'], contentAdminGroups: ['local_private'] });
    const profile = (name = 'alice') => memberProfile(admin.snapshot.profile!, admin.snapshot.state!, name);
    const owner = await make('owner'); await owner.configureWorkspace(profile(), '123', root, async () => false);
    const projects = [];
    for (const label of ['alpha', 'beta', 'gamma']) projects.push(await syncedProject(owner, label, 'local_' + label));
    const privateOwner = await make('private-owner'); await privateOwner.configureWorkspace(profile('bob'), '123', root, async () => false);
    const privateProject = await syncedProject(privateOwner, 'private', 'local_private');
    const client = await make('client');
    return { root, admin, owner, client, projects, privateProject, profile, async close() {
      await Promise.all(clients.map(client => client.close()));
      await Promise.all(clients.map(client => logsFor(client.store.root).close())); admin.disconnect();
      assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith('project-auto-sync-'));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    } };
  } catch (error) { await Promise.allSettled(clients.map(client => client.close())); admin.disconnect(); throw error; }
}

test('login activates every accessible project without selection and does not wait for a slow shared-content read', async () => {
  const f = await fixture(), blocked = deferred(), started = deferred(), [a, b] = f.projects;
  const read = f.client.remote.contentList.bind(f.client.remote); let calls = 0;
  f.client.remote.contentList = async binding => { if (binding.project.id === b.id) { calls++; started.resolve(); await blocked.promise; } return read(binding); };
  try {
    await f.client.configureWorkspace(f.profile(), '123', '', async () => false);
    assert(f.projects.every(project => f.client.projectConnected(project.id)));
    assert(!f.client.projectConnected(f.privateProject.id));
    await started.promise;
    await until(() => f.client.snapshot().projectConnections![a.id].syncStatus === 'synced');
    assert.equal(f.client.snapshot().projectConnections![b.id].syncStatus, 'syncing');
    const pending = [f.client.syncProjectsInBackground(), f.client.syncProjectsInBackground()];
    blocked.resolve(); await Promise.all(pending);
    assert.equal(calls, 1, 'concurrent refresh requests join the same background pass');
    assert(f.projects.every(project => f.client.snapshot().projectConnections![project.id].syncStatus === 'synced'));
    assert.equal(f.client.store.sessions.length, 0, 'automatic synchronization does not create or send a model session');
  } finally { blocked.resolve(); await f.close(); }
});

test('content and question failures remain project-scoped, visible during retries, and clear only after recovery', async () => {
  const f = await fixture(), [a, b, c] = f.projects;
  const read = f.client.remote.contentList.bind(f.client.remote), questions = f.client.remote.questionRequest.bind(f.client.remote);
  let fail = true, blockRetry = false; const started = deferred(), blocked = deferred();
  f.client.remote.contentList = async binding => {
    if (binding.project.id === a.id) {
      if (fail) throw Object.assign(Error('EACCES: isolated test permission failure'), { code: 'EACCES' });
      if (blockRetry) { started.resolve(); await blocked.promise; }
    }
    return read(binding);
  };
  f.client.remote.questionRequest = (binding, command) => binding.project.id === b.id && fail ? Promise.reject(Error('ECONNRESET: isolated question read')) : questions(binding, command);
  try {
    await f.client.configureWorkspace(f.profile(), '123', '', async () => false); await f.client.syncProjectsInBackground();
    let states = f.client.snapshot().projectConnections!;
    assert.equal(states[a.id].syncStatus, 'unsynced'); assert.equal(states[b.id].syncStatus, 'unsynced'); assert.equal(states[c.id].syncStatus, 'synced');
    assert(states[a.id].failure?.logRef); assert(states[b.id].failure?.logRef);
    assert.doesNotMatch(states[a.id].failure!.message, /EACCES|isolated/);
    assert(f.projects.every(project => states[project.id].connected));
    fail = false; blockRetry = true;
    const retry = f.client.syncProjectsInBackground(); await started.promise;
    assert.equal(f.client.snapshot().projectConnections![a.id].syncStatus, 'unsynced', 'an active retry does not hide the previous failure');
    blocked.resolve(); await retry;
    states = f.client.snapshot().projectConnections!;
    assert(f.projects.every(project => states[project.id].syncStatus === 'synced'));
    assert(f.projects.every(project => !states[project.id].failure));
  } finally { blocked.resolve(); await f.close(); }
});

test('catalog refresh activates new projects, respects a manual pause, and revokes access without removing local conversations', async () => {
  const f = await fixture(), [a, b] = f.projects;
  try {
    await f.client.configureWorkspace(f.profile(), '123', '', async () => false); await f.client.syncProjectsInBackground();
    const session = await f.client.createSession('codex', f.root, b.id), binding = structuredClone(session.binding);
    await f.client.disconnectProject(a.id); await f.client.refreshGroups(); await f.client.syncProjectsInBackground();
    assert.equal(f.client.snapshot().projectConnections![a.id].syncStatus, 'paused');
    await f.admin.operation({ op: 'group_create', label: 'delta' });
    await f.admin.operation({ op: 'group_member', group: 'local_delta', username: 'alice', role: 'admin' });
    await f.owner.refreshGroups(); const added = await syncedProject(f.owner, 'delta', 'local_delta');
    await f.client.refreshGroups(); await f.client.syncProjectsInBackground();
    assert.equal(f.client.snapshot().projectConnections![added.id].syncStatus, 'synced');
    assert.equal(f.client.projectConnected(a.id), false);
    await f.admin.operation({ op: 'group_member', group: 'local_beta', username: 'alice', role: 'remove', handoffs: { local_beta: null } });
    await f.client.refreshGroups();
    assert.equal(f.client.projectConnected(b.id), false); assert.equal(f.client.snapshot().projectConnections![b.id].syncStatus, 'unsynced');
    assert.deepEqual(f.client.session(session.id).binding, binding);
    await assert.rejects(f.client.connectProject(b.id), /没有该项目/);
    await f.client.connectProject(a.id); await f.client.syncProjectsInBackground();
    assert.equal(f.client.snapshot().projectConnections![a.id].syncStatus, 'synced');
  } finally { await f.close(); }
});

test('late reads from a previous login cannot mark the next account unsynced or activate its projects', async () => {
  const f = await fixture(), [a] = f.projects, started = deferred(), blocked = deferred();
  const read = f.client.remote.contentList.bind(f.client.remote);
  try {
    await f.client.configureWorkspace(f.profile(), '123', '', async () => false); await f.client.syncProjectsInBackground();
    f.client.remote.contentList = async binding => { if (binding.project.id === a.id) { started.resolve(); await blocked.promise; throw Error('EACCES: old account read'); } return read(binding); };
    const old = f.client.syncProjectsInBackground(); await started.promise;
    await f.client.configureWorkspace(f.profile('bob'), '123', '', async () => false);
    blocked.resolve(); await old; await f.client.syncProjectsInBackground();
    const states = f.client.snapshot().projectConnections!;
    assert.equal(states[f.privateProject.id].syncStatus, 'synced');
    assert.equal(states[f.privateProject.id].failure, undefined);
    assert(f.projects.every(project => !f.client.projectConnected(project.id)));
    assert(f.projects.every(project => !states[project.id]));
  } finally { blocked.resolve(); await f.close(); }
});

test('automatic activation never overwrites an unreadable account cache or claims synchronization succeeded', async () => {
  const f = await fixture();
  try {
    const profile = f.profile(), cache = path.join(f.client.store.root, 'accounts', createHash('sha256').update(accountIdentity(profile)).digest('hex') + '.json');
    await fs.mkdir(path.dirname(cache), { recursive: true }); await fs.writeFile(cache, '{invalid-cache');
    let writes = 0; const accountData = f.client.remote.accountData.bind(f.client.remote);
    f.client.remote.accountData = async data => { if (data) writes++; return accountData(data); };
    await f.client.configureWorkspace(profile, '123', '', async () => false); await f.client.syncProjectsInBackground();
    assert.equal(f.client.accountSync.state.failure?.code, 'ACCOUNT_SYNC_CACHE_UNREADABLE');
    assert(f.projects.every(project => f.client.snapshot().projectConnections![project.id].syncStatus === 'unsynced'));
    await f.client.refreshGroups(); await f.client.syncProjectsInBackground();
    assert.equal(f.client.accountSync.state.failure?.code, 'ACCOUNT_SYNC_CACHE_UNREADABLE'); assert.equal(writes, 0);
    assert.equal(await fs.readFile(cache, 'utf8'), '{invalid-cache');
  } finally { await f.close(); }
});
