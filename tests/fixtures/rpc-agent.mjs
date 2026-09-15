import readline from 'node:readline';
const mode = process.env.TEST_PROVIDER || 'codex';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const nativeId = 'native-session-1';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize' || m.method === 'authenticate' || m.method === 'session/set_mode') send({ id: m.id, result: {} });
  else if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: nativeId, path: '/fake/native-session.jsonl' } } });
  else if (m.method === 'session/new' || m.method === 'session/load') send({ id: m.id, result: { sessionId: nativeId } });
  else if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 'turn-1' } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: nativeId, itemId: 'answer-1', delta: '中文回复' } });
    send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { command: 'echo test', threadId: nativeId } });
  } else if (m.method === 'session/prompt') {
    globalThis.promptRequestId = m.id;
    send({ method: 'session/update', params: { sessionId: nativeId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Cursor 中文回复' } } } });
    send({ id: 'approval-1', method: 'session/request_permission', params: { toolCall: { title: 'test command' }, options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' }] } });
  } else if (m.id === 'approval-1' && m.result) {
    if (mode === 'codex') { send({ method: 'item/completed', params: { threadId: nativeId, item: { id: 'answer-1', type: 'agentMessage', text: '中文回复' } } }); send({ method: 'turn/completed', params: { threadId: nativeId, turn: { id: 'turn-1', status: 'completed' } } }); }
    else send({ id: globalThis.promptRequestId, result: { stopReason: 'end_turn' } });
  } else if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); }
});
