import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { accountIdentity, accountRecordsSchema, type AccountRecords, type AccountSnapshot, type AccountSyncState } from '../shared/account-data';
import type { ConnectionProfile, Draft, ProjectConclusion } from '../shared/types';
import { Store, atomicJson } from './store';
import type { SharedFiles } from './shared-files';
import { contentAttachmentSchema } from '../shared/content';
import { hashFile } from './artifacts';
import { safeFilename } from './paths';
import { rememberPreparationProgress } from '../shared/preparation-progress';
import { resultPreferencesSchema } from '../shared/result-rules';

const canonical = (value: any): string => JSON.stringify(value === undefined ? null : value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
export function mergeAccountRecords(base: AccountRecords, local: AccountRecords, remote: AccountRecords, choices: Record<string, { local: string; remote: string; choice: 'local' | 'remote' }> = {}) {
  const records: AccountRecords = {}, conflicts: NonNullable<AccountSyncState['conflicts']> = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const b = base[key] ?? null, l = local[key] ?? null, r = remote[key] ?? null;
    if (canonical(l) === canonical(r) || canonical(b) === canonical(r)) records[key] = l;
    else if (canonical(b) === canonical(l)) records[key] = r;
    else if (key.startsWith('update:') && l && r) records[key] = { ...r, ...l, readAt: l.readAt || r.readAt, unavailableAt: l.unavailableAt || r.unavailableAt, actions: [...new Map([...(r.actions || []), ...(l.actions || [])].map((a: unknown) => [canonical(a), a])).values()] };
    else if (key.startsWith('dismissed:')) records[key] = !!(l || r);
    else if (key.startsWith('seen:') && l && r) records[key] = { ...r, ...l };
    else {
      const resolution = choices[key];
      if (resolution?.local === canonical(l) && resolution.remote === canonical(r)) records[key] = resolution.choice === 'local' ? l : r;
      else { records[key] = l; conflicts.push({ key, local: l, remote: r }); }
    }
  }
  return { records, conflicts };
}

