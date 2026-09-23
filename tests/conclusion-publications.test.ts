import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { linkConclusionPublications } from '../src/core/conclusion-publications';
import { teamResultDifference } from '../src/shared/team-result-difference';
import { accountIdentity } from '../src/shared/account-data';
import type { Draft, ProjectConclusion, Transfer } from '../src/shared/types';
import type { SharedContent } from '../src/shared/content';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

async function fixture(run: (wb: Workbench, personal: ProjectConclusion, team: SharedContent, transfer: Transfer, draft: Draft) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'publication-link-')), wb = new Workbench(root, () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const profile = wb.store.settings.workspaceSnapshot!.profile;
    const binding = { connectionId: profile.id, host: profile.host, port: profile.port, username: profile.username, fingerprint: profile.fingerprint, project: profile.projects[0] };
    wb.remote.binding = () => binding;
    const now = new Date().toISOString(), draftId = randomUUID(), sourceId = draftId + '-2';
    const personal: ProjectConclusion = { id: randomUUID(), accountOwner: accountIdentity(profile), projectId: offlineProjectId, title: '【项目标准】 提交必须按NVFP4到HiF4的六接口执行', content: '同一份标准正文。', category: 'project_standard', automatic: true, version: 1, updatedAt: now, sources: [{ id: sourceId, kind: 'session', title: '本地整理', content: '同一份标准正文。', updatedAt: now }] };
    const team: SharedContent = { id: randomUUID(), title: personal.title, description: personal.content, category: personal.category, kind: 'contribution', revision: 1, path: binding.project.uploadPath + '/unique-result.zip', sha256: 'a'.repeat(64), size: 42, state: 'submitted', author: profile.username, updatedBy: profile.username, createdAt: now, updatedAt: now };
    const transfer: Transfer = { id: randomUUID(), kind: 'upload', status: 'done', sha256: team.sha256, name: 'result.zip', target: team.path, projectName: binding.project.name, bytes: 42, total: 42, createdAt: now, localPath: path.join(root, 'result.zip'), binding, metadata: { title: team.title, description: team.description, category: team.category, kind: team.kind } };
    const draft = { id: draftId, sessionId: randomUUID(), binding, files: [], artifacts: [{ id: sourceId, submitted: transfer.id }] } as unknown as Draft;
    wb.store.conclusions = [personal]; wb.store.transfers = [transfer]; wb.store.drafts = [draft];
    wb.remote.contentList = async () => [team];
    await run(wb, personal, team, transfer, draft);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
}

test('legacy session preparation and upload link the same result despite different local and team IDs', async () => fixture(async (wb, personal, team, transfer, draft) => {
  assert.equal(teamResultDifference(team, [personal]), 'missing');
  assert.equal(linkConclusionPublications([personal], [draft], [transfer]), true);
  assert.equal(teamResultDifference(team, [personal]), undefined);
  assert.equal(linkConclusionPublications([personal], [draft], [transfer]), false, 'linking is idempotent');
  assert.equal((await wb.importContentConclusion(offlineProjectId, team.id, 1)).action, 'duplicate');
  assert.equal(wb.conclusions(offlineProjectId).length, 1);
  assert.equal(wb.conclusions(offlineProjectId)[0].id, personal.id);
  const before = structuredClone(personal);
  (wb as any).organizeConclusion(offlineProjectId, personal.title, personal.content, { ...personal.sources[0], publication: undefined }, personal.category);
  assert.deepEqual(JSON.parse(JSON.stringify(personal)), before, 'reorganizing does not erase the link or add a spurious version');
  // Restored account records keep the publication even without local drafts or transfers.
  const records = (wb.accountSync as any).collect(wb.store.settings.workspaceSnapshot!.profile);
  assert.equal(teamResultDifference(team, [records['material:' + personal.id]]), undefined);
}));

