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
} else {
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line), current = read();
    if (m.method === 'initialize' || m.method === 'authenticate') send({ id: m.id, result: {} });
    else if (m.method === 'account/read') {
      log('account/read');
      if (current.status === 'hang') return;
      if (current.status === 'network') {
        const reply = () => send({ id: m.id, error: { code: -32000, message: 'fetch failed ECONNRESET DO_NOT_FORWARD_THIS_SECRET' } });
        if (current.delay) setTimeout(reply, current.delay); else reply();
      }
      else if (current.status === 'expired') send({ id: m.id, error: { code: -32000, message: 'refresh_token_expired' } });
      else send({ id: m.id, result: { requiresOpenaiAuth: current.status !== 'custom', account: current.status === 'ready' ? { type: 'chatgpt', email: 'fake@example.com' } : null } });
    } else if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: 'fake-thread' } } });
    else if (m.method === 'session/new' || m.method === 'session/load') send({ id: m.id, result: { sessionId: 'fake-session' } });
    else if (m.method === 'turn/start') {
      log('turn/start');
      send({ id: m.id, result: { turn: { id: 'fake-turn' } } });
      send({ method: 'turn/completed', params: { turn: { id: 'fake-turn', error: { message: '401 Unauthorized: Please log in again' } } } });
    } else if (m.method === 'session/prompt') send({ id: m.id, error: { code: -32000, message: 'Unauthenticated: Please log in again' } });
  });
}
