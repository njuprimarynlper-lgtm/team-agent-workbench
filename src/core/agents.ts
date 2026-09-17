import { randomUUID } from 'node:crypto';
import type { AgentSession, Approval, Message } from '../shared/types';
import { JsonRpc, type RpcMessage } from './rpc';
import { codexPermissionParams, codexPermissions, cursorPermissionArgs, cursorPermissions, permissionIssue, probeCodexCommand } from './permissions';
export interface AgentHooks { changed: () => void; event: (value: unknown) => void; done: () => void; authFailed?: (error: unknown) => void; needsApproval?: () => void; }
const now = () => new Date().toISOString();
const pretty = (x: unknown) => typeof x === 'string' ? x : JSON.stringify(x, null, 2);
export class AgentRuntime {
  rpc: JsonRpc;
  private requests = new Map<string, RpcMessage>();
  private fileChanges = new Map<string, { turnId?: string; changes: unknown[] }>();
  private turnId?: string;
  private initialized = false;
  private cursorMessageId = '';
  private closing = false;
  private turnActive = false;
  constructor(readonly session: AgentSession, executable: string, private hooks: AgentHooks) {
    this.rpc = new JsonRpc(executable, session.provider === 'codex' ? ['app-server'] : cursorPermissionArgs(session), session.cwd, session.provider === 'cursor');
    this.rpc.on('message', (m: RpcMessage) => this.onMessage(m));
    this.rpc.on('closed', (e: Error) => { this.initialized = false; this.fileChanges.clear(); if (!this.closing) this.finish(e.message); });
  }
  private message(id: string, role: Message['role'], text: string, append = false) {
    const existing = this.session.messages.find(x => x.id === id);
    if (existing) existing.text = append ? existing.text + text : text;
    else this.session.messages.push({ id, role, text, createdAt: now() });
    this.hooks.changed();
  }
  async start() {
    if (this.initialized) return;
    const s = this.session; s.status = 'starting'; s.error = undefined; this.hooks.changed();
    if (s.provider === 'codex') {
      await this.rpc.request('initialize', { clientInfo: { name: 'team_agent_workbench', title: 'Team Agent Workbench', version: '0.4.0' } });
      this.rpc.notify('initialized');
      const params = { cwd: s.cwd, ...(s.model ? { model: s.model } : {}), ...codexPermissionParams(s) };
      const result = s.nativeId ? await this.rpc.request('thread/resume', { ...params, threadId: s.nativeId }) : await this.rpc.request('thread/start', params);
      s.nativeId = result.thread.id; s.nativePath = result.thread.path || undefined;
      s.permissions = codexPermissions(result, 'runtime');
      await probeCodexCommand(this.rpc, s.permissions, s.cwd, result.sandbox);
      if (s.permissions.execution === 'blocked') s.permissionIssue = permissionIssue(s.permissions.executionDetail) || { kind: 'sandbox', message: s.permissions.executionDetail || 'CLI 命令自检未通过', at: now() };
      if (s.purpose === 'work' && s.permissionMode === 'review' && (result.approvalPolicy !== 'untrusted' || result.approvalsReviewer !== 'user')) throw new Error('无法确认 CLI 权限策略已采用人工审批，请检查 CLI 版本和管理员约束后重试');
    } else {
      s.permissions = await cursorPermissions(s.cwd);
      if (s.purpose === 'work' && s.permissionMode === 'review' && (s.permissions.approval !== 'allowlist' || s.permissions.cursorConfig?.allow.length)) throw new Error('Cursor 权限策略仍包含自动审批或允许规则。请打开执行权限，点击“配置 Cursor 人工审批”后重试。');
      await this.rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'team-agent-workbench', version: '0.4.0' } });
      await this.rpc.request('authenticate', { methodId: 'cursor_login' }, 120000);
      const result = s.nativeId ? await this.rpc.request('session/load', { sessionId: s.nativeId, cwd: s.cwd, mcpServers: [] }) : await this.rpc.request('session/new', { cwd: s.cwd, mcpServers: [] });
      s.nativeId = result.sessionId || s.nativeId;
      if (s.model) await this.rpc.request('session/set_model', { sessionId: s.nativeId, modelId: s.model });
      if (s.purpose === 'prepare') await this.rpc.request('session/set_mode', { sessionId: s.nativeId, modeId: 'ask' });
      else if (s.permissionMode && s.permissionMode !== 'inherit') await this.rpc.request('session/set_mode', { sessionId: s.nativeId, modeId: 'agent' });
      if (s.permissionMode === 'full' && s.purpose === 'work') s.permissions.warnings.push('本会话已使用 --force --sandbox disabled 请求完全权限；明确拒绝规则和团队策略仍由 Cursor 执行。');
      if (s.permissionMode === 'inherit' && ['ask', 'plan'].includes(result.modes?.currentModeId)) s.permissions.warnings.push('当前 Cursor 为只读问答或规划模式，无法直接修改代码。可改用人工审批或完全权限启动 Agent 模式。');
    }
    this.initialized = true; s.status = 'idle'; this.hooks.changed();
  }
  async prompt(text: string) {
    if (!text.trim()) throw new Error('请输入任务内容');
    if (this.session.status === 'running' || this.session.status === 'approval') throw new Error('当前会话仍在运行，可以新建独立会话继续工作');
    try { await this.start(); } catch (error) { const issue = permissionIssue(error); if (issue) { this.session.permissionIssue = issue; this.hooks.changed(); } else this.hooks.authFailed?.(error); throw error; }
    if (this.closing) return;
    this.message(randomUUID(), 'user', text); this.hooks.event({ direction: 'user', text });
    this.turnId = undefined; this.turnActive = true; this.session.status = 'running'; this.session.error = undefined; this.cursorMessageId = randomUUID(); this.hooks.changed();
    try {
      if (this.session.provider === 'codex') {
        const result = await this.rpc.request('turn/start', { threadId: this.session.nativeId, ...(this.session.model ? { model: this.session.model } : {}), input: [{ type: 'text', text, text_elements: [] }] });
        if (this.turnActive) this.turnId = result.turn.id;
      } else {
        const result = await this.rpc.request('session/prompt', { sessionId: this.session.nativeId, prompt: [{ type: 'text', text }] }, 0);
        this.hooks.event({ method: 'session/prompt/result', result }); this.finish();
      }
    } catch (e: any) { if (!this.closing) this.finish(e.message); }
  }
  private finish(error?: string) {
    const completedTurn = this.turnActive; this.turnActive = false;
    if (error) { const issue = permissionIssue(error); if (issue) this.session.permissionIssue = issue; else this.hooks.authFailed?.(error); }
    this.session.status = error ? 'error' : 'idle'; this.session.error = error; this.session.approvals = [];
    this.turnId = undefined; this.requests.clear(); this.fileChanges.clear(); this.hooks.changed(); if (completedTurn) this.hooks.done();
  }
  private onMessage(m: RpcMessage) {
    if (this.closing) return;
    const method = m.method!, p = m.params || {}, s = this.session;
    // Only session events are archived. Account/authentication messages are never stored here.
    if (/^(item\/|turn\/|session\/|cursor\/|error$)/.test(method)) this.hooks.event({ method, params: p });
    if (m.id !== undefined) { this.onRequest(m); return; }
    if (s.provider === 'codex') {
      if (p.threadId && s.nativeId && p.threadId !== s.nativeId) return;
      if (method === 'item/agentMessage/delta') this.message(p.itemId, 'assistant', p.delta || '', true);
      if (method === 'item/commandExecution/outputDelta') this.message(p.itemId, 'tool', p.delta || '', true);
      if (method === 'item/started' && p.item?.type === 'commandExecution') this.message(p.item.id, 'tool', '$ ' + p.item.command + '\n');
      if (method === 'item/started' && p.item?.type === 'fileChange' && Array.isArray(p.item.changes)) this.fileChanges.set(p.item.id, { turnId: p.turnId, changes: p.item.changes });
      if (method === 'item/completed') {
        const i = p.item || {};
        this.fileChanges.delete(i.id);
        if (i.type === 'agentMessage') this.message(i.id, 'assistant', i.text || '');
        else if (i.type === 'commandExecution') { if (i.exitCode !== 0 || i.status === 'failed') { const issue = permissionIssue(i.aggregatedOutput); if (issue) { s.permissionIssue = issue; this.hooks.changed(); } } this.message(i.id, 'tool', '$ ' + i.command + '\n' + (i.aggregatedOutput || '') + '\n退出码：' + i.exitCode); }
        else if (i.type !== 'userMessage' && i.type !== 'reasoning') this.message(i.id || randomUUID(), 'tool', pretty(i));
      }
      if (method === 'turn/started') { this.turnId = p.turn?.id; s.status = 'running'; this.hooks.changed(); }
      if (method === 'turn/completed') this.finish(p.turn?.error?.message);
      if (method === 'error') { this.message(randomUUID(), 'system', p.error?.message || pretty(p)); if (!p.willRetry) this.finish(p.error?.message || '运行失败'); }
    } else if (method === 'session/update') {
      if (p.sessionId && s.nativeId && p.sessionId !== s.nativeId) return;
      const u = p.update || {};
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') this.message(this.cursorMessageId, 'assistant', u.content.text, true);
      if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        const text = [u.title, u.status, ...(u.content || []).map((x: any) => x.content?.text || pretty(x))].filter(Boolean).join('\n');
        if (u.status === 'failed') { const issue = permissionIssue(text); if (issue) { s.permissionIssue = issue; this.hooks.changed(); } }
        this.message(u.toolCallId, 'tool', text, u.sessionUpdate === 'tool_call_update');
      }
      if (u.sessionUpdate === 'plan') this.message('plan-' + this.cursorMessageId, 'tool', pretty(u.entries));
    } else if (method.startsWith('cursor/')) this.message(randomUUID(), 'tool', pretty(p));
  }
  private onRequest(m: RpcMessage) {
    const p = m.params || {}, method = m.method!, id = randomUUID();
    if (this.session.provider === 'codex' && p.threadId && this.session.nativeId && p.threadId !== this.session.nativeId) { this.rpc.reject(m.id!, '请求不属于当前会话'); return; }
    if (this.session.provider === 'cursor' && p.sessionId && this.session.nativeId && p.sessionId !== this.session.nativeId) { this.rpc.reject(m.id!, '请求不属于当前会话'); return; }
    if (p.turnId && this.turnId && p.turnId !== this.turnId) { this.rpc.reject(m.id!, '请求不属于当前轮次'); return; }
    if ([...this.requests.values()].some(r => r.id === m.id)) return;
    const approval: Approval = { id, method, title: 'CLI 请求确认', details: pretty(p), options: [] };
    const command = p.command || p.toolCall?.rawInput?.command;
    approval.summary = [command ? '命令：' + pretty(command) : '', p.cwd ? '目录：' + p.cwd : '', p.reason ? '原因：' + p.reason : ''].filter(Boolean).join('\n');
    if (method === 'session/request_permission') {
      approval.title = p.toolCall?.title || 'Cursor 工具操作';
      approval.options = (p.options || []).filter((o: any) => ['allow_once', 'reject_once'].includes(o.kind)).map((o: any) => ({ id: o.optionId, label: o.kind === 'allow_once' ? '允许本次' : '拒绝', kind: o.kind === 'allow_once' ? 'allow' : 'deny' }));
      if (!approval.options.length) { this.rpc.respond(m.id!, { outcome: { outcome: 'cancelled' } }); this.message(randomUUID(), 'system', 'CLI 未提供可用的一次性授权选项，本次请求已取消。'); return; }
    } else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      approval.title = method.includes('commandExecution') ? 'Codex 请求执行命令' : 'Codex 请求修改文件';
      if (method === 'item/fileChange/requestApproval') {
        // The approval itself may carry only an itemId; the diff arrives in item/started.
        const item = this.fileChanges.get(p.itemId);
        if (item && item.turnId === p.turnId) { approval.details = pretty({ ...p, changes: item.changes }); approval.summary = [approval.summary, ...item.changes.map((c: any) => typeof c.path === 'string' ? '文件：' + c.path : '')].filter(Boolean).join('\n'); }
      }
      approval.options = [{ id: 'accept', label: '允许本次', kind: 'allow' }, { id: 'decline', label: '拒绝', kind: 'deny' }];
      if (Array.isArray(p.availableDecisions)) { approval.options = approval.options.filter(o => p.availableDecisions.includes(o.id)); if (p.availableDecisions.includes('cancel')) approval.options.push({ id: 'cancel', label: '取消操作', kind: 'deny' }); }
      if (!approval.options.length) { this.rpc.reject(m.id!, '当前界面不支持此授权范围，请由 CLI 提供一次性授权或取消选项'); return; }
    } else if (method === 'item/permissions/requestApproval') {
      approval.title = 'Codex 请求额外权限'; approval.options = [{ id: 'accept', label: '允许本轮', kind: 'allow' }, { id: 'decline', label: '拒绝', kind: 'deny' }];
    } else if (method === 'item/tool/requestUserInput' || method === 'cursor/ask_question') {
      approval.title = p.title || 'Agent 需要补充信息';
      approval.questions = (p.questions || []).map((q: any) => ({ id: q.id, text: q.question || q.prompt, options: (q.options || []).map((o: any) => o.label) }));
      approval.options = [{ id: 'answer', label: '提交回答', kind: 'answer' }, { id: 'skip', label: '跳过', kind: 'deny' }];
    } else if (method === 'cursor/create_plan') {
      approval.title = p.name || 'Cursor 方案确认'; approval.details = p.plan || pretty(p);
      approval.options = [{ id: 'accept', label: '采用方案', kind: 'allow' }, { id: 'decline', label: '不采用', kind: 'deny' }];
    } else if (method === 'mcpServer/elicitation/request') {
      this.rpc.respond(m.id!, { action: 'decline', content: null }); this.message(randomUUID(), 'system', '已拒绝当前界面尚不支持的 MCP 表单请求。'); return;
    } else { this.rpc.reject(m.id!); this.message(randomUUID(), 'system', 'CLI 请求暂不支持，已明确返回错误：' + method); return; }
    this.requests.set(id, m); this.session.approvals.push(approval); this.session.status = 'approval'; this.hooks.changed(); this.hooks.needsApproval?.();
  }
  answer(id: string, option: string, answers: Record<string, string> = {}) {
    const req = this.requests.get(id), approval = this.session.approvals.find(a => a.id === id);
    if (!req || !approval || !approval.options.some(x => x.id === option)) throw new Error('确认项已过期或选项无效');
    const p = req.params || {}; let result: unknown;
    if (req.method === 'session/request_permission') result = { outcome: { outcome: 'selected', optionId: option } };
    else if (req.method === 'cursor/create_plan') result = { outcome: { outcome: option === 'accept' ? 'accepted' : 'rejected' } };
    else if (req.method === 'cursor/ask_question') result = option === 'skip' ? { outcome: { outcome: 'skipped', reason: '用户跳过' } } : { outcome: { outcome: 'answered', answers: (p.questions || []).map((q: any) => ({ questionId: q.id, selectedOptionIds: (q.options || []).filter((o: any) => o.label === answers[q.id]).map((o: any) => o.id) })) } };
    else if (req.method === 'item/tool/requestUserInput') result = { answers: Object.fromEntries((p.questions || []).map((q: any) => [q.id, { answers: [answers[q.id] || '用户选择跳过，请根据已有信息继续'] }])) };
    else if (req.method === 'item/permissions/requestApproval') result = { permissions: option === 'accept' ? p.permissions : {}, scope: 'turn' };
    else result = { decision: option };
    this.rpc.respond(req.id!, result); this.hooks.event({ direction: 'user', method: req.method, result });
    this.requests.delete(id); this.session.approvals = this.session.approvals.filter(x => x.id !== id);
    this.session.status = this.session.approvals.length ? 'approval' : 'running'; this.hooks.changed();
  }
  async cancel() {
    if (this.session.provider === 'codex' && this.turnId) await this.rpc.request('turn/interrupt', { threadId: this.session.nativeId, turnId: this.turnId });
    else if (this.session.provider === 'cursor' && this.session.nativeId) this.rpc.notify('session/cancel', { sessionId: this.session.nativeId });
    else this.close();
  }
  close() { this.closing = true; this.turnActive = false; this.session.status = 'idle'; this.session.approvals = []; this.hooks.changed(); return this.rpc.close(); }
}
