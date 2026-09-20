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
fs.appendFileSync(path.join(root, 'cli-launches.jsonl'), JSON.stringify(process.argv.slice(2)) + '\n');
let approvalPolicy = mode.permissionConfig?.approval || 'on-request';
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
    const m = JSON.parse(line), current = read(), turnId = current.turnId || 'fake-turn';
    const requestText = JSON.stringify(m.params || {});
    const semanticMerge = /semanticMerge/.test(requestText);
    const preparation = semanticMerge || /destinationId|artifacts/.test(requestText);
    const answer = provider => semanticMerge
      ? current.mergeRaw ?? JSON.stringify(current.mergeResult || { title: '统一整理的结论', overview: '已根据多条来源形成统一结论。', consensus: ['材料共同支持继续验证。'], conflicts: [], evidence: [], scope: '当前项目阶段', unresolved: [] })
      : preparation ? current.preparationRaw ?? JSON.stringify(current.preparationResult || { title: '模型验证结果', body: '已根据阶段摘要整理。测试已通过。', repoUrl: 'https://github.com/owner/repo', destinationId: 'default' })
        : provider === 'codex' ? '# 模型验证结果\n已根据阶段摘要整理。测试已通过。' : '# Cursor 验证结果\n已完成。';
    if (m.method) fs.appendFileSync(path.join(root, 'rpc-calls.jsonl'), JSON.stringify(m.method === 'account/login/start' ? { ...m, params: { type: m.params.type } } : m) + '\n');
    if (m.method === 'initialize' || m.method === 'authenticate' || m.method === 'session/set_model' || m.method === 'session/set_mode') send({ id: m.id, result: {} });
    else if (m.method === 'getAuthStatus') send({ id: m.id, result: { requiresOpenaiAuth: current.status !== 'custom', authMethod: 'chatgpt', authToken: current.status === 'ready' ? 'fixture.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: current.accountId || 'fixture-account', chatgpt_plan_type: 'pro' } })).toString('base64url') + '.PRIVATE_FIXTURE_TOKEN' : null } });
    else if (m.method === 'account/login/start') send({ id: m.id, result: { type: m.params.type } });
    else if (m.method === 'config/read') send({ id: m.id, result: { config: { sandbox_mode: current.permissionConfig?.sandbox || 'workspace-write', approval_policy: current.permissionConfig?.approval || 'on-request', approvals_reviewer: current.permissionConfig?.reviewer || 'user', api_key: 'DO_NOT_FORWARD_THIS_SECRET' } } });
    else if (m.method === 'configRequirements/read') send({ id: m.id, result: { requirements: current.permissionRequirements || null } });
    else if (m.method === 'command/exec') send(current.probeBlocked ? { id: m.id, error: { code: -32000, message: 'Windows sandbox: CreateProcessAsUser failed' } } : { id: m.id, result: { exitCode: 0, stdout: 'WORKBENCH_PERMISSION_OK', stderr: '' } });
    else if (m.method === 'model/list') {
      if (current.catalog === 'hang') return;
      if (current.catalog === 'error') send({ id: m.id, error: { code: -32000, message: 'fetch failed DO_NOT_FORWARD_THIS_SECRET' } });
      else send({ id: m.id, result: m.params.cursor ? { data: [{ id: 'id-2', model: 'gpt-fixture-2', displayName: 'GPT Fixture 2' }], nextCursor: null } : { data: [{ id: 'id-1', model: 'gpt-fixture', displayName: 'GPT Fixture', isDefault: true }], nextCursor: 'next' } });
    } else if (m.method === 'account/rateLimits/read') {
      if (current.quota === 'error') send({ id: m.id, error: { code: -32000, message: 'quota network failure DO_NOT_FORWARD_THIS_SECRET' } });
      else send({ id: m.id, result: { rateLimitsByLimitId: { codex: { primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: 1800600000 } } } } });
    }
    else if (m.method === 'skills/list') send({ id: m.id, result: { data: [{ cwd: process.cwd(), skills: [{ name: 'codex-fixture-skill', description: 'Codex fixture skill', enabled: true, path: path.join(root, 'skills', 'codex-fixture-skill', 'SKILL.md'), scope: 'user' }], errors: [] }] } });
    else if (m.method === 'plugin/installed') send({ id: m.id, result: { marketplaces: [{ name: 'fixture-marketplace', interface: { displayName: 'Fixture Marketplace' }, plugins: [{ id: 'fixture-plugin@fixture-marketplace', name: 'fixture-plugin', installed: true, enabled: true, availability: 'AVAILABLE', interface: { displayName: 'Fixture Plugin', shortDescription: 'Codex fixture plugin', enabled: true, capabilities: ['skills', 'mcp'] } }] }], marketplaceLoadErrors: [] } });
    else if (m.method === 'account/read') {
      log('account/read');
      if (current.status === 'hang') return;
      if (current.status === 'network') {
        const reply = () => send({ id: m.id, error: { code: -32000, message: 'fetch failed ECONNRESET DO_NOT_FORWARD_THIS_SECRET' } });
        if (current.delay) setTimeout(reply, current.delay); else reply();
      }
      else if (current.status === 'expired') send({ id: m.id, error: { code: -32000, message: 'refresh_token_expired' } });
      else { const reply = () => send({ id: m.id, result: { requiresOpenaiAuth: current.status !== 'custom', account: current.status === 'ready' ? { type: 'chatgpt', email: 'fake@example.com', planType: 'pro' } : null } }); if (current.delay) setTimeout(reply, current.delay); else reply(); }
    } else if (m.method === 'thread/start' || m.method === 'thread/resume') {
      approvalPolicy = m.params.approvalPolicy || current.permissionConfig?.approval || 'on-request';
      if (current.rejectPermissionMode) send({ id: m.id, error: { code: -32000, message: 'sandbox mode not allowed by administrator policy' } });
      else send({ id: m.id, result: { thread: { id: 'fake-thread' }, ...(current.permissionRuntime ? { sandbox: { type: ({ 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' })[m.params.sandbox || current.permissionConfig?.sandbox || 'workspace-write'], networkAccess: false }, approvalPolicy: m.params.approvalPolicy || current.permissionConfig?.approval || 'on-request', approvalsReviewer: m.params.approvalsReviewer || current.permissionConfig?.reviewer || 'user', ...current.permissionRuntimeOverride } : {}) } });
    }
    else if (m.method === 'session/new' || m.method === 'session/load') { send({ id: m.id, result: { sessionId: 'fake-session' } }); send({ method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'copy-request-id', description: 'internal' }, { name: 'cursor-fixture-skill', description: 'Cursor fixture skill' }] } } }); }
    else if (m.method === 'turn/start') {
      log('turn/start');
      if (current.rejectTurn) { send({ id: m.id, error: { code: -32000, message: 'Request rejected before acceptance' } }); return; }
      send({ id: m.id, result: { turn: { id: turnId } } });
      if (current.refreshAuth) { send({ id: 'auth-refresh', method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized', previousAccountId: 'fixture-account' } }); return; }
      if (current.permissionDenied) { send({ method: 'item/completed', params: { threadId: 'fake-thread', item: { id: 'denied-command', type: 'commandExecution', command: 'test command', exitCode: 1, status: 'failed', aggregatedOutput: current.permissionDenied } } }); send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: turnId } } }); return; }
      if (current.toolApproval || current.policyApproval && approvalPolicy !== 'never') { send({ id: 'tool-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'fake-thread', turnId, command: 'test command', cwd: process.cwd(), reason: 'Needs approval outside sandbox', availableDecisions: current.denyOnly ? ['decline'] : ['accept', 'decline'] } }); return; }
      if (current.turn === 'hang') return;
      if (current.turn === 'crash') { process.exit(9); return; }
      if (current.turn === 'success') {
        const done = () => {
          send({ method: 'item/completed', params: { threadId: 'fake-thread', item: { id: 'answer', type: 'agentMessage', text: answer('codex') } } });
          send({ method: 'turn/completed', params: { turn: { id: turnId } } });
        }; if (current.turnDelay) setTimeout(done, current.turnDelay); else done();
      } else if (current.turn === 'network') send({ method: 'turn/completed', params: { turn: { id: turnId, error: { message: 'Network timeout: connection reset' } } } });
      else if (current.fileApproval) {
        send({ method: 'item/started', params: { threadId: 'fake-thread', turnId, item: { id: 'patch-item', type: 'fileChange', changes: [{ path: 'solution.py', kind: { type: 'update' }, diff: '-old_value\n+new_value' }] } } });
        send({ id: 'patch-approval', method: 'item/fileChange/requestApproval', params: { threadId: 'fake-thread', turnId, itemId: 'patch-item', reason: 'fixture file change' } });
      } else send({ method: 'turn/completed', params: { turn: { id: turnId, error: { message: '401 Unauthorized: Please log in again' } } } });
    } else if (m.method === 'session/prompt') {
      if (current.rejectTurn) { send({ id: m.id, error: { code: -32000, message: 'Request rejected before acceptance' } }); return; }
      if (current.toolApproval || current.policyApproval && !process.argv.includes('--force')) { globalThis.toolPromptId = m.id; send({ id: 'tool-approval', method: 'session/request_permission', params: { sessionId: 'fake-session', toolCall: { title: 'Cursor 请求执行命令', rawInput: { command: 'test command' } }, options: current.noOnce ? [{ optionId: 'always', kind: 'allow_always' }] : [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'reject', kind: 'reject_once' }] } }); return; }
      if (current.turn === 'hang') return;
      if (current.turn === 'crash') { process.exit(9); return; }
      if (current.turn === 'success') {
        const done = () => {
          send({ method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer('cursor') } } } });
          send({ id: m.id, result: { stopReason: 'end_turn' } });
        }; if (current.turnDelay) setTimeout(done, current.turnDelay); else done();
      } else send({ id: m.id, error: { code: -32000, message: current.turn === 'network' ? 'Network timeout: connection reset' : 'Unauthenticated: Please log in again' } });
    }
    else if (m.id === 'auth-refresh') { log(m.result?.accessToken ? 'auth-refresh-ok' : 'auth-refresh-rejected'); send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: turnId, ...(m.error ? { error: { message: m.error.message } } : {}) } } }); }
    else if (m.id === 'patch-approval' && m.result) send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: turnId, status: 'completed' } } });
    else if (m.id === 'tool-approval' && m.result) { if (globalThis.toolPromptId) send({ id: globalThis.toolPromptId, result: { stopReason: 'end_turn' } }); else send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: turnId } } }); }
  });
}
