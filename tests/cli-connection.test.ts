import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliConnectionTracker, classifyCliError } from '../src/core/cli-connection';
import { AgentRuntime } from '../src/core/agents';
import type { AgentSession } from '../src/shared/types';
// @ts-expect-error Shared protocol fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

test('CLI diagnostics classify reconnects and HTTP failures without copying payloads or misreading ordinary counts', () => {
  const value = classifyCliError('Reconnecting... 2/5 (unexpected status code: 403 Forbidden) Bearer PRIVATE');
  assert.deepEqual(value, { state: 'reconnecting', kind: 'forbidden', httpStatus: 403, attempt: 2, retryLimit: 5 });
  assert.equal(classifyCliError('completed 403 checks'), undefined);
  assert.equal(classifyCliError({ message: 403 }), undefined);
  assert.equal(classifyCliError('HTTP 401 Unauthorized')?.kind, 'authentication');
  assert.equal(classifyCliError('status code 429')?.kind, 'rate_limit');
  assert.equal(classifyCliError({ message: 'request failed', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } })?.httpStatus, 503);
  assert.equal(classifyCliError(Object.assign(new Error('request failed'), { data: { httpStatusCode: 403 } }))?.httpStatus, 403);
  const s = { status: 'running' } as AgentSession, reports: any[] = [];
  const tracker = new CliConnectionTracker(s, () => {}, value => reports.push(value));
  tracker.begin(); tracker.diagnostic('Reconnec'); tracker.diagnostic('ting... 1/5\nPRIVATE_SECRET\n');
  assert.equal(s.cliConnection?.state, 'reconnecting'); tracker.responded(); assert.equal(s.cliConnection?.state, 'connected');
  tracker.error('HTTP 403 Forbidden'); tracker.finish('request failed'); assert.equal(s.cliConnection?.httpStatus, 403);
  assert(!JSON.stringify(reports).includes('PRIVATE')); tracker.stop(); assert.equal(s.cliConnection?.state, 'failed', 'cleanup must preserve the failure until the next attempt');
  tracker.begin(); tracker.stop(); assert.equal(s.cliConnection?.state, 'stopped');
});

test('native error notifications update the visible session and recover only on service activity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-cli-health-'));
  const fixture = await authLauncher(root, { status: 'ready', turn: 'hang' });
  const s: AgentSession = { id: 'fixture', title: 'fixture', provider: 'codex', cwd: root, createdAt: new Date().toISOString(), purpose: 'work', status: 'idle', messages: [], approvals: [], sources: [], autoUpload: false, handoffPath: path.join(root, 'handoff.md') };
  const reports: any[] = [], runtime = new AgentRuntime(s, fixture.launcher, { changed: () => {}, event: () => {}, done: () => {}, connectionChanged: value => reports.push(value) });
  try {
    await runtime.prompt('fixture');
    runtime.rpc.emit('diagnostic', 'Reconnecting... 1/5\n'); assert.equal(s.cliConnection?.state, 'reconnecting'); assert.equal(s.status, 'running');
    runtime.rpc.emit('message', { method: 'error', params: { threadId: 'different', error: { message: 'HTTP 403 Forbidden' }, willRetry: false } }); assert.equal(s.cliConnection?.state, 'reconnecting');
    runtime.rpc.emit('message', { method: 'error', params: { threadId: s.nativeId, willRetry: true, error: { message: 'HTTP 403 Forbidden' } } }); assert.equal(s.cliConnection?.httpStatus, 403); assert.equal(s.cliConnection?.state, 'reconnecting');
    runtime.rpc.emit('message', { method: 'item/agentMessage/delta', params: { threadId: s.nativeId, itemId: 'answer', delta: 'recovered' } }); assert.equal(s.cliConnection?.state, 'connected'); assert.equal(s.cliConnection?.httpStatus, undefined);
    runtime.rpc.emit('message', { method: 'error', params: { threadId: s.nativeId, willRetry: false, error: { message: 'HTTP 403 Forbidden' } } }); assert.equal(s.status, 'error'); assert.equal(s.cliConnection?.state, 'failed'); assert.equal(s.cliConnection?.httpStatus, 403);
    assert(reports.some(value => value.state === 'reconnecting')); assert(reports.some(value => value.state === 'connected')); assert(reports.some(value => value.state === 'failed'));
    await runtime.prompt('another fixture');
    runtime.rpc.emit('message', { method: 'turn/completed', params: { threadId: s.nativeId, turn: { id: 'fake-turn', error: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } } } } });
    assert.equal(s.status, 'error'); assert.equal(s.cliConnection?.httpStatus, 403); assert.equal(s.cliConnection?.state, 'failed');
  } finally { await runtime.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
