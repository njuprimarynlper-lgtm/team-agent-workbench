import { randomUUID } from 'node:crypto';
import type { AgentCapabilityCatalog, AgentCapabilityOption, AgentSession, Approval, Message, MessageContext } from '../shared/types';
import { JsonRpc, type RpcMessage } from './rpc';
import { codexPermissionParams, codexPermissions, cursorPermissionArgs, cursorPermissions, permissionIssue, probeCodexCommand } from './permissions';
import { validateCodexStorage, type CodexStorage } from './codex-storage';
import { CodexAuthBridge } from './codex-auth-bridge';
import { permissionLabels } from '../shared/permission-presentation';
import { codexCapabilities, cursorCommandCapabilities, cursorPluginCapabilities, emptyCapabilityCatalog } from './provider-capabilities';
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
  private steering = false;
  private authBridge?: CodexAuthBridge;
  private cursorCommands: any[] = [];
  private cursorCommandWaiters = new Set<() => void>();
  private codexCapabilityCatalog?: AgentCapabilityCatalog;
  constructor(readonly session: AgentSession, executable: string, private hooks: AgentHooks, private storage?: CodexStorage, networkEnv: NodeJS.ProcessEnv = {}) {
    // Preparation has its own execution policy, including helpers saved by older builds.
    if (session.purpose === 'prepare') session.permissionMode = 'full';
    this.rpc = new JsonRpc(executable, session.provider === 'codex' ? storage?.args || ['app-server'] : cursorPermissionArgs(session), session.cwd, session.provider === 'cursor', { ...networkEnv, ...storage?.env });
    if (session.provider === 'codex' && storage) this.authBridge = new CodexAuthBridge(executable, session.cwd, storage.sourceHome, networkEnv);
    this.rpc.on('message', (m: RpcMessage) => this.onMessage(m));
    this.rpc.on('closed', (e: Error) => { this.initialized = false; this.fileChanges.clear(); void this.authBridge?.close(); if (!this.closing) this.finish(e.message); });
  }
  private message(id: string, role: Message['role'], text: string, append = false, metadata: Pick<Message, 'userText' | 'context'> = {}) {
    const existing = this.session.messages.find(x => x.id === id);
    if (existing) existing.text = append ? existing.text + text : text;
    else this.session.messages.push({ id, role, text, createdAt: now(), ...metadata });
    this.hooks.changed();
  }
  async start() {
    if (this.initialized) return;
    const s = this.session; s.status = 'starting'; s.error = undefined; this.hooks.changed();
    if (s.provider === 'codex') {
      await this.rpc.request('initialize', { clientInfo: { name: 'team_agent_workbench', title: 'Team Agent Workbench', version: '0.7.0' }, capabilities: { experimentalApi: true } });
      this.rpc.notify('initialized');
      if (this.storage) await validateCodexStorage(this.rpc, this.storage);
      await this.authBridge?.login(this.rpc);
      if (this.closing) return;
      const params = { cwd: s.cwd, ...(s.model ? { model: s.model } : {}), ...codexPermissionParams(s) };
      const result = s.nativeId ? await this.rpc.request('thread/resume', { ...params, threadId: s.nativeId, ...(this.storage?.resumePath ? { path: this.storage.resumePath } : {}) }) : await this.rpc.request('thread/start', params);
      s.nativeId = result.thread.id; s.nativePath = result.thread.path || this.storage?.resumePath || s.nativePath;
      if (this.storage) s.codexStorage = 'workbench';
      s.permissions = codexPermissions(result, 'runtime');
      await probeCodexCommand(this.rpc, s.permissions, s.cwd, result.sandbox);
      if (s.permissions.execution === 'blocked') s.permissionIssue = permissionIssue(s.permissions.executionDetail) || { kind: 'sandbox', message: s.permissions.executionDetail || 'CLI 命令自检未通过', at: now() };
      if (s.purpose === 'work' && s.permissionMode && s.permissionMode !== 'inherit') {
        const expected = codexPermissionParams(s);
        // Windows may apply a narrower scope until its sandbox is configured.
        // Show that scope as a custom restriction; do not prevent read-only work.
        if (result.approvalPolicy !== expected.approvalPolicy || result.approvalsReviewer !== expected.approvalsReviewer) throw new Error(`权限策略未采用“${permissionLabels.codex[s.permissionMode]}”，请修改权限或更新 Codex 后重试`);
      }
    } else {
      s.permissions = await cursorPermissions(s.cwd);
      if (s.purpose === 'work' && s.permissionMode === 'review' && (s.permissions.approval !== 'allowlist' || s.permissions.cursorConfig?.allow.length)) throw new Error('Cursor 权限策略仍包含自动审批或允许规则。请打开执行权限，点击“配置 Cursor Allowlist”后重试。');
      await this.rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'team-agent-workbench', version: '0.4.0' } });
      await this.rpc.request('authenticate', { methodId: 'cursor_login' }, 120000);
      const result = s.nativeId ? await this.rpc.request('session/load', { sessionId: s.nativeId, cwd: s.cwd, mcpServers: [] }) : await this.rpc.request('session/new', { cwd: s.cwd, mcpServers: [] });
      s.nativeId = result.sessionId || s.nativeId;
      if (s.model) await this.rpc.request('session/set_model', { sessionId: s.nativeId, modelId: s.model });
      if (s.permissionMode && s.permissionMode !== 'inherit') await this.rpc.request('session/set_mode', { sessionId: s.nativeId, modeId: 'agent' });
      if (s.permissionMode === 'full') s.permissions.warnings.push('本会话已请求 Run Everything；明确拒绝规则和团队策略仍由 Cursor 执行。');
      if (s.permissionMode === 'inherit' && ['ask', 'plan'].includes(result.modes?.currentModeId)) s.permissions.warnings.push('当前 Cursor 为 Ask 或 Plan 模式，无法直接修改代码。');
    }
    this.initialized = true; s.status = 'idle'; this.hooks.changed();
  }
  async ensureStarted() {
    try { await this.start(); } catch (error) { const issue = permissionIssue(error); if (issue) { this.session.permissionIssue = issue; this.hooks.changed(); } else this.hooks.authFailed?.(error); throw error; }
  }
  async capabilities(forceRefresh = false): Promise<AgentCapabilityCatalog> {
    await this.ensureStarted();
    if (this.session.provider === 'cursor') {
      if (!this.cursorCommands.length) await new Promise<void>(resolve => {
        let timer: NodeJS.Timeout;
        const done = () => { clearTimeout(timer); this.cursorCommandWaiters.delete(done); resolve(); };
        this.cursorCommandWaiters.add(done); timer = setTimeout(done, 1500);
      });
      return { ...emptyCapabilityCatalog('cursor'), skills: cursorCommandCapabilities(this.cursorCommands), plugins: await cursorPluginCapabilities(this.session.cwd) };
    }
    if (!forceRefresh && this.codexCapabilityCatalog) return this.codexCapabilityCatalog;
    let skillsResult: any = { data: [] }, installedPlugins: any = { marketplaces: [] }, skillError: string | undefined, pluginError: string | undefined;
    try { skillsResult = await this.rpc.request('skills/list', { cwds: [this.session.cwd], forceReload: forceRefresh }, 20000); }
    catch { skillError = 'Skill 列表读取失败，请检查 Codex 版本后重试。'; }
    try { installedPlugins = await this.rpc.request('plugin/installed', { cwds: [this.session.cwd] }, 20000); }
    catch { pluginError = '已安装插件读取失败，请更新 Codex 后重试；Skill 仍可使用。'; }
    this.codexCapabilityCatalog = { ...codexCapabilities(skillsResult, installedPlugins), skillError, pluginError };
    return this.codexCapabilityCatalog;
  }
  async resolveCapabilities(selections: { id: string; kind: 'skill' | 'plugin' }[]): Promise<AgentCapabilityOption[]> {
    if (!selections.length) return [];
    const catalog = await this.capabilities(false), available = new Map([...catalog.skills, ...catalog.plugins].map(item => [item.id, item]));
    const resolved = selections.map(selection => {
      const item = available.get(selection.id);
      if (!item || item.kind !== selection.kind) throw new Error(`所选 ${selection.kind === 'skill' ? 'Skill' : '插件'} 已不可用，请重新选择`);
      if (!item.enabled) throw new Error(item.unavailableReason || '所选能力当前不可用');
      return item;
    });
    if (this.session.provider === 'cursor' && resolved.filter(item => item.kind === 'skill').length > 1) throw new Error('Cursor 每条消息只能显式调用一个 Skill，请重新选择');
    return resolved;
  }
  async prompt(text: string, options?: { userText: string; context: Omit<MessageContext, 'nativeId' | 'accepted'>; capabilities?: AgentCapabilityOption[]; submitted?: () => void }) {
    if (!text.trim()) throw new Error('请输入任务内容');
    if (this.session.status === 'running' || this.session.status === 'approval') throw new Error('当前会话仍在运行，可以新建独立会话继续工作');
    await this.ensureStarted();
    if (this.closing) return false;
    const selected = options?.capabilities || [], prefixes = selected.filter(item => item.kind === 'skill' || this.session.provider === 'codex').map(item => this.session.provider === 'cursor' ? '/' + item.invocation : item.kind === 'skill' ? '$' + item.invocation : '@' + item.invocation);
    const cursorPlugins = this.session.provider === 'cursor' ? selected.filter(item => item.kind === 'plugin') : [];
    const nativeText = [prefixes.join(' '), text].filter(Boolean).join(' ') + (cursorPlugins.length ? `\n\n[本轮用户选择的插件工具：${cursorPlugins.map(item => item.name).join('、')}。请在与当前任务相关时使用这些已由 Cursor CLI 加载的工具。]` : '');
    const context = options ? { ...options.context, capabilities: selected.map(({ id, kind, name }) => ({ id, kind, name })), nativeId: this.session.nativeId!, accepted: false } : undefined;
    this.message(randomUUID(), 'user', nativeText, false, options ? { userText: options.userText, context } : {});
    this.hooks.event({ direction: 'user', text: nativeText, ...(options ? { userText: options.userText, capabilities: context?.capabilities } : {}) });
    this.turnId = undefined; this.turnActive = true; this.session.status = 'running'; this.session.error = undefined; this.cursorMessageId = randomUUID(); this.hooks.changed();
    try {
      if (this.session.provider === 'codex') {
        const input: any[] = [{ type: 'text', text: nativeText, text_elements: [] }, ...selected.map(item => item.kind === 'skill' ? { type: 'skill', name: item.invocation, path: item.path } : { type: 'mention', name: item.invocation, path: item.path })];
        const result = await this.rpc.request('turn/start', { threadId: this.session.nativeId, ...(this.session.model ? { model: this.session.model } : {}), input }, 60000, options?.submitted);
        if (this.turnActive) { this.turnId = result.turn.id; this.hooks.changed(); }
      } else {
        const result = await this.rpc.request('session/prompt', { sessionId: this.session.nativeId, prompt: [{ type: 'text', text: nativeText }] }, 0, options?.submitted);
        this.hooks.event({ method: 'session/prompt/result', result }); this.finish();
      }
      if (context) { context.accepted = true; this.hooks.changed(); }
      return true;
    } catch (e: any) { if (!this.closing) this.finish(e.message); return false; }
  }
  get activeTurnId(): string | undefined {
    return this.session.provider === 'codex' && this.turnActive && !this.closing && ['running', 'approval'].includes(this.session.status) ? this.turnId : undefined;
  }
  async steer(expectedTurnId: string, text: string, options: { userText: string; context: Omit<MessageContext, 'nativeId' | 'accepted'>; capabilities?: AgentCapabilityOption[] }) {
    if (this.session.provider !== 'codex') throw new Error('当前 Cursor 接入暂不支持生成中引导，请等待本轮结束后发送');
    if (!text.trim()) throw new Error('请输入引导内容');
    if (!expectedTurnId || this.activeTurnId !== expectedTurnId) throw new Error('当前轮次已结束或发生变化，引导未发送；请核对后重新发送');
    if (this.steering) throw new Error('上一条引导正在发送，请稍候');
    this.steering = true;
    const selected = options.capabilities || [], nativeId = this.session.nativeId!;
    const nativeText = [selected.map(item => (item.kind === 'skill' ? '$' : '@') + item.invocation).join(' '), text].filter(Boolean).join(' ');
    const input = [{ type: 'text', text: nativeText, text_elements: [] }, ...selected.map(item => item.kind === 'skill' ? { type: 'skill', name: item.invocation, path: item.path } : { type: 'mention', name: item.invocation, path: item.path })];
    // Keep the message at its submission position even if streamed output precedes the acknowledgement.
    const index = this.session.messages.length, createdAt = now();
    try {
      const result = await this.rpc.request('turn/steer', { threadId: nativeId, expectedTurnId, input });
      if (result?.turnId !== expectedTurnId) throw new Error('CLI 返回了不同轮次，未能确认引导送达；请先查看回复，避免重复发送');
      const context: MessageContext = { ...options.context, capabilities: selected.map(({ id, kind, name }) => ({ id, kind, name })), nativeId, accepted: true };
      this.session.messages.splice(index, 0, { id: randomUUID(), role: 'user', text: nativeText, userText: options.userText, context, steering: true, createdAt });
      this.hooks.event({ direction: 'user', method: 'turn/steer', turnId: expectedTurnId, text: nativeText, userText: options.userText, capabilities: context.capabilities });
      this.hooks.changed();
      return true;
    } catch (error: any) {
      if (/method.*not.*found|unknown method|unsupported.*method|不支持.*方法/i.test(error.message)) throw new Error('当前 Codex CLI 不支持引导，请更新 Codex CLI；输入已保留');
      if (/超时|连接已关闭|进程已退出/.test(error.message)) throw new Error('未能确认引导是否送达，输入已保留；请先查看回复，避免重复发送');
      // A rejected steer does not fail or interrupt the running task.
      throw error;
    } finally { this.steering = false; }
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
    if (method === 'account/chatgptAuthTokens/refresh' && m.id !== undefined && this.authBridge) { void this.authBridge.refresh(this.rpc, m.id); return; }
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
        if (i.type === 'fileChange' && i.status !== 'failed') s.outputFiles = [...new Set([...(s.outputFiles || []), ...(i.changes || this.fileChanges.get(i.id)?.changes || []).map((change: any) => change.path).filter((value: unknown): value is string => typeof value === 'string')])];
        this.fileChanges.delete(i.id);
        if (i.type === 'agentMessage') this.message(i.id, 'assistant', i.text || '');
        else if (i.type === 'commandExecution') { if (i.exitCode !== 0 || i.status === 'failed') { const issue = permissionIssue(i.aggregatedOutput); if (issue) { s.permissionIssue = issue; this.hooks.changed(); } } this.message(i.id, 'tool', '$ ' + i.command + '\n' + (i.aggregatedOutput || '') + '\n退出码：' + i.exitCode); }
        else if (i.type !== 'userMessage' && i.type !== 'reasoning') this.message(i.id || randomUUID(), 'tool', pretty(i));
      }
      if (method === 'turn/started') { this.turnId = p.turn?.id; s.status = 'running'; this.hooks.changed(); }
      if (method === 'turn/completed' && (!this.turnId || !p.turn?.id || p.turn.id === this.turnId)) this.finish(p.turn?.error?.message);
      if (method === 'error') { this.message(randomUUID(), 'system', p.error?.message || pretty(p)); if (!p.willRetry) this.finish(p.error?.message || '运行失败'); }
    } else if (method === 'session/update') {
      if (p.sessionId && s.nativeId && p.sessionId !== s.nativeId) return;
      const u = p.update || {};
      if (u.sessionUpdate === 'available_commands_update') { this.cursorCommands = Array.isArray(u.availableCommands) ? u.availableCommands : []; for (const done of this.cursorCommandWaiters) done(); this.cursorCommandWaiters.clear(); }
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') this.message(this.cursorMessageId, 'assistant', u.content.text, true);
      if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        if (u.status !== 'failed' && Array.isArray(u.locations)) s.outputFiles = [...new Set([...(s.outputFiles || []), ...u.locations.map((location: any) => location.path).filter((value: unknown): value is string => typeof value === 'string')])];
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
  async close() { this.closing = true; this.turnActive = false; for (const done of this.cursorCommandWaiters) done(); this.cursorCommandWaiters.clear(); this.session.status = 'idle'; this.session.approvals = []; this.hooks.changed(); await Promise.all([this.rpc.close(), this.authBridge?.close()]); }
}
