import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtRoot = path.resolve(process.argv.find(value => value.startsWith('--dist='))?.slice(7) || 'dist');
const data = path.join(root, '.test-data/error-audit/log-scope-' + Date.now()); await fs.mkdir(data, { recursive: true });
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_ADMIN_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [path.join(builtRoot,'admin')], cwd: root, env, timeout: 60000 });
const checks = [];
const report = path.join(root, 'docs/error-audit', process.argv.includes('--readability') ? 'readability-log-scope-verification.json' : 'log-scope-verification.json');
await fs.writeFile(report, JSON.stringify({ passed: false, status: 'running', checks, data, generatedAt: new Date().toISOString() }, null, 2));
try {
  const first = await app.firstWindow(); await first.waitForLoadState('domcontentloaded');
  const failure = await first.evaluate(async () => {
    try { await window.admin.call('connect', { profile: { mode: 'sftp', host: '127.0.0.1', port: 1, username: 'fixture-admin', fingerprint: '', root: '/srv/error-audit' }, password: 'FIXTURE_PASSWORD_NEVER_LOG' }); } catch (error) { return error; }
  });
  assert.ok(failure?.failure?.logRef?.operationId); assert.ok(!failure.message.includes('ECONNREFUSED'));
  const query = await first.evaluate(reference => window.admin.call('logs.query', { operationId: reference.operationId }), failure.failure.logRef);
  assert.equal(query.items.length, 1); const id = query.items[0].id;
  const detail = await first.evaluate(id => window.admin.call('logs.get', { id }), id); assert.equal(detail.record?.id, id); assert.match(detail.record.detail, /ECONNREFUSED/); assert.ok(!JSON.stringify(detail).includes('FIXTURE_PASSWORD_NEVER_LOG'));
  checks.push('failed first connection resolves main-issued operationId to its attempted node and retrieves redacted detail');
  const repeated = await first.evaluate(async () => {
    try { await window.admin.call('connect', { profile: { mode: 'sftp', host: '127.0.0.1', port: 1, username: 'fixture-admin', fingerprint: '', root: '/srv/error-audit' }, password: 'FIXTURE_PASSWORD_NEVER_LOG' }); } catch (error) { return error; }
  });
  const repeatedRef = repeated.failure.logRef;
  const repeatedRecord = await first.evaluate(async reference => reference.id ? (await window.admin.call('logs.get', { id: reference.id })).record : (await window.admin.call('logs.query', { operationId: reference.operationId })).items[0], repeatedRef);
  assert.ok(repeatedRecord, 'deduplicated repeated failure must resolve to the original retained record');
  checks.push('a repeated identical failure resolves to the retained diagnostic record after log deduplication');
  await first.evaluate(() => window.admin.call('window.new'));
  await expect.poll(async () => app.windows().length).toBe(2); const second = app.windows().find(window => window !== first); await second.waitForLoadState('domcontentloaded');
  const stolen = await second.evaluate(async reference => ({ query: await window.admin.call('logs.query', { operationId: reference.operationId }), detail: await window.admin.call('logs.get', { id: reference.id }) }), { operationId: failure.failure.logRef.operationId, id });
  assert.equal(stolen.query.items.length, 0); assert.equal(stolen.detail.record, undefined);
  checks.push('another admin window cannot reuse the first window reference to read a different node');
  const rejected = await second.evaluate(async () => { try { await window.admin.call('logs.query', { centralId: 'forged-node', root: '..' }); return false; } catch { return true; } }); assert.equal(rejected, true);
  checks.push('renderer cannot supply centralId or filesystem root to change the derived scope');
  await fs.writeFile(report, JSON.stringify({ passed: true, checks, data, generatedAt: new Date().toISOString() }, null, 2));
  console.log('Log scope desktop verification passed: ' + checks.length + ' checks');
} catch (error) {
  await fs.writeFile(report, JSON.stringify({ passed: false, checks, data, error: error.message, generatedAt: new Date().toISOString() }, null, 2)); throw error;
} finally { await app.close(); }
