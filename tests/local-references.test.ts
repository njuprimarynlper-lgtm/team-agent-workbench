import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { AgentRuntime } from '../src/core/agents';
import { freezeFile } from '../src/core/artifacts';
import { assertSourceReadable } from '../src/core/local-references';
import { sessionContext } from '../src/core/session-context';
import { recoverSessionContext, sourceText } from '../src/shared/session-context-text';
import { pendingComposerReferences } from '../src/renderer/composer-references';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-path-reference-'));
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  await wb.store.init(); grantTestWorkspace(wb, root);
  const session = await wb.createSession('codex', root, offlineProjectId);
  const file = path.join(root, 'reference.txt'); await fs.writeFile(file, 'original');
  return { root, wb, session, file, close: async () => { await wb.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('local selection links the original without a snapshot, deduplicates concurrent selections and tolerates edits', async () => {
  const f = await fixture();
  try {
    const [first, second] = await Promise.all([f.wb.attachLocal(f.session.id, [f.file, f.file]), f.wb.attachLocal(f.session.id, [f.file])]);
    assert.equal(first.length, 1); assert.equal(second[0].id, first[0].id); assert.equal(f.session.sources.length, 1);
    const source = first[0]; assert.equal(source.localPath, f.file); assert.equal(source.sourcePath, f.file); assert.equal(source.referenceMode, 'path');
    await assert.rejects(fs.stat(path.join(f.root, '.workbench', 'sources', f.session.id)), { code: 'ENOENT' });
    await fs.writeFile(f.file, 'edited after association'); await assertSourceReadable(source);
    const input = sessionContext(f.session, 'read when needed', [source.id]);
    assert.match(input.text, /本地文件路径/); assert(input.text.includes(f.file)); assert.doesNotMatch(input.text, /edited after association|SHA256/);
    assert.equal(recoverSessionContext(f.session, input.text).userText, 'read when needed');
    await fs.unlink(f.file); await assert.rejects(assertSourceReadable(source), /不存在或无法读取/);
    await fs.writeFile(f.file, 'restored'); await assertSourceReadable(source);
  } finally { await f.close(); }
});

test('a previously sent path can be selected again for a new round, and removing it retains history and original bytes', async () => {
  const f = await fixture();
  try {
    const [source] = await f.wb.attachLocal(f.session.id, [f.file]);
    f.session.nativeId = 'native';
    const input = sessionContext(f.session, 'first', [source.id]);
    f.session.messages.push({ id: randomUUID(), role: 'user', text: input.text, userText: 'first', createdAt: new Date().toISOString(), context: { ...input.context, nativeId: 'native', accepted: true } });
    assert.equal(sessionContext(f.session, 'next', []).sources.length, 0);
    assert.equal(pendingComposerReferences(f.session, []).length, 0);
    assert.equal(sessionContext(f.session, 'read latest', [source.id]).sources.length, 1);
    assert.equal(pendingComposerReferences(f.session, [source.id])[0].removable, true);
    f.wb.store.inputs[f.session.id] = { text: 'read latest', sourceIds: [source.id], answers: {} };
    await f.wb.detachPendingSource(f.session.id, source.id);
    assert.equal(f.session.sources.length, 1); assert.equal(f.session.messages[0].text, input.text);
    assert.deepEqual(f.wb.store.inputs[f.session.id].sourceIds, []); assert.equal(await fs.readFile(f.file, 'utf8'), 'original');
  } finally { await f.close(); }
});

test('removing an unsent path inside managed sources never deletes the selected original; frozen references still enforce content hashes', async () => {
  const f = await fixture();
  try {
    const managed = path.join(f.wb.store.sessionDir(f.session.id), 'sources'); await fs.mkdir(managed, { recursive: true });
    const original = path.join(managed, 'user-original.txt'); await fs.writeFile(original, 'keep');
    const [linked] = await f.wb.attachLocal(f.session.id, [original]); await f.wb.detachPendingSource(f.session.id, linked.id);
    assert.equal(f.session.sources.length, 0); assert.equal(await fs.readFile(original, 'utf8'), 'keep');
    const frozen = await freezeFile(f.file, managed); await fs.writeFile(frozen.localPath, 'modified snapshot');
    await assert.rejects(assertSourceReadable(frozen), /参考快照已改变/);
  } finally { await f.close(); }
});

test('forking preserves a live reference as a path without copying it or interpreting its receipt as a file hash', async () => {
  const f = await fixture();
  try {
    const [source] = await f.wb.attachLocal(f.session.id, [f.file]);
    f.session.nativeId = 'parent'; f.session.status = 'running';
    f.session.messages.push({ id: randomUUID(), role: 'user', text: 'read', createdAt: new Date().toISOString(), context: { nativeId: 'parent', accepted: true, workRecord: true, sourceHashes: { [source.id]: source.sha256 } } });
    await fs.writeFile(f.file, 'new current content');
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.forkCodexThread = async (capture: () => void) => { capture(); return { id: 'child-native', path: '/fake/child.jsonl', desktop: false }; };
    (f.wb as any).runtime = async () => runtime;
    const child = await f.wb.forkSubsession(f.session.id, 'child');
    const inherited = child.sources.find(item => child.fork!.inheritedSourceIds.includes(item.id))!;
    assert.equal(inherited.referenceMode, 'path'); assert.equal(inherited.localPath, f.file); assert.match(sourceText(inherited), /本地文件路径/);
    assert.notEqual(inherited.id, source.id); await assertSourceReadable(inherited);
    const input = sessionContext(child, 'continue', []);
    child.messages.push({ id: randomUUID(), role: 'user', text: input.text, createdAt: new Date().toISOString(), context: { ...input.context, nativeId: child.nativeId!, accepted: true } });
    assert.equal(sessionContext(child, 'next', []).sources.length, 0, 'inherited paths are not repeatedly auto-injected');
  } finally { await f.close(); }
});