export class AccountSync {
  state: AccountSyncState = { status: 'offline' };
  private profile?: ConnectionProfile;
  private base: AccountRecords = {};
  private timer?: NodeJS.Timeout;
  private polling?: NodeJS.Timeout;
  private running?: Promise<void>;
  private applying = false;
  private stopped = false;
  private generation = 0;
  private choices: Record<string, { local: string; remote: string; choice: 'local' | 'remote' }> = {};
  constructor(private store: Store, private remote: SharedFiles, private changed: () => void) { store.saved = () => this.schedule(); }
  private file(profile: ConnectionProfile) { return path.join(this.store.root, 'accounts', createHash('sha256').update(accountIdentity(profile)).digest('hex') + '.json'); }
  private owns(draft: Draft, profile: ConnectionProfile) { return !!draft.binding && accountIdentity(draft.binding) === accountIdentity(profile); }
  private collect(profile = this.profile!): AccountRecords {
    const records: AccountRecords = {}, key = accountIdentity(profile), projectIds = new Set(profile.projects.map(project => project.id));
    if (this.store.settings.resultPreferences?.[key]) records['result-rules:preferences'] = this.store.settings.resultPreferences[key];
    // Losing group access must never mean deleting the account's existing private records.
    for (const [id, value] of Object.entries(this.base)) if (id.startsWith('draft:') && value && !projectIds.has(value.projectId)) records[id] = value;
    for (const item of this.store.conclusions) if (item.accountOwner === key) records['material:' + item.id] = { ...item, sources: item.sources.map(source => ({ ...source, path: source.path && !/^[A-Za-z]:|^file:/.test(source.path) ? source.path : undefined })) };
    for (const draft of this.store.drafts) if (this.owns(draft, profile)) {
      const selectedFiles = new Set(draft.artifacts?.flatMap(item => (item.attachments || []).filter(entry => entry.selected).map(entry => entry.fileId)));
      // Account restoration contains reviewed results, never conversations, CLI state or local code paths.
      records['draft:' + draft.id] = { id: draft.id, sessionId: draft.sessionId, sourceSessionTitle: this.store.sessions.find(session => session.id === draft.sessionId)?.title || draft.sourceSessionTitle, projectId: draft.binding!.project.id, title: draft.title, titleAlias: draft.titleAlias, body: draft.body, supplement: draft.supplement, artifacts: draft.artifacts?.map(item => ({ ...item, evidenceIds: undefined, attachments: item.attachments?.filter(entry => entry.selected), submitted: item.submitted ? 'restored' : undefined })), files: draft.files.filter(file => selectedFiles.has(file.id)).map(file => ({ id: file.id, name: file.name, sha256: file.sha256, size: file.size, fetchedAt: file.fetchedAt })), generation: draft.generation === 'running' ? 'error' : draft.generation, createdAt: draft.createdAt, generationFinishedAt: draft.generationFinishedAt, preparationVersion: draft.preparationVersion, emptyResult: draft.emptyResult, resultRules: draft.resultRules, resultCategory: draft.resultCategory, resultSourceDetails: draft.resultSourceDetails, mergeProjectId: draft.mergeProjectId, conclusionMergeProjectId: draft.conclusionMergeProjectId, conclusionMergeInstruction: draft.conclusionMergeInstruction, mergeSources: draft.mergeSources, mergeCompletedAt: draft.mergeCompletedAt, mergeResultId: draft.mergeResultId, mergeResultPath: draft.mergeResultPath, submitted: draft.submitted ? 'restored' : undefined };
    }
    for (const [id, alias] of Object.entries(this.store.settings.contentAliases || {})) records['alias:' + id] = alias;
    const prefix = `${profile.id}:${profile.username}:`;
    for (const update of this.store.settings.contentUpdates || []) if (update.eventId.startsWith(prefix)) { const id = update.eventId.slice(prefix.length); records['update:' + id] = { ...update, eventId: id }; }
    for (const [id, seen] of Object.entries(this.store.settings.contentSeen || {})) if (id.startsWith(prefix)) records['seen:' + id.slice(prefix.length)] = seen;
    for (const id of this.store.settings.dismissedContentUpdateIds || []) if (id.startsWith(prefix)) records['dismissed:' + id.slice(prefix.length)] = true;
    return structuredClone(records);
  }
  private apply(records: AccountRecords, profile: ConnectionProfile) {
    const owner = accountIdentity(profile), projectIds = new Set(profile.projects.map(project => project.id));
    const preferences = records['result-rules:preferences'];
    if (preferences) (this.store.settings.resultPreferences ||= {})[owner] = resultPreferencesSchema.parse(preferences);
    else if (preferences === null && this.store.settings.resultPreferences) delete this.store.settings.resultPreferences[owner];
    // A deletion received from another computer must not erase local progress.
    for (const session of this.store.sessions) rememberPreparationProgress(session, this.store.drafts);
    const materials: ProjectConclusion[] = [];
    for (const [key, value] of Object.entries(records)) {
      if (key.startsWith('material:') && value && typeof value.projectId === 'string' && value.id === key.slice(9) && typeof value.title === 'string' && typeof value.content === 'string' && Array.isArray(value.sources)) materials.push({ ...value, accountOwner: owner });
      if (key.startsWith('draft:') && value && projectIds.has(value.projectId) && /^[a-f0-9-]{36}$/.test(value.id) && value.id === key.slice(6) && typeof value.body === 'string') {
        const project = profile.projects.find(project => project.id === value.projectId)!;
        const existing = this.store.drafts.find(draft => draft.id === value.id), inputDir = path.join(this.store.root, 'drafts', value.id, 'input');
        const restored: Draft = { ...value, files: (value.files || []).map((file: any) => ({ ...file, localPath: this.blobPath(file), sourcePath: '账号附件：' + file.name })), inputDir, outputPath: path.join(inputDir, '..', 'draft.md'), restored: true, binding: { connectionId: profile.id, host: profile.host, port: profile.port, username: profile.username, fingerprint: profile.fingerprint, project }, generation: value.generation === 'running' ? 'error' : value.generation };
        if (!existing) this.store.drafts.push(restored);
        else if (!['running'].includes(existing.generation || '')) {
          const artifacts = restored.artifacts?.map(item => { const prior = existing.artifacts?.find(prior => prior.id === item.id); return { ...item, evidenceIds: prior?.evidenceIds || item.evidenceIds, submitted: prior?.submitted || item.submitted, attachments: [...(item.attachments || []), ...(prior?.attachments || []).filter(entry => !entry.selected && !item.attachments?.some(other => other.fileId === entry.fileId))] }; });
          Object.assign(existing, { title: value.title, titleAlias: value.titleAlias, body: value.body, supplement: value.supplement, artifacts, emptyResult: value.emptyResult, resultRules: value.resultRules, resultCategory: value.resultCategory, resultSourceDetails: value.resultSourceDetails });
        }
      }
    }
    this.store.conclusions = [...this.store.conclusions.filter(item => item.accountOwner !== owner), ...materials];
    const prefix = `${profile.id}:${profile.username}:`;
    this.store.settings.contentAliases = Object.fromEntries(Object.entries(records).filter(([key, value]) => key.startsWith('alias:') && typeof value === 'string').map(([key, value]) => [key.slice(6), value]));
    this.store.settings.contentUpdates = Object.entries(records).filter(([key, value]) => key.startsWith('update:') && value).map(([key, value]) => ({ ...value, eventId: prefix + key.slice(7) }));
    this.store.settings.contentSeen = Object.fromEntries(Object.entries(records).filter(([key, value]) => key.startsWith('seen:') && value).map(([key, value]) => [prefix + key.slice(5), value]));
    this.store.settings.dismissedContentUpdateIds = Object.entries(records).filter(([key, value]) => key.startsWith('dismissed:') && value).map(([key]) => prefix + key.slice(10));
    this.store.drafts = this.store.drafts.filter(draft => !this.owns(draft, profile) || records['draft:' + draft.id] !== null || draft.generation === 'running');
  }
  private blobPath(file: { name: string; sha256: string; size: number }) { contentAttachmentSchema.parse({ ...file, path: '' }); return path.join(this.store.root, 'accounts', 'files', createHash('sha256').update(accountIdentity(this.profile!)).digest('hex'), file.sha256, safeFilename(file.name)); }
  private async files(records: AccountRecords, remoteRecords: AccountRecords, profile: ConnectionProfile, valid: () => void) {
    const known = new Set(Object.entries(remoteRecords).filter(([key]) => key.startsWith('draft:')).flatMap(([, value]) => value?.files || []).map((file: any) => file.sha256));
    const done = new Set<string>();
    for (const [key, value] of Object.entries(records)) if (key.startsWith('draft:') && value) for (const file of value.files || []) {
      const local = this.blobPath(file); if (done.has(local)) continue; done.add(local);
      const source = this.store.drafts.filter(draft => this.owns(draft, profile)).flatMap(draft => draft.files).find(source => source.sha256 === file.sha256);
      if (!known.has(file.sha256)) {
        if (!source || await hashFile(source.localPath) !== file.sha256) throw new Error('待同步附件不存在或已变化：' + file.name);
        valid(); await this.remote.accountFile(file.sha256, source.localPath, true); valid(); known.add(file.sha256);
      }
      if (await hashFile(local).catch(() => '') === file.sha256) continue;
      await fs.mkdir(path.dirname(local), { recursive: true });
      const temporary = local + '.' + randomUUID() + '.partial';
      try {
        if (source && await hashFile(source.localPath).catch(() => '') === file.sha256) await fs.copyFile(source.localPath, temporary, fs.constants.COPYFILE_EXCL);
        else { valid(); await this.remote.accountFile(file.sha256, temporary, false); valid(); }
        await fs.rename(temporary, local);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    }
  }
  async activate(profile: ConnectionProfile, previous?: ConnectionProfile) {
    this.generation++; clearTimeout(this.timer); clearInterval(this.polling); this.stopped = false;
    await this.running;
    if (previous) {
      const previousOwner = accountIdentity(previous);
      for (const item of this.store.conclusions) (item as any).accountOwner ||= previousOwner;
      if (previousOwner !== accountIdentity(profile)) {
        await atomicJson(this.file(previous) + '.pending', this.collect(previous));
        this.store.settings.contentAliases = {}; this.store.settings.contentSeen = {}; this.store.settings.contentUpdates = []; this.store.settings.dismissedContentUpdateIds = [];
      }
    }
    this.profile = structuredClone(profile); this.base = {}; this.choices = {};
    for (const item of this.store.conclusions) (item as any).accountOwner ||= accountIdentity(profile);
    try { this.base = JSON.parse(await fs.readFile(this.file(profile), 'utf8')).records; } catch (error: any) { if (error.code !== 'ENOENT') { this.state = { status: 'error', detail: '账号同步缓存无法读取，已保留本机资料' }; this.changed(); return; } }
    if (previous && accountIdentity(previous) !== accountIdentity(profile)) {
      try { this.apply(JSON.parse(await fs.readFile(this.file(profile) + '.pending', 'utf8')), profile); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    await this.sync();
    this.polling = setInterval(() => void this.sync(), 60000); this.polling.unref();
  }
  schedule() {
    if (this.applying || this.stopped || !this.profile) return;
    if (this.remote.profile && accountIdentity(this.remote.profile) === accountIdentity(this.profile)) this.profile = structuredClone(this.remote.profile);
    for (const item of this.store.conclusions) (item as any).accountOwner ||= accountIdentity(this.profile);
    if (canonical(this.collect()) === canonical(Object.fromEntries(Object.entries(this.base).filter(([, value]) => value != null)))) return;
    if (!this.remote.connected) { this.state = { ...this.state, status: 'offline', detail: '更改已保存在本机，登录后同步' }; this.changed(); return; }
    clearTimeout(this.timer); this.state = { ...this.state, status: 'pending' }; this.changed(); this.timer = setTimeout(() => void this.sync(), 1500); this.timer.unref();
  }
  resolve(key: string, choice: 'local' | 'remote') {
    const conflict = this.state.conflicts?.find(item => item.key === key); if (!conflict) throw new Error('同步冲突已变化，请刷新');
    this.choices[key] = { local: canonical(conflict.local), remote: canonical(conflict.remote), choice }; return this.sync();
  }
  sync(): Promise<void> {
    if (this.running) return this.running;
    if (!this.profile || this.stopped || !this.remote.connected) return Promise.resolve();
    if (this.remote.profile && accountIdentity(this.remote.profile) === accountIdentity(this.profile)) this.profile = structuredClone(this.remote.profile);
    const profile = this.profile, generation = this.generation;
    const valid = () => { if (generation !== this.generation || !this.remote.profile || accountIdentity(this.remote.profile) !== accountIdentity(profile)) throw new Error('账号已改变，未应用同步结果'); };
    this.running = (async () => {
      this.state = { ...this.state, status: 'syncing' }; this.changed();
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const snapshot = await this.remote.accountData(); valid();
          accountRecordsSchema.parse(snapshot.records);
          const before = this.collect(), merged = mergeAccountRecords(this.base, before, snapshot.records, this.choices);
          if (merged.conflicts.length) { this.state = { ...this.state, status: 'conflict', conflicts: merged.conflicts, detail: '两台电脑修改了同一份资料，请选择保留版本' }; return; }
          await this.files(merged.records, snapshot.records, profile, valid); valid();
          const result = canonical(merged.records) === canonical(snapshot.records) ? snapshot : await this.remote.accountData({ revision: snapshot.revision, records: accountRecordsSchema.parse(merged.records) }); valid();
          if (result.conflict) continue;
          // Edits made while the request was in flight remain pending, never overwritten.
          const after = mergeAccountRecords(before, this.collect(), result.records);
          if (after.conflicts.length) { this.state = { status: 'pending', detail: '同步期间有新修改，稍后继续' }; return; }
          this.applying = true;
          try { this.apply(after.records, profile); await this.store.repairConclusionImports(); this.base = result.records; await this.store.save(); await atomicJson(this.file(profile), result); }
          finally { this.applying = false; }
          this.state = { status: 'synced', syncedAt: new Date().toISOString() }; this.choices = {}; return;
        }
        throw new Error('另一台电脑正在保存，稍后重试');
      } catch (error: any) { if (generation === this.generation) this.state = { ...this.state, status: 'error', detail: `账号资料尚未同步：${error.message}。本机内容已保留；旧服务器需更新存储服务。` }; }
      finally { this.changed(); }
    })().finally(() => { this.running = undefined; });
    return this.running;
  }
  async close() { clearTimeout(this.timer); clearInterval(this.polling); await Promise.race([this.sync(), new Promise<void>(resolve => { const timer = setTimeout(resolve, 8000); timer.unref(); })]); this.stopped = true; this.generation++; }
}
