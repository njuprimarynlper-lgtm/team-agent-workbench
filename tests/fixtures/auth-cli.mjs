import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
const root = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(root, 'auth-state.json');
const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const log = event => fs.appendFileSync(path.join(root, 'auth-calls.jsonl'), JSON.stringify({ event }) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const mode = read();
const command = process.argv[2];
if (command === '--version') console.log('fixture-cli-1.0');
else if (command === 'login') {
  log('login');
  // The workbench may retain the approved URL, but must discard all other output.
  console.log('https://cursor.com/loginDeepControl?fixture=1');
  console.error('access_token=DO_NOT_FORWARD_THIS_SECRET');
  if (mode.login === 'fail') process.exitCode = 1;
  else if (mode.login === 'hang') setInterval(() => {}, 1000);
  else setTimeout(() => { fs.writeFileSync(stateFile, JSON.stringify({ ...read(), status: 'ready' })); }, 200);
} else if (command === 'status') {
  log('status');
  if (mode.status === 'hang') setInterval(() => {}, 1000);
  else if (mode.status === 'network') { send({ status: 'error', message: 'invalid token: fetch failed ECONNRESET DO_NOT_FORWARD_THIS_SECRET' }); process.exitCode = 1; }
  else if (mode.status === 'malformed') console.log('not a status response');
  else if (mode.status === 'ready') send({ status: 'authenticated', isAuthenticated: true, userInfo: { email: 'fake@example.com' } });
  else send({ status: 'unauthenticated', isAuthenticated: false, message: 'Not logged in' });
} else if (command === 'models') {
  log('models');
  if (mode.catalog === 'hang') setInterval(() => {}, 1000);
  else if (mode.catalog === 'error' || mode.status !== 'ready') { console.error('fetch failed DO_NOT_FORWARD_THIS_SECRET'); process.exitCode = 1; }
  else console.log('Available models\n\ncursor-fixture - Cursor Fixture (current, default)\nother-fixture - Other Fixture\n\nTip: use --model <id>');
} else {
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line), current = read();
    const preparation = JSON.stringify(m.params || {}).includes('destinationId');
    const answer = provider => preparation ? current.preparationRaw ?? JSON.stringify(current.preparationResult || { title: 'Agent 成果草稿', body: '# Agent 成果草稿\n已根据交接文件整理。测试已通过。', repoUrl: 'https://github.com/owner/repo', destinationId: 'default' }) : provider === 'codex' ? '# Agent 成果草稿\n已根据交接文件整理。测试已通过。' : '# Cursor 成果草稿\n已完成。';
    if (m.method) fs.appendFileSync(path.join(root, 'rpc-calls.jsonl'), JSON.stringify(m) + '\n');
    if (m.method === 'initialize' || m.method === 'authenticate' || m.method === 'session/set_model' || m.method === 'session/set_mode') send({ id: m.id, result: {} });
    else if (m.method === 'model/list') {
      if (current.catalog === 'hang') return;
      if (current.catalog === 'error') send({ id: m.id, error: { code: -32000, message: 'fetch failed DO_NOT_FORWARD_THIS_SECRET' } });
      else send({ id: m.id, result: m.params.cursor ? { data: [{ id: 'id-2', model: 'gpt-fixture-2', displayName: 'GPT Fixture 2' }], nextCursor: null } : { data: [{ id: 'id-1', model: 'gpt-fixture', displayName: 'GPT Fixture', isDefault: true }], nextCursor: 'next' } });
    } else if (m.method === 'account/rateLimits/read') {
      if (current.quota === 'error') send({ id: m.id, error: { code: -32000, message: 'quota network failure DO_NOT_FORWARD_THIS_SECRET' } });
      else send({ id: m.id, result: { rateLimitsByLimitId: { codex: { primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: 1800600000 } } } } });
    }
    else if (m.method === 'account/read') {
      log('account/read');
      if (current.status === 'hang') return;
      if (current.status === 'network') {
        const reply = () => send({ id: m.id, error: { code: -32000, message: 'fetch failed ECONNRESET DO_NOT_FORWARD_THIS_SECRET' } });
        if (current.delay) setTimeout(reply, current.delay); else reply();
      }
      else if (current.status === 'expired') send({ id: m.id, error: { code: -32000, message: 'refresh_token_expired' } });
      else { const reply = () => send({ id: m.id, result: { requiresOpenaiAuth: current.status !== 'custom', account: current.status === 'ready' ? { type: 'chatgpt', email: 'fake@example.com', planType: 'pro' } : null } }); if (current.delay) setTimeout(reply, current.delay); else reply(); }
    } else if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: 'fake-thread' } } });
    else if (m.method === 'session/new' || m.method === 'session/load') send({ id: m.id, result: { sessionId: 'fake-session' } });
    else if (m.method === 'turn/start') {
      log('turn/start');
      send({ id: m.id, result: { turn: { id: 'fake-turn' } } });
      if (current.turn === 'hang') return;
      if (current.turn === 'crash') { process.exit(9); return; }
      if (current.turn === 'success') {
        const done = () => {
          send({ method: 'item/completed', params: { threadId: 'fake-thread', item: { id: 'answer', type: 'agentMessage', text: answer('codex') } } });
          send({ method: 'turn/completed', params: { turn: { id: 'fake-turn' } } });
        }; if (current.turnDelay) setTimeout(done, current.turnDelay); else done();
      } else if (current.turn === 'network') send({ method: 'turn/completed', params: { turn: { id: 'fake-turn', error: { message: 'Network timeout: connection reset' } } } });
      else if (current.fileApproval) {
        send({ method: 'item/started', params: { threadId: 'fake-thread', turnId: 'fake-turn', item: { id: 'patch-item', type: 'fileChange', changes: [{ path: 'solution.py', kind: { type: 'update' }, diff: '-old_value\n+new_value' }] } } });
        send({ id: 'patch-approval', method: 'item/fileChange/requestApproval', params: { threadId: 'fake-thread', turnId: 'fake-turn', itemId: 'patch-item', reason: 'fixture file change' } });
      } else send({ method: 'turn/completed', params: { turn: { id: 'fake-turn', error: { message: '401 Unauthorized: Please log in again' } } } });
    } else if (m.method === 'session/prompt') {
      if (current.turn === 'hang') return;
      if (current.turn === 'crash') { process.exit(9); return; }
      if (current.turn === 'success') {
        const done = () => {
          send({ method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer('cursor') } } } });
          send({ id: m.id, result: { stopReason: 'end_turn' } });
        }; if (current.turnDelay) setTimeout(done, current.turnDelay); else done();
      } else send({ id: m.id, error: { code: -32000, message: current.turn === 'network' ? 'Network timeout: connection reset' : 'Unauthenticated: Please log in again' } });
    }
    else if (m.id === 'patch-approval' && m.result) send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'fake-turn', status: 'completed' } } });
  });
}
