import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RsiEngine } from '../src/core/rsi';
import { loadRsiDocument, rsiJournalFile } from '../src/core/rsi-journal';

test('large RSI history saves only the new evidence and restores it after restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-rsi-journal-'));
  const host = { scope: (projectId: string) => ({ key: projectId, account: 'alice', user: 'alice', projectId }), session: () => undefined, collect: async () => [], changed() {} };
  const create = () => new RsiEngine(root, host, async () => { throw Error('unexpected model call'); });
  try {
    const setup = create();
    await setup.configure('p', { enabled: false });
    await setup.configure('q', { enabled: false });
    await setup.close();
    const base = path.join(root, 'rsi-v2.json');
    const saved = JSON.parse(await fs.readFile(base, 'utf8'));
    saved.projects.p.evidence.push({ id: 'large', scope: 'p', source: 'project', sourceId: 'large', factKey: 'large', eventAt: new Date().toISOString(), observedAt: new Date().toISOString(), version: '1', text: 'x'.repeat(9 * 1024 * 1024), hash: 'large', actor: 'alice', assertion: 'explicit' });
    const previousEvidence = saved.projects.p.evidence.length;
    await fs.writeFile(base, JSON.stringify(saved));
    const before = await fs.stat(base);
    const engine = create();
    try {
      const added = await engine.observe('p', [{ source: 'project', sourceId: 'new', factKey: 'new', eventAt: new Date().toISOString(), version: '1', text: '增量证据', actor: 'alice', assertion: 'explicit' }]);
      assert.equal(added.length, 1);
      assert.equal((await fs.stat(base)).size, before.size);
      assert((await fs.stat(rsiJournalFile(root, 1))).size < 20000);
      const settings = await engine.settings('p');
      assert.equal(settings.config.enabled, false);
      assert(!('evidence' in settings));
      const loaded = await loadRsiDocument(root);
      assert.equal(loaded.value.projects.p.evidence.length, previousEvidence + 1);
      assert.equal(loaded.value.projects.p.evidence.at(-1).text, '增量证据');
      const priorRevision = loaded.value.projects.q.revision;
      await engine.personalPreference('p', '只采用可复核证据');
      const shared = await loadRsiDocument(root);
      assert.equal(shared.value.projects.q.revision, priorRevision + 1);
      assert.equal(shared.value.preferences.alice.text, '只采用可复核证据');
      const reopened = create();
      try { assert.equal((await reopened.view('p')).evidence.length, previousEvidence + 1); assert.equal((await reopened.view('q')).revision, priorRevision + 1); }
      finally { await reopened.close(); }
      await (engine as any).snapshot.captureIfDue(new Date(Date.now() + 24 * 60 * 60 * 1000));
      const checkpoint = JSON.parse(await fs.readFile(base, 'utf8'));
      assert.equal(checkpoint.changeSeq, 2);
      assert.equal((await loadRsiDocument(root)).value.projects.p.evidence.length, previousEvidence + 1);
    } finally { await engine.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a damaged journal blocks loading without replacing the healthy checkpoint', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-rsi-journal-bad-'));
  try {
    await fs.writeFile(path.join(root, 'rsi-v2.json'), JSON.stringify({ version: 3, projects: {}, preferences: {} }));
    const baseline = await fs.readFile(path.join(root, 'rsi-v2.json'));
    await fs.mkdir(path.dirname(rsiJournalFile(root, 1)));
    await fs.writeFile(rsiJournalFile(root, 1), '{broken');
    const engine = new RsiEngine(root, { scope: projectId => ({ key: projectId, account: 'alice', user: 'alice', projectId }), session: () => undefined, collect: async () => [], changed() {} }, async () => { throw Error('unexpected model call'); });
    try { await assert.rejects(engine.view('p'), /增量无法读取/); }
    finally { await engine.close(); }
    assert.deepEqual(await fs.readFile(path.join(root, 'rsi-v2.json')), baseline);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
