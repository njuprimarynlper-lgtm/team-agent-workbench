import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { AgentRuntime } from '../src/core/agents';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Shared JS fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

async function until(fn: () => boolean) { const end = Date.now() + 25000; while (!fn()) { if (Date.now() > end) throw new Error('preparation permission test timed out'); await new Promise(r => setTimeout(r, 25)); } }
for (const provider of ['codex', 'cursor'] as const) test(provider + ': preparation and retry use full access without human approval, independent of parent policy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-prepare-permissions-'));
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success', permissionRuntime: true, policyApproval: true, permissionConfig: { sandbox: 'read-only', approval: 'on-request' } });
  const notices: string[] = [], wb = new Workbench(path.join(root, 'data'), () => {}, message => notices.push(message));
  let legacyRuntime: AgentRuntime | undefined;
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths[provider] = fixture.launcher;
    const parent = await wb.createSession(provider, root, offlineProjectId, 'work', undefined, 'chosen-model', 'review');
    await wb.saveHandoff(parent.id, '# 工作记录\n已确认的成果与依据。');
    const handoff = await wb.readHandoff(parent.id);
    const draft = await wb.prepare(parent.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await wb.retryPreparation(draft.id);
      await until(() => draft.generation !== 'running' || wb.session(draft.prepareSessionId!).approvals.length > 0);
      const helper = wb.session(draft.prepareSessionId!);
      assert.equal(draft.generation, 'ready', draft.generationError || 'preparation unexpectedly waited for approval');
      assert.equal(helper.permissionMode, 'full'); assert.equal(helper.model, 'chosen-model'); assert.deepEqual(helper.approvals, []);
      assert.equal(parent.permissionMode, 'review'); assert.equal(parent.status, 'idle'); assert.equal(parent.messages.length, 0);
      assert.equal(await wb.readHandoff(parent.id), handoff); assert.equal(wb.store.transfers.length, 0);
      if (provider === 'codex') { assert.equal(helper.permissions?.approval, 'never'); assert.equal(helper.permissions?.sandbox, 'dangerFullAccess'); }
    }
    // A helper recorded by an older build must also start with the new fixed policy.
    const legacy = { ...structuredClone(wb.session(draft.prepareSessionId!)), nativeId: undefined, permissionMode: 'review' as const, status: 'idle' as const, closedAt: undefined };
    legacyRuntime = new AgentRuntime(legacy, fixture.launcher, { changed: () => {}, event: () => {}, done: () => {} });
    await legacyRuntime.ensureStarted(); assert.equal(legacy.permissionMode, 'full');
    const calls = (await fs.readFile(path.join(root, 'cli', 'rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    if (provider === 'codex') {
      const starts = calls.filter(c => c.method === 'thread/start'); assert(starts.length >= 3);
      assert(starts.every(c => c.params.approvalPolicy === 'never' && c.params.sandbox === 'danger-full-access'));
    } else {
      const modes = calls.filter(c => c.method === 'session/set_mode'); assert(modes.length >= 3); assert(modes.every(c => c.params.modeId === 'agent'));
      const launches = (await fs.readFile(path.join(root, 'cli', 'cli-launches.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(args => args.includes('acp'));
      assert(launches.length >= 3); assert(launches.every(args => args.includes('--force') && args[args.indexOf('--sandbox') + 1] === 'disabled'));
    }
    assert(!notices.some(n => n.startsWith('待授权：')));
  } finally { await legacyRuntime?.close(); await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
