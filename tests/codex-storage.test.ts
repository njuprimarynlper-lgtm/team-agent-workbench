import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareCodexStorage, validateCodexStorage } from '../src/core/codex-storage';
import type { JsonRpc } from '../src/core/rpc';
import { pathToFileURL } from 'node:url';
import type { AgentSession } from '../src/shared/types';
const session = (cwd: string): AgentSession => ({ id: randomUUID(), title: '隔离验证', provider: 'codex', cwd, purpose: 'work', createdAt: new Date().toISOString(), status: 'idle', messages: [], approvals: [], sources: [], autoUpload: false, handoffPath: path.join(cwd, 'handoff.md') });

test('Codex storage separates histories and DBs while preserving personal configuration without copying login credentials', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-isolation-')), personal = path.join(root, 'personal'), data = path.join(root, 'data');
  try {
    await fs.mkdir(path.join(personal, 'skills'), { recursive: true });
    await fs.mkdir(path.join(personal, 'sessions'));
    await fs.writeFile(path.join(personal, 'auth.json'), '{"refresh_token":"KEEP_PRIVATE"}');
    await fs.writeFile(path.join(personal, 'config.toml'), 'sandbox_mode="read-only"');
    await fs.writeFile(path.join(personal, 'requirements.toml'), 'allowed_sandbox_modes=["read-only"]');
    await fs.writeFile(path.join(personal, 'special.config.toml'), 'model="example"');
    await fs.writeFile(path.join(personal, 'sessions', 'personal.jsonl'), 'not workbench history');
    const [a, b] = await Promise.all([prepareCodexStorage(data, session(root), personal), prepareCodexStorage(data, session(root), personal)]);
    assert.equal(a.home, b.home); assert.notEqual(a.env.CODEX_HOME, personal);
    assert.equal(a.env.CODEX_SQLITE_HOME, path.join(a.home, 'sqlite'));
    assert(a.args.includes('cli_auth_credentials_store="ephemeral"'));
    await assert.rejects(validateCodexStorage({ request: async () => ({ requirements: { sqliteHome: pathToFileURL(personal).href } }) } as unknown as JsonRpc, a), /管理策略不允许独立保存/);
    await validateCodexStorage({ request: async () => ({ requirements: { sqliteHome: pathToFileURL(a.env.CODEX_SQLITE_HOME!).href, cliAuthCredentialsStore: 'ephemeral' } }) } as unknown as JsonRpc, a);
    await assert.rejects(validateCodexStorage({ request: async () => ({ requirements: { cliAuthCredentialsStore: 'file' } }) } as unknown as JsonRpc, a), /管理策略不允许工作台沿用/);
    assert.equal(await fs.readFile(path.join(a.home, 'config.toml'), 'utf8'), 'sandbox_mode="read-only"');
    assert.equal(await fs.readFile(path.join(a.home, 'requirements.toml'), 'utf8'), 'allowed_sandbox_modes=["read-only"]');
    assert.equal(await fs.realpath(path.join(a.home, 'skills')), await fs.realpath(path.join(personal, 'skills')));
    assert.deepEqual(await fs.readdir(path.join(a.home, 'sessions')), []);
    await assert.rejects(fs.access(path.join(a.home, 'auth.json')));
    await fs.unlink(path.join(personal, 'config.toml')); await fs.unlink(path.join(personal, 'special.config.toml'));
    await prepareCodexStorage(data, session(root), personal);
    await assert.rejects(fs.access(path.join(a.home, 'config.toml'))); await assert.rejects(fs.access(path.join(a.home, 'special.config.toml')));
    assert((await fs.readFile(path.join(personal, 'auth.json'), 'utf8')).includes('KEEP_PRIVATE'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('legacy Codex migration copies only the owned full rollout, retains the original, and fails without history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-migrate-')), personal = path.join(root, 'personal'), nativeId = randomUUID();
  try {
    const originalDir = path.join(personal, 'sessions', '2026', '09', '17'); await fs.mkdir(originalDir, { recursive: true });
    const name = 'rollout-2026-09-17T00-00-00-' + nativeId + '.jsonl', original = path.join(originalDir, name);
    const history = JSON.stringify({ type: 'session_meta', payload: { id: nativeId } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { role: 'user', content: 'keep my context' } });
    await fs.writeFile(original, history); await fs.writeFile(path.join(originalDir, 'unrelated.jsonl'), 'private');
    const s = { ...session(root), nativeId, nativePath: original }, storage = await prepareCodexStorage(path.join(root, 'data'), s, personal);
    assert(storage.resumePath); assert.equal(await fs.readFile(storage.resumePath!, 'utf8'), history); assert.equal(await fs.readFile(original, 'utf8'), history);
    assert.deepEqual(await fs.readdir(path.dirname(storage.resumePath!)), [name]);
    s.codexStorage = 'workbench'; const resumed = await prepareCodexStorage(path.join(root, 'data'), s, personal); assert.equal(resumed.resumePath, undefined);
    await assert.rejects(prepareCodexStorage(path.join(root, 'other'), { ...session(root), nativeId: randomUUID() }, personal), /找不到原会话记录/);
    await assert.rejects(prepareCodexStorage(personal, session(root), personal), /分开/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
