import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderAccounts, inspectAuth, codexAuth, cursorAuth, authFailure, loginUrl } from '../src/core/provider-auth';
import { Workbench } from '../src/core/workbench';
// @ts-expect-error JavaScript launcher shared with Electron UI tests.
import { authLauncher } from './fixtures/auth-launcher.mjs';
async function until(predicate: () => boolean) { const end = Date.now() + 15000; while (!predicate()) { if (Date.now() > end) throw new Error('test timed out'); await new Promise(r => setTimeout(r, 30)); } }
async function cleanup(root: string) { await new Promise(r => setTimeout(r, 300)); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }

test('auth parsing distinguishes missing login, provider configuration, network and malformed responses', () => {
  assert.equal(codexAuth({ account: null, requiresOpenaiAuth: true }).status, 'unauthenticated');
  assert.equal(codexAuth({ account: null, requiresOpenaiAuth: false }).status, 'not-required');
  assert.equal(codexAuth({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }).status, 'configured');
  assert.equal(codexAuth({}).status, 'error');
  assert.equal(cursorAuth('{"status":"unauthenticated","isAuthenticated":false}', 0).status, 'unauthenticated');
  assert.equal(cursorAuth('{"status":"unauthenticated","isAuthenticated":false}', 0, true).status, 'configured');
  assert.equal(cursorAuth('unknown', 0).status, 'error');
  assert.equal(cursorAuth('{"status":"future-status"}', 0).status, 'error');
  assert.equal(authFailure('401 Unauthorized').status, 'unauthenticated');
  assert.equal(authFailure('invalid token: fetch failed ECONNRESET').status, 'error');
  assert.equal(authFailure('403 forbidden workspace').status, 'error');
  assert(!authFailure('fetch failed API_KEY=secret').detail.includes('secret'));
  assert.equal(loginUrl('codex', 'https://auth.openai.com/oauth/authorize?state=abc'), 'https://auth.openai.com/oauth/authorize?state=abc');
  assert.equal(loginUrl('cursor', 'https://cursor.com/loginDeepControl?x=1'), 'https://cursor.com/loginDeepControl?x=1');
  for (const url of ['http://cursor.com/login', 'https://cursor.com.evil.test/login', 'https://cursor.com@evil.test/login', 'https://evil.test/login']) assert.equal(loginUrl('cursor', url), undefined);
});

test('native CLI protocol probes distinguish both providers without starting any model turn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-auth-'));
  const fixture = await authLauncher(root);
  try {
    for (const provider of ['codex', 'cursor'] as const) {
      for (const [status, expected] of [['none', 'unauthenticated'], ['ready', 'authenticated'], ['network', 'error']] as const) {
        await fixture.write({ status });
        const result = await inspectAuth(provider, fixture.launcher, root);
        assert.equal(result.status, expected); assert(!JSON.stringify(result).includes('DO_NOT_FORWARD'));
      }
      await fixture.write({ status: 'hang' });
      assert.equal((await inspectAuth(provider, fixture.launcher, root, undefined, 1000)).status, 'error');
    }
    assert(!(await fixture.calls()).includes('turn/start'));
  } finally { await cleanup(root); }
});

test('login is deduplicated, cancellation works, successful login triggers a fresh check, state stays in memory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-login-'));
  const fixture = await authLauncher(root); let refreshed = 0;
  const accounts = new ProviderAccounts(() => fixture.launcher, () => {}, () => { refreshed++; });
  try {
    await Promise.all([accounts.login('cursor', root), accounts.login('cursor', root)]);
    await until(() => accounts.states.cursor.status === 'authenticated');
    assert.equal((await fixture.calls()).filter((x: string) => x === 'login').length, 1);
    assert.equal(refreshed, 1); assert.equal(accounts.states.cursor.loginUrl, undefined);
    assert(!JSON.stringify(accounts.states).includes('DO_NOT_FORWARD'));
    await fixture.write({ status: 'none', login: 'hang' }); await accounts.login('cursor', root);
    await until(() => Boolean(accounts.states.cursor.loginUrl)); accounts.cancel('cursor');
    assert.equal(accounts.states.cursor.status, 'unknown'); assert.equal(accounts.states.cursor.loginUrl, undefined);
    await fixture.write({ status: 'network' });
    assert.equal((await accounts.check('cursor', root)).status, 'error');
    const first = accounts.check('codex', root); accounts.invalidate('codex');
    assert.equal((await first).status, 'error'); assert.equal(accounts.states.codex.status, 'unknown');
  } finally { await accounts.close(); await cleanup(root); }
});

test('session preflight blocks missing auth and runtime expiry enables login recovery without archiving account state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-auth-session-'));
  const fixture = await authLauncher(root);
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); wb.workspaceReady = true;
    wb.store.settings.providerPaths.codex = fixture.launcher;
    const session = await wb.createSession('codex', root);
    await assert.rejects(wb.send(session.id, 'do not lose this task'), /尚未登录/);
    assert.equal(session.nativeId, undefined); assert.equal(session.messages.length, 0);
    await fixture.write({ status: 'ready' }); await wb.send(session.id, 'test task');
    await until(() => wb.accounts.states.codex.status === 'unauthenticated');
    assert.equal(session.status, 'error');
    const snapshot = JSON.stringify(wb.store.sessions); assert(!snapshot.includes('fake@example.com'));
    await wb.store.save();
    assert(!JSON.stringify(await fs.readdir(wb.store.root)).includes('auth-state'));
  } finally { await wb.close(); await cleanup(root); }
});
