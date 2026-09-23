const readline = require('node:readline');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.1.263 (Claude Code)\n'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', email: 'alice@example.test' })); process.exit(0); }
if (args[0] === 'plugin' && args[1] === 'list') { process.stdout.write('[{"name":"sample-plugin","enabled":true}]'); process.exit(0); }
if (!args.includes('-p') || !args.includes('--permission-prompt-tool') || !args.includes('stdio')) process.exit(2);
const sessionId = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : args[args.indexOf('--resume') + 1];
const line = readline.createInterface({ input: process.stdin });
let stage = 0;
line.on('line', raw => {
  const value = JSON.parse(raw);
  if (value.type === 'user') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'control_request', request_id: 'approval-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo test' } } }) + '\n');
    stage = 1;
  } else if (value.type === 'control_response' && stage === 1) {
    if (value.response.response.behavior !== 'allow') process.exit(3);
    process.stdout.write(JSON.stringify({ type: 'control_request', request_id: 'question-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] } } }) + '\n');
    stage = 2;
  } else if (value.type === 'control_response' && stage === 2) {
    if (value.response.response.updatedInput?.answers?.['Which?'] !== 'B') process.exit(4);
    process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: args.includes('--resume') ? 'continued' : 'first' } } }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', session_id: sessionId, result: 'ignored because already streamed', is_error: false }) + '\n');
    stage = 3;
  }
});
line.on('close', () => { if (stage === 3) process.exit(0); });
