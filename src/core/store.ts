import fs from 'node:fs/promises';
import { isProjectOrganizationDraft } from '../shared/project-organization';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentSession, Draft, ProjectConclusion, Settings, Transfer, SessionInput } from '../shared/types';
import { settingsSchema } from './config';
import { activityStateSchema } from './activity-state';
import { migrateSessionContext } from './session-context';
import { repairConclusionImports } from './conclusion-import-repair';
import { accountIdentity } from '../shared/account-data';
import { rememberPreparationProgress } from '../shared/preparation-progress';
import { migrateProjectDirectories, followsProjectDirectory } from '../shared/project-directory';
import { linkConclusionPublications } from './conclusion-publications';
import { recoverInputQueue } from './session-input-queue';
import { interruptStoredTimings } from '../shared/turn-timing';

export interface StoreSaveOptions {
  /** Only the IDs intentionally deleted or moved by this operation. Never a blanket bypass. */
  removedSessionIds?: readonly string[];
  source?: string;
}
// Account windows normally share a Store. Also serialize recovery/temporary Stores
// for the same directory so the disk check and replacement cannot interleave.
const storeWrites = new Map<string, Promise<void>>();
const validSessionId = (id: string) => /^[a-f0-9-]{36}$/.test(id);
function sessionIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => !item || typeof item.id !== 'string' || !item.id)) throw new Error('本地 sessions.json 格式无效，原文件已保留');
  const ids = value.map(item => item.id as string);
  if (new Set(ids).size !== ids.length) throw new Error('本地 sessions.json 包含重复会话 ID，原文件已保留');
  return ids;
}
export async function readSessionIndex(root: string, required = false): Promise<AgentSession[] | undefined> {
  const file = path.join(root, 'sessions.json');
  try {
    const sessions = JSON.parse(await fs.readFile(file, 'utf8'));
    sessionIds(sessions); return sessions;
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw new Error('本地 sessions.json 无法读取，原文件已保留：' + file, { cause: error });
    const migrated = await fs.stat(path.join(root, 'migration.json')).then(() => true).catch((e: any) => { if (e.code === 'ENOENT') return false; throw e; });
    if (required || migrated) throw new Error('本地会话索引 sessions.json 缺失，已停止加载和保存，请保留账号目录后恢复：' + root);
    return undefined;
  }
}
export async function atomicJson(file: string, data: unknown, ascii = false) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const json = JSON.stringify(data, null, 2);
    await fs.writeFile(temp, ascii ? json.replace(/[\u007f-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')) : json, { mode: 0o600 });
    // Windows scanners may briefly hold the destination. Never unlink the old file to replace it.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); break; }
      catch (e: any) {
        if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
export class Store {
  private dirtySessionMessages = new Map<string, Map<string, number>>();
  private inputWrite: Promise<void> = Promise.resolve();
  private retryInputWrite = false;
  private inputSave?: { timer: ReturnType<typeof setTimeout>; promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };
  activity: import('../shared/activity-assistant').ActivityAssistantState = { baselines: {}, jobs: [] };
  saved?: () => void;
  settings: Settings = { codexRequestGuard: true, connections: [], providerPaths: { codex: '', cursor: '', claude: '' }, lastWorkspace: '', trustedServerIdentities: {} };
  sessions: AgentSession[] = []; transfers: Transfer[] = []; drafts: Draft[] = []; conclusions: ProjectConclusion[] = [];
  inputs: Record<string, SessionInput> = {};
  private sessionIndexExpected = false;
  constructor(public root: string) {}
  private enqueue(write: () => Promise<void>) {
    const resolved = path.resolve(this.root), key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const next = (storeWrites.get(key) || Promise.resolve()).catch(() => {}).then(write);
    storeWrites.set(key, next);
    const release = () => { if (storeWrites.get(key) === next) storeWrites.delete(key); };
    void next.then(release, release);
    return next;
  }
  async init() {
    await fs.mkdir(this.root, { recursive: true });
    const sessions = await readSessionIndex(this.root, this.sessionIndexExpected);
    this.sessionIndexExpected = sessions !== undefined;
    this.sessions = sessions || [];
    // The checkpoint wins after a crash between writing sessions.json and deleting an older overlay.
    for (const session of this.sessions) {
      if (!validSessionId(session.id)) continue; // Legacy and synthetic IDs use full checkpoints only.
      const file = path.join(this.sessionDir(session.id), 'delta.json');
      let delta: { version: number; revision: number; session: Omit<AgentSession, 'messages'>; messages: AgentSession['messages'] };
      try { delta = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error: any) {
        if (error.code === 'ENOENT') continue;
        throw new Error('本地会话增量无法读取，原文件已保留：' + file, { cause: error });
      }
      if (delta?.version !== 1 || !Number.isSafeInteger(delta.revision) || delta.revision < 1 || delta.session?.id !== session.id || delta.session.storageRevision !== delta.revision || !Array.isArray(delta.messages) || delta.messages.some(message => !message || typeof message.id !== 'string' || !message.id)) throw new Error('本地会话增量格式无效，原文件已保留：' + file);
      if (delta.revision <= (session.storageRevision || 0)) continue;
      const messages = [...session.messages], indexes = new Map(messages.map((message, index) => [message.id, index]));
      for (const message of delta.messages) {
        const index = indexes.get(message.id);
        if (index === undefined) { indexes.set(message.id, messages.length); messages.push(message); }
        else messages[index] = message;
      }
      Object.assign(session, delta.session, { messages });
    }
    try {
      const state = JSON.parse(await fs.readFile(path.join(this.root, 'activity-assistant.json'), 'utf8'));
      this.activity = activityStateSchema.parse(state);
    } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('本地 activity-assistant.json 无法读取'); }
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.root, 'settings.json'), 'utf8'));
      // Older builds stored the verified workspace as a time-limited lease; carry it over without the timestamps.
      if (raw && typeof raw === 'object') {
        if (raw.offlineAuthorization && !raw.workspaceSnapshot) raw.workspaceSnapshot = { profile: raw.offlineAuthorization.profile, workspaces: raw.offlineAuthorization.workspaces };
        delete raw.offlineAuthorization;
      }
      this.settings = settingsSchema.parse(raw);
      migrateProjectDirectories(this.settings);
    } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('本地设置损坏，请保留文件并检查：' + path.join(this.root, 'settings.json')); }
    for (const key of ['transfers', 'drafts', 'conclusions'] as const) {
      try { const data = JSON.parse(await fs.readFile(path.join(this.root, key + '.json'), 'utf8')); if (!Array.isArray(data)) throw new Error('Invalid array'); (this[key] as unknown[]) = data; } catch (e: any) { if (e.code !== 'ENOENT') throw new Error(`本地 ${key}.json 无法读取`); }
    }
    try { this.inputs = JSON.parse(await fs.readFile(path.join(this.root, 'inputs.json'), 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('本地 inputs.json 无法读取'); }
    this.sessions.forEach(s => { delete s.cliConnection; delete s.desktopSyncPending; delete s.desktopWaitingApproval; delete s.desktopSyncState; delete s.desktopSyncError; if (['starting', 'running', 'approval'].includes(s.status)) { s.status = s.closedAt || s.stoppedAt || s.codexDesktop || s.cursorNative || s.codexRemote ? 'idle' : 'error'; if(s.codexDesktop || s.cursorNative || s.codexRemote)s.error=undefined; if (s.status === 'error') s.error = '应用关闭时任务尚未完成，已中断；可检查已有结果后继续发送。'; } s.approvals = []; migrateSessionContext(s); });
    this.sessions.forEach(session => recoverInputQueue(session, this.inputs));
    this.sessions.forEach(interruptStoredTimings);
    for (const session of this.sessions) {
      session.directoryMode ??= 'fixed';
      if (!followsProjectDirectory(session)) delete session.directoryMove;
    }
    // MCP now belongs to configuration, not the next-message selection. Keep historic messages intact.
    for (const session of this.sessions) if (session.provider === 'cursor' && this.inputs[session.id]?.capabilities) {
      this.inputs[session.id].capabilities = this.inputs[session.id].capabilities!.filter(item => !item.id.startsWith('plugin:mcp:'));
    }
    this.drafts.forEach(d => {
      const originalPrompt=this.sessions.find(s=>s.id===d.prepareSessionId)?.messages.find(message=>message.role==='user'&&message.text.includes('preparationContractVersion:4')&&message.text.includes('只返回一个 JSON 对象：{"sentence"'));
      if(!d.mergeSources?.length&&(isProjectOrganizationDraft(d)||originalPrompt))d.organizationFormat='project-profile-v1';
      if (!d.preparationVersion && !d.submitted) {
        // Preserve the user's previous final explanation when upgrading older drafts.
        d.body = d.body || d.generatedBody || ''; d.supplement ??= '';
        if (d.binding) d.target = d.binding.project.uploadPath;
        d.preparationVersion = 1;
        if (d.body && d.generation !== 'running') { d.generation = 'ready'; d.generationError = undefined; }
      }
      if (d.generation === 'running') { d.generation = 'error'; d.generationError = '应用关闭后整理已中断，可重试整理，“给团队的补充”已保留。'; }
      else if (!d.generation) { const s = this.sessions.find(s => s.id === d.prepareSessionId); d.generation = d.generatedBody ? 'ready' : 'error'; d.generationError = d.generatedBody ? undefined : s?.error || '此前的整理未完成，可重试整理，“给团队的补充”已保留。'; }
    });
    for (const draft of this.drafts) {
      const snapshot = draft.snapshot;
      if (!snapshot?.lastMessageId || snapshot.lastMessageLength !== undefined || draft.restored) continue;
      try {
        const messages = JSON.parse(await fs.readFile(path.join(draft.inputDir, 'conversation.json'), 'utf8'));
        if (createHash('sha256').update(JSON.stringify(messages)).digest('hex') !== snapshot.conversationHash) continue;
        const last = messages.at(-1);
        if (last?.id === snapshot.lastMessageId && typeof last.text === 'string') snapshot.lastMessageLength = last.text.length;
      } catch { /* Missing legacy snapshots retain the conservative boundary replay. */ }
    }
    for (const session of this.sessions) rememberPreparationProgress(session, this.drafts);
    this.transfers.forEach(t => { if (t.status === 'running' || t.status === 'queued') { t.status = 'error'; t.error = t.phase === 'awaiting_receipt' ? '应用重启前服务器可能已接收，重试时会先核对原请求回执' : t.phase === 'streaming' ? '应用重启前传输未完成，重试会校验身份和内容后从头传输' : '应用重启前尚未完成，确认服务器连接后可重试'; } });
    await this.repairConclusionImports();
    // Preserve the exact pre-repair backup, then stamp legacy personal results
    // before login can change the active account or drafts restore their results.
    const owner = this.settings.workspaceSnapshot?.profile;
    if (owner) for (const item of this.conclusions) item.accountOwner ||= accountIdentity(owner);
    linkConclusionPublications(this.conclusions, this.drafts, this.transfers);
  }
  async repairConclusionImports() {
    const before = structuredClone({ conclusions: this.conclusions, updates: this.settings.contentUpdates || [] });
    const profile = this.settings.workspaceSnapshot?.profile;
    if (!repairConclusionImports(this.conclusions, this.settings.contentUpdates || [], profile ? accountIdentity(profile) : '')) return;
    // Keep the pre-repair records recoverable; never edit Sessions or drafts.
    const after = structuredClone({ conclusions: this.conclusions, settings: this.settings });
    await this.enqueue(async () => {
      await atomicJson(path.join(this.root, 'migrations', 'import-links-' + randomUUID() + '.json'), before);
      await atomicJson(path.join(this.root, 'conclusions.json'), after.conclusions);
      await atomicJson(path.join(this.root, 'settings.json'), after.settings);
    });
  }
  saveSettings() {
    const settings = JSON.parse(JSON.stringify(this.settings));
    return this.enqueue(() => atomicJson(path.join(this.root, 'settings.json'), settings)).then(() => { this.saved?.(); });
  }
  saveInputs() {
    // Edits are already in memory. Coalesce disk writes, not the input itself.
    if (this.inputSave) { clearTimeout(this.inputSave.timer); this.inputSave.timer = setTimeout(() => { void this.flushInputs().catch(() => {}); }, 300); return this.inputSave.promise; }
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((ok, failed) => { resolve = ok; reject = failed; });
    this.inputSave = { promise, resolve, reject, timer: setTimeout(() => { void this.flushInputs().catch(() => {}); }, 300) };
    return promise;
  }
  flushInputs(): Promise<void> {
    if (!this.inputSave && this.retryInputWrite) void this.saveInputs().catch(() => {});
    const pending = this.inputSave;
    if (!pending) return this.inputWrite;
    clearTimeout(pending.timer); this.inputSave = undefined;
    const inputs = structuredClone(this.inputs);
    const write = this.enqueue(() => atomicJson(path.join(this.root, 'inputs.json'), inputs));
    this.inputWrite = write; this.retryInputWrite = false;
    void write.then(() => { if (this.inputWrite === write) this.retryInputWrite = false; pending.resolve(); }, error => { if (this.inputWrite === write) this.retryInputWrite = true; pending.reject(error); });
    return write;
  }
  recordSessionDelta(sessionId: string, messageId?: string) {
    if (!validSessionId(sessionId)) return false;
    const session = this.sessions.find(item => item.id === sessionId);
    if (!session) return false;
    const revision = (session.storageRevision || 0) + 1;
    session.storageRevision = revision;
    let messages = this.dirtySessionMessages.get(sessionId);
    if (!messages) { messages = new Map(); this.dirtySessionMessages.set(sessionId, messages); }
    if (messageId) messages.set(messageId, revision);
    return true;
  }
  saveSessionDeltas() {
    // Include every changed message since the checkpoint so each atomic overlay stands alone.
    const deltas = [...this.dirtySessionMessages].flatMap(([id, dirty]) => {
      const session = this.sessions.find(item => item.id === id);
      if (!session) return [];
      const { messages, ...metadata } = session;
      const changed = messages.filter(message => dirty.has(message.id));
      return [{ id, value: JSON.parse(JSON.stringify({ version: 1, revision: session.storageRevision, session: metadata, messages: changed })) }];
    });
    if (!deltas.length) return Promise.resolve();
    return this.enqueue(async () => { for (const delta of deltas) await atomicJson(path.join(this.sessionDir(delta.id), 'delta.json'), delta.value); });
  }
  save(options: StoreSaveOptions = {}) {
    // Full saves (including send, account changes and shutdown) are barriers.
    // Enqueue the pending input before the ledger snapshot, never after it.
    void this.flushInputs().catch(() => {});
    const data = JSON.parse(JSON.stringify({ settings: this.settings, sessions: this.sessions, inputs: this.inputs, transfers: this.transfers, drafts: this.drafts, conclusions: this.conclusions, 'activity-assistant': this.activity }));
    const revisions = new Map((data.sessions as AgentSession[]).map(session => [session.id, session.storageRevision || 0]));
    const allowed = new Set(options.removedSessionIds || []);
    const source = options.source || new Error('Store.save 调用来源').stack || 'Store.save';
    return this.enqueue(async () => {
      const incomingIds = sessionIds(data.sessions), incoming = new Set(incomingIds);
      const previous = await readSessionIndex(this.root, this.sessionIndexExpected);
      const previousIds = (previous || []).map(session => session.id);
      const removedIds = previousIds.filter(id => !incoming.has(id));
      const unexpectedIds = removedIds.filter(id => !allowed.has(id));
      if (unexpectedIds.length) {
        const recovery = path.join(this.root, 'recovery', 'blocked-session-removal-' + randomUUID() + '.json');
        await atomicJson(recovery, { version: 1, at: new Date().toISOString(), pid: process.pid, source, previousSessions: previous, incomingIds, removedIds, unexpectedIds, allowedRemovedIds: [...allowed] });
        throw new Error(`已拦截未声明的会话移除（${unexpectedIds.length} 条），原账号资料未覆盖。恢复快照：${recovery}`);
      }
      for (const old of previous || []) {
        if (!incoming.has(old.id)) continue;
        const revision = revisions.get(old.id) || 0;
        if ((old.storageRevision || 0) > revision) throw new Error(`已拦截过期会话覆盖，原账号资料未改动：${old.id}`);
        if (!validSessionId(old.id)) continue;
        const file = path.join(this.sessionDir(old.id), 'delta.json');
        let delta: { revision?: number };
        try { delta = JSON.parse(await fs.readFile(file, 'utf8')); }
        catch (error: any) { if (error.code === 'ENOENT') continue; throw new Error('本地会话增量无法读取，原文件已保留：' + file, { cause: error }); }
        if (typeof delta.revision !== 'number' || !Number.isSafeInteger(delta.revision)) throw new Error('本地会话增量格式无效，原文件已保留：' + file);
        if (delta.revision > revision) throw new Error(`已拦截过期会话覆盖，较新的增量记录仍在：${file}`);
      }
      for (const [key, value] of Object.entries(data)) await atomicJson(path.join(this.root, key + '.json'), value);
      this.sessionIndexExpected = true;
      for (const id of new Set([...incomingIds, ...removedIds])) {
        if (!validSessionId(id)) continue;
        await fs.rm(path.join(this.sessionDir(id), 'delta.json'), { force: true }).catch(() => {});
        const dirty = this.dirtySessionMessages.get(id);
        if (!dirty) continue;
        for (const [messageId, revision] of dirty) if (revision <= (revisions.get(id) || 0)) dirty.delete(messageId);
        if (!dirty.size && (this.sessions.find(session => session.id === id)?.storageRevision || 0) <= (revisions.get(id) || 0)) this.dirtySessionMessages.delete(id);
      }
    }).then(() => { this.saved?.(); });
  }
  sessionDir(id: string) { if (!validSessionId(id)) throw new Error('无效会话 ID'); return path.join(this.root, 'sessions', id); }
  async event(id: string, event: unknown) {
    const dir = this.sessionDir(id); await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event }) + '\n', { mode: 0o600 });
  }
}
