import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { AgentRuntime } from '../src/core/agents';
import { JsonRpc } from '../src/core/rpc';
import type { AgentSession } from '../src/shared/types';

// Opt in with an installed CLI; no account, real service, tool execution or user data.
test('real Codex app-server continues failed capacity turn with empty input and intact history', { skip: !process.env.CODEX_CAPACITY_NATIVE_EXE, timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-capacity-native-')), uploads: any[] = [], events: any[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || new URL(req.url!, 'http://fixture').pathname !== '/v1/responses') { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString()); uploads.push(input);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event: any) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: 'response.created', response: { id: 'response-' + uploads.length, status: 'in_progress', output: [] } });
    if (input.model === 'gpt-5.4') {
      send({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_overloaded', message: 'The model is at capacity. Please try a different model.' } } });
    } else {
      const item = { id: 'reply', type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'CAPACITY_RECOVERED' }] };
      send({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
      send({ type: 'response.output_text.delta', item_id: 'reply', output_index: 0, content_index: 0, delta: 'CAPACITY_RECOVERED' });
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({ type: 'response.completed', response: { id: 'response-' + uploads.length, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
    }
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const rpc = new JsonRpc(process.env.CODEX_CAPACITY_NATIVE_EXE!, ['app-server', '-c', 'model="gpt-5.4"', '-c', 'model_provider="capacity_fixture"',
    '-c', `model_providers.capacity_fixture={name="fixture",base_url="${url}",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
    '-c', 'features.shell_tool=false', '-c', 'check_for_update_on_startup=false'], root, false,
    { CODEX_HOME: root, HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, http_proxy: url, https_proxy: url, all_proxy: url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });
  const request = rpc.request.bind(rpc);
  rpc.request = async (method, params, timeout, written) => method === 'model/list' ? { data: [
    { model: 'gpt-5.4', isDefault: true }, { model: 'gpt-5.3-codex', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
  ] } : request(method, params, timeout, written).then(value => { if (method === 'thread/read') events.push({ read: value }); return value; });
  const session = { id: 'native-test', provider: 'codex', purpose: 'work', cwd: root, model: 'gpt-5.4', permissionMode: 'inherit', status: 'idle', messages: [], approvals: [], sources: [] } as unknown as AgentSession;
  let done = 0;
  const runtime = new AgentRuntime(session, 'unused', { changed() {}, event(event) { events.push(event); }, done() { done++; } }, undefined, {}, rpc);
  try {
    await runtime.prompt('KEEP_LATEST_NATIVE_REQUEST');
    const end = Date.now() + 25000;
    while (!done) { if (Date.now() > end) throw Error('native timeout: ' + JSON.stringify(events.slice(-8))); await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.equal(session.status, 'idle', (session.error || '') + JSON.stringify({ uploads: uploads.length, events: events.slice(-5) }));
    assert.equal(done, 1); assert.equal(uploads.length, 2);
    assert.deepEqual(uploads.map(value => value.model), ['gpt-5.4', 'gpt-5.3-codex']);
    assert.equal(JSON.stringify(uploads[1].input).split('KEEP_LATEST_NATIVE_REQUEST').length - 1, 1);
    assert(session.messages.some(message => message.role === 'assistant' && message.text === 'CAPACITY_RECOVERED'));
    assert.equal(session.messages.filter(message => message.role === 'user').length, 1);
  } finally {
    await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    // A CLI-owned SQLite worker can release its Windows directory asynchronously.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
});
