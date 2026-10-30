import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cursorAcpModels, cursorClientCapabilities, cursorRequestError } from '../src/core/cursor-models';
import { inspectCatalog } from '../src/core/provider-catalog';
// @ts-expect-error Shared JS fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

async function fixture(state: Record<string, unknown> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-models-'));
  const cli = await authLauncher(root, { status: 'ready', ...state });
  const calls = async () => (await fs.readFile(path.join(root, 'rpc-calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const launches = async () => (await fs.readFile(path.join(root, 'cli-launches.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { root, cli, calls, launches, close: () => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

test('Cursor uses parameterized base ids and preserves saved explicit variants without changing tool permissions', () => {
  assert.equal(cursorClientCapabilities('grok-4.7')._meta.parameterizedModelPicker, true);
  assert.equal(cursorClientCapabilities()._meta.parameterizedModelPicker, true);
  assert.equal(cursorClientCapabilities('grok-4.7[fast=false]')._meta.parameterizedModelPicker, false);
  assert.equal(cursorClientCapabilities().terminal, false);
  assert.deepEqual(cursorClientCapabilities().fs, { readTextFile: false, writeTextFile: false });
  assert.deepEqual(cursorAcpModels({ models: [{ value: 'grok-4.7', name: 'Grok 4.7' }, { value: 'grok-4.7', name: 'Grok 4.7' }, { value: '', name: 'bad' }, { value: 4 }, { value: 'bad\nid' }] }), [{ id: 'grok-4.7', name: 'Grok 4.7' }]);
  assert.throws(() => cursorAcpModels({ unexpected: [] }), /无法识别/);
});

test('catalog uses ACP ids on the chosen route, without creating sessions or starting login', async () => {
  const f = await fixture({ cursorModelsResult: { models: [{ value: 'grok-4.7', name: 'Grok 4.7', secret: 'do-not-display' }] } });
  try {
    const result = await inspectCatalog('cursor', f.cli.launcher, f.root, undefined, 3000, { HTTPS_PROXY: 'http://127.0.0.1:18001', TEAM_AGENT_MANAGEMENT_PROXY: '1' });
    assert.deepEqual(result.models, [{ id: 'grok-4.7', name: 'Grok 4.7' }]); assert.equal(result.modelError, undefined);
    const calls = await f.calls();
    assert.deepEqual(calls.map(c => c.method), ['initialize', 'cursor/list_available_models']);
    assert.equal(calls[0].params.clientCapabilities._meta.parameterizedModelPicker, true);
    assert.deepEqual(await f.launches(), [['acp']]);
    assert((await f.cli.environments()).every((e: any) => e.managementNetwork === '1'));
  } finally { await f.close(); }
});

test('older Cursor CLI falls back to its text catalog only when the ACP method is unsupported', async () => {
  const f = await fixture({ rpcErrors: { 'cursor/list_available_models': 'Method not found' }, rpcErrorCodes: { 'cursor/list_available_models': -32601 } });
  try {
    const result = await inspectCatalog('cursor', f.cli.launcher, f.root, undefined, 3000);
    assert.equal(result.modelError, undefined); assert.equal(result.models[0].id, 'cursor-fixture');
    assert.deepEqual(await f.launches(), [['acp'], ['models']]);
  } finally { await f.close(); }
});

for (const [name, state] of [
  ['empty', { cursorModelsResult: { models: [] } }],
  ['malformed', { cursorModelsResult: {} }],
  ['unavailable', { catalog: 'error' }],
  ['unauthenticated', { status: 'none' }],
] as const) test(`Cursor ${name} ACP catalog does not advertise unrelated legacy models or start login`, async () => {
  const f = await fixture(state);
  try {
    const result = await inspectCatalog('cursor', f.cli.launcher, f.root, undefined, 3000);
    assert.equal(result.models.length, 0); assert(result.modelError);
    assert.deepEqual(await f.launches(), [['acp']]);
    assert(!(await f.calls()).some(c => c.method === 'authenticate' || c.method.startsWith('session/')));
  } finally { await f.close(); }
});

test('canceling a slow Cursor ACP model query closes its process and does not launch a fallback', async () => {
  const f = await fixture({ catalog: 'hang' }), controller = new AbortController();
  try {
    const pending = inspectCatalog('cursor', f.cli.launcher, f.root, controller.signal, 5000);
    const deadline = Date.now() + 3000;
    while (!(await f.calls()).some(c => c.method === 'cursor/list_available_models')) {
      assert(Date.now() < deadline); await new Promise(r => setTimeout(r, 20));
    }
    controller.abort(); const result = await pending;
    assert(result.modelError); assert.deepEqual(await f.launches(), [['acp']]);
  } finally { await f.close(); }
});

test('Cursor invalid params distinguishes model, original history and prompt failures without rendering sensitive error data', () => {
  const error = (method: string, message: string) => Object.assign(new Error('Invalid params'), { code: -32602, method, data: { message, token: 'secret-value' } });
  const modelError = cursorRequestError(error('session/set_model', 'Invalid model value: grok-4.7'), 'grok-4.7')!;
  assert.match(modelError.message, /不接受模型「grok-4.7」.*刷新模型列表/);
  assert.match(cursorRequestError(error('session/load', 'Session "native-id" not found'))!.message, /原始记录/);
  const promptError = cursorRequestError(error('session/prompt', 'Invalid request: secret-value'))!;
  assert.match(promptError.message, /本次消息/); assert.doesNotMatch(promptError.message, /secret-value|Invalid params/);
  assert.equal((promptError as any).method, 'session/prompt'); assert.equal((promptError as any).code, -32602);
  assert.equal(cursorRequestError(new Error('403 Forbidden')), undefined);
});