test('startup backfills old uploads, including one-result drafts, without changing text or creating copies', async () => fixture(async (wb, personal, team, transfer, draft) => {
  delete draft.artifacts; draft.submitted = transfer.id; personal.sources[0].id = draft.id;
  await wb.store.save();
  const restored = new Store(wb.store.root); await restored.init();
  assert.equal(restored.conclusions.length, 1); assert.equal(teamResultDifference(team, restored.conclusions), undefined);
  assert.equal(restored.conclusions[0].content, personal.content);
  assert.equal(restored.conclusions[0].version, personal.version);
  await restored.save();
  const again = new Store(wb.store.root); await again.init(); assert.equal(teamResultDifference(team, again.conclusions), undefined);
}));

test('publication links respect deletion, history, team revisions, body edits and independent origins', async () => fixture(async (wb, personal, team, transfer, draft) => {
  linkConclusionPublications([personal], [draft], [transfer]);
  personal.archived = true; assert.equal(teamResultDifference(team, [personal]), undefined);
  personal.deletedAt = new Date().toISOString(); assert.equal(teamResultDifference(team, [personal]), 'missing');
  delete personal.deletedAt; delete personal.archived;
  assert.equal(teamResultDifference({ ...team, path: '/unrelated-result.zip' }, [personal]), 'missing');
  assert.equal(teamResultDifference({ ...team, revision: 2 }, [personal]), 'updated');
  assert.equal(teamResultDifference({ ...team, sha256: 'b'.repeat(64) }, [personal]), 'updated');
  personal.content = '用户自己补充后的标准。'; personal.automatic = false;
  assert.equal(teamResultDifference(team, [personal]), 'edited');
  const copy = await wb.importContentConclusion(offlineProjectId, team.id, 1);
  assert.equal(copy.action, 'created'); assert.equal(personal.content, '用户自己补充后的标准。');
  assert.equal(teamResultDifference(team, wb.conclusions(offlineProjectId)), undefined);
  await wb.deleteConclusion(copy.conclusion.id, copy.conclusion.version);
  assert.equal(teamResultDifference(team, wb.conclusions(offlineProjectId)), 'edited');
}));

test('migration never guesses from a title or adopts failed uploads, other accounts, projects or deleted copies', async () => fixture(async (_wb, personal, team, transfer, draft) => {
  for (const variant of [
    { ...transfer, status: 'error' as const },
    { ...transfer, sha256: undefined },
    { ...transfer, conclusionSourceId: 'different-source' },
    { ...transfer, binding: { ...transfer.binding, username: 'bob' } },
    { ...transfer, binding: { ...transfer.binding, project: { ...transfer.binding.project, id: 'other-project' } } },
  ]) assert.equal(linkConclusionPublications([personal], [draft], [variant]), false);
  assert.equal(teamResultDifference(team, [personal]), 'missing');
  personal.deletedAt = new Date().toISOString(); assert.equal(linkConclusionPublications([personal], [draft], [transfer]), false);
}));

test('new uploads carry the source link even after their preparation record is removed', async () => fixture(async (wb, personal, team, _transfer, _draft) => {
  wb.store.drafts = []; wb.store.transfers = [];
  const file = path.join(wb.store.root, 'snapshot.txt'); await fs.writeFile(file, 'frozen package');
  wb.remote.ensurePersonalFolder = async () => {};
  wb.remote.upload = async () => undefined as any;
  const [task] = await wb.queue.enqueueMany([{ conclusionSourceId: personal.sources[0].id, local: file, binding: wb.remote.binding(offlineProjectId), folder: wb.remote.binding(offlineProjectId).project.uploadPath, kind: 'upload', metadata: { title: team.title, description: team.description, kind: team.kind } }]);
  const end = Date.now() + 5000;
  while (task.status !== 'done' && task.status !== 'error' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(task.status, 'done'); assert.equal(personal.sources[0].publication?.path, task.target);
  assert.equal(teamResultDifference({ ...team, path: task.target, sha256: task.sha256! }, [personal]), undefined);
  await wb.store.save();
  const persisted = JSON.parse(await fs.readFile(path.join(wb.store.root, 'conclusions.json'), 'utf8'));
  assert.equal(teamResultDifference({ ...team, path: task.target, sha256: task.sha256! }, persisted), undefined);
}));
