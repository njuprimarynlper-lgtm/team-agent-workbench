import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertRemote, childRemote, safeFilename, withinRemote } from '../src/core/paths';
import { manifestSchema, profileSchema } from '../src/core/config';
import { freezeFile, packageDraft, hashFile } from '../src/core/artifacts';
import { Store } from '../src/core/store';
import { sameEndpoint } from '../src/core/sftp';
import type { ConnectionProfile, Draft, RemoteBinding } from '../src/shared/types';
const project = { id: 'alpha', name: 'Alpha', remoteRoot: '/projects/alpha', uploadPath: '/projects/alpha/inbox', historyPath: '/projects/alpha/history' };
test('remote boundaries reject traversal and prefix collisions', () => {
  assert.equal(withinRemote('/projects/alpha', '/projects/alpha2/file'), false);
  for (const value of ['/projects/alpha/../ocr/file', '/projects/alpha/..', '/projects/alpha\\..\\ocr', '/projects/alpha/\x00secret']) assert.throws(() => assertRemote(project.remoteRoot, value));
  assert.equal(assertRemote(project.remoteRoot, '/projects/alpha/sub/file'), '/projects/alpha/sub/file');
  assert.throws(() => childRemote('/projects/alpha', '../outside'));
  assert.equal(safeFilename('CON.txt'), 'file_CON.txt');
});
test('manifest cannot place upload or history outside project', () => {
  assert.throws(() => manifestSchema.parse({ version: 1, projects: [{ ...project, historyPath: '/projects/ocr' }] }));
  assert.throws(() => manifestSchema.parse({ version: 1, projects: [project, project] }));
  assert.equal(manifestSchema.parse({ version: 1, projects: [project] }).projects.length, 1);
});
test('queued work is bound to endpoint, identity and server fingerprint', () => {
  const profile: ConnectionProfile = { id: 'server', name: 'test', host: 'localhost', port: 22, username: 'alice', fingerprint: 'SHA256:one', manifestPath: '', projects: [project] };
  const binding: RemoteBinding = { connectionId: profile.id, host: profile.host, port: profile.port, username: profile.username, fingerprint: profile.fingerprint, project };
  assert(sameEndpoint(binding, profile));
  for (const change of [{ username: 'bob' }, { host: 'other' }, { port: 23 }, { fingerprint: 'SHA256:two' }, { id: 'different' }]) assert.equal(sameEndpoint(binding, { ...profile, ...change }), false);
  const parsed = profileSchema.parse({ ...profile, password: 'should-not-persist' });
  assert.equal('password' in parsed, false);
});
test('selected files are frozen, changed snapshots are rejected, and archives are reproducible inputs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-artifact-'));
  try {
    const file = path.join(root, 'source.txt'); await fs.writeFile(file, 'version A');
    const frozen = await freezeFile(file, path.join(root, 'inputs'));
    await fs.writeFile(file, 'version B'); assert.equal(await fs.readFile(frozen.localPath, 'utf8'), 'version A');
    const draft: Draft = { id: randomUUID(), sessionId: randomUUID(), title: '提交', body: '# Result\nVersion A', files: [frozen], inputDir: path.join(root, 'inputs'), outputPath: path.join(root, 'draft.md'), createdAt: new Date().toISOString() };
    const archive = await packageDraft(draft, root); const archiveHash = await hashFile(archive);
    await fs.writeFile(frozen.localPath, 'tampered');
    await assert.rejects(() => packageDraft(draft, root), /快照已改变/);
    assert.equal(await hashFile(archive), archiveHash);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('restart marks unfinished uploads retryable and does not auto resume', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-store-'));
  try {
    const store = new Store(root); await store.init();
    store.transfers = [{ id: randomUUID(), status: 'running' } as any];
    await Promise.all([store.save(), store.save()]);
    const restored = new Store(root); await restored.init();
    assert.equal(restored.transfers[0].status, 'error');
    assert.match(restored.transfers[0].error!, /重试/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
