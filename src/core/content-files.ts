import { assertTodoMerge, canonicalCategory, resultCategory, resultDefaultStatus, sameResultCategory, validateResultStatus } from '../shared/result-model';
import { acceptedSubmission, type SubmissionDestination } from '../shared/submission';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { diskPath, registryLock } from './local-space';
import { atomicJson } from './store';
import { hashFile } from './artifacts';
import { assertRemote, childRemote } from './paths';
import { attachmentPath, mergeAttachments } from '../shared/attachments';
import { contentEditSchema, contentMergeSchema, contentMetadataSchema, contributionCategoryFields, contributionCategoryInfo, type ContentEdit, type ContentMerge, type ContentMetadata, type SharedContent } from '../shared/content';
import type { RemoteBinding } from '../shared/types';
import { inspectContentFiles } from './content-files-state';
import { assertContentReadable } from '../shared/content-files-state';

// Local permission stub. The Linux equivalent is enforced by the root-owned file worker.
export class ContentFiles {
  constructor(private root: string, private authorize: (binding: RemoteBinding) => Promise<{ username: string; admin: boolean; destination?: SubmissionDestination }>) {}
  private index(binding: RemoteBinding) { return diskPath(this.root, childRemote(binding.project.remoteRoot, '.workbench-content.json'), true); }
  private historyIndex(binding: RemoteBinding) { return diskPath(this.root, childRemote(binding.project.remoteRoot, '.workbench-content-history.json'), true); }
  private async read(binding: RemoteBinding): Promise<SharedContent[]> { try { return JSON.parse(await fs.readFile(await this.index(binding), 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; } }
  private async historyRead(binding: RemoteBinding): Promise<SharedContent[]> { try { return JSON.parse(await fs.readFile(await this.historyIndex(binding), 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; } }
  private async tasks(binding: RemoteBinding): Promise<import('../shared/assignments').ProjectAssignment[]> {
    try { return JSON.parse(await fs.readFile(await diskPath(this.root, '/.workbench-local/assignments/' + binding.project.id + '.json', true), 'utf8')); }
    catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  }
  private async linked(binding: RemoteBinding, id: string) { return (await this.tasks(binding)).filter(task => !task.purgedAt && task.references.some(ref => ref.id === id)); }
  async list(binding: RemoteBinding) {
    await this.authorize(binding);
    try { await fs.stat(await this.index(binding)); }
    catch (error: any) { if (error.code === 'ENOENT') throw new Error('团队成果登记文件缺失，暂无法确认成果状态，请联系组管理员'); throw error; }
    const actor = await this.authorize(binding), items = await this.read(binding), tasks = await this.tasks(binding);
    const checked = await this.inspect(binding, items);
    await this.authorize(binding);
    return checked.map(item => ({ ...item, linkedAssignments: resultCategory(item) === 'todo' ? tasks.filter(task => !task.purgedAt && task.references.some(ref => ref.id === item.id)).map(({ id, title, status, assignee }) => actor.admin || actor.username === assignee ? { id, title, status, assignee } : { id, title: '关联任务', status: 'linked', assignee: '' }) : [] }));
  }
  private inspect(binding: RemoteBinding, items: SharedContent[]) {
    return inspectContentFiles(items, async target => {
      try { assertRemote(binding.project.remoteRoot, target); }
      catch { return 'unverified'; }
      try { return (await fs.lstat(await diskPath(this.root, target, true))).isFile() ? 'ok' : 'unverified'; }
      catch (error: any) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return 'missing';
        if (['EACCES', 'EPERM'].includes(error.code)) return 'unverified';
        throw error;
      }
    });
  }
  async history(binding: RemoteBinding, id?: string, revision?: number, summary = false) { await this.authorize(binding); const items = await this.historyRead(binding); return items.filter(item => (!id || item.id === id) && (!revision || item.revision === revision)).map(item => summary ? { ...item, description: '', fields: undefined, attachments: undefined, sourceDetails: undefined } : item); }
  async merge(binding: RemoteBinding, input: ContentMerge) {
    const change = contentMergeSchema.parse(input);
    return registryLock(this.root, async () => {
      const actor = await this.authorize(binding); if (!actor.admin) throw new Error('只有本组组管理员可以整理团队成果');
      const items = await this.read(binding), history = await this.historyRead(binding);
      const prior = change.requestId && items.find(item => item.mergeRequestId === change.requestId);
      if (prior) {
        if (new Set(prior.replaces?.map(ref => ref.id) || []).size !== change.replaceIds.length || change.replaceIds.some(id => !prior.replaces?.some(ref => ref.id === id))) throw new Error('这次整理已用另一组替代来源保存，请刷新');
        return prior;
      }
      const sources = change.sources.map(ref => {
        const item = items.find(value => value.id === ref.id);
        if (!item || item.revision !== ref.revision || item.kind !== 'contribution') throw new Error('待整理成果已更新或移出当前列表，请刷新');
        return item;
      });
      for (const source of await this.inspect(binding, sources)) assertContentReadable(source, true);
      const category = sameResultCategory(sources, change.category);
      assertTodoMerge(sources, change.confirmDuplicateTodos);
      if (category === 'todo' && (await Promise.all(sources.map(source => this.linked(binding, source.id)))).some(tasks => tasks.length)) throw new Error('已关联项目任务的待办不能合并，请在项目任务中处理');
      for (const attachment of change.attachments || []) {
        if (attachment.path !== attachmentPath(binding, attachment.sha256)) throw new Error('附件不属于当前提交账号');
        const stored = await diskPath(this.root, attachment.path), stat = await fs.lstat(stored);
        if (!stat.isFile() || stat.size !== attachment.size || await hashFile(stored) !== attachment.sha256) throw new Error('附件尚未上传成功或校验失败');
      }
      const attachments = mergeAttachments([...sources, { attachments: change.attachments }]), now = new Date().toISOString(), id = randomUUID();
      const target = assertRemote(binding.project.remoteRoot, path.posix.join(binding.project.remoteRoot, 'curated', contributionCategoryInfo[category].folder, `${id}-v1.md`));
      const file = await diskPath(this.root, target, true), body = `# ${change.title}\n\n${change.description}`;
      const refs = sources.map(source => ({ scope: 'team' as const, projectId: binding.project.id, id: source.id, version: source.revision }));
      const replacedSources = sources.filter(source => change.replaceIds.includes(source.id));
      const submission = acceptedSubmission(undefined, binding, actor.username, actor.destination, sources.map(source => ({ kind: 'team_result' as const, id: source.id, title: source.title, version: source.revision, projectId: binding.project.id, author: source.author })));
      const result: SharedContent = { submission, id, title: change.title, description: change.description, kind: 'contribution', category, resultStatus: resultDefaultStatus(category), sourceDetails: change.sourceDetails, sourceSessionTitle: change.sourceSessionTitle, mergeRequestId: change.requestId, path: target, author: actor.username, revision: 1, state: 'curated', createdAt: now, updatedAt: now, updatedBy: actor.username, sha256: createHash('sha256').update(body).digest('hex'), size: Buffer.byteLength(body), attachments, derivedFrom: refs, replaces: refs.filter(ref => change.replaceIds.includes(ref.id)), sources: sources.map(source => source.id), provenance: sources.map(source => ({ id: source.id, revision: source.revision, title: source.title, author: source.author, updatedAt: source.updatedAt })) };
      const archived = replacedSources.map(source => ({ ...structuredClone(source), supersededBy: { scope: 'team' as const, projectId: binding.project.id, id, version: 1 }, supersededAt: now }));
      await this.authorize(binding);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body, { flag: 'wx' });
      try {
        await atomicJson(await this.historyIndex(binding), [...archived, ...history]);
        try { await atomicJson(await this.index(binding), [result, ...items.filter(item => !replacedSources.includes(item))]); }
        catch (error) { await atomicJson(await this.historyIndex(binding), history); throw error; }
      } catch (error) { await fs.rm(file, { force: true }); throw error; }
      return result;
    });
  }
  async publishAttachment(binding: RemoteBinding, source: string, hash: string) {
    return registryLock(this.root, async () => {
      await this.authorize(binding);
      const target = attachmentPath(binding, hash), file = await diskPath(this.root, target, true);
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.size > 2 * 1024 ** 3 || await hashFile(source) !== hash) throw new Error('附件快照校验失败');
      await fs.mkdir(path.dirname(file), { recursive: true });
      try { await fs.copyFile(source, file, fs.constants.COPYFILE_EXCL); }
      catch (error: any) { if (error.code !== 'EEXIST' || await hashFile(file) !== hash) throw error; }
      return { path: target, sha256: hash, size: stat.size };
    });
  }
  async adopt(binding: RemoteBinding, target: string) {
    return registryLock(this.root, async () => {
      const actor = await this.authorize(binding); if (!actor.admin) throw new Error('只有组管理员可以纳入已有文件');
      target = assertRemote(binding.project.remoteRoot, target); const relative = path.posix.relative(binding.project.remoteRoot, target);
      if (relative.split('/').some(p => p.startsWith('.')) || relative === '项目说明.md') throw new Error('管理文件请使用对应入口维护');
      const file = await diskPath(this.root, target), stat = await fs.lstat(file); if (!stat.isFile()) throw new Error('请选择普通文件');
      const items = await this.read(binding), existing = items.find(i => i.path === target); if (existing) return existing;
      const now = new Date().toISOString(), item: SharedContent = { id: randomUUID(), title: path.posix.basename(target), description: /\.(md|txt)$/i.test(target) && stat.size <= 512 * 1024 ? await fs.readFile(file, 'utf8') : '从已有公共文件纳入，由组管理员统一维护。', kind: 'file', path: target, author: /^(submissions|trajectories)\/[^/]+\//.test(relative) ? relative.split('/')[1] : '历史文件', state: 'curated', revision: 1, createdAt: stat.mtime.toISOString(), updatedAt: now, updatedBy: actor.username, size: stat.size, sha256: await hashFile(file) };
      items.unshift(item); await atomicJson(await this.index(binding), items); return item;
    });
  }
  async publish(binding: RemoteBinding, source: string, target: string, raw?: ContentMetadata, expectedHash?: string) {
    return registryLock(this.root, async () => {
      const actor = await this.authorize(binding), project = binding.project;
      const metadata = contentMetadataSchema.parse(raw || { title: path.posix.basename(target), kind: target.includes('/trajectories/') ? 'trajectory' : 'file' });
      validateResultStatus(metadata.category, metadata.resultStatus);
      if (metadata.category) metadata.resultStatus ??= resultDefaultStatus(metadata.category);
      for (const attachment of metadata.attachments || []) {
        if (metadata.kind !== 'contribution' || attachment.path !== attachmentPath(binding, attachment.sha256)) throw new Error('附件不属于当前提交账号');
        const file = await diskPath(this.root, attachment.path), stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size !== attachment.size || await hashFile(file) !== attachment.sha256) throw new Error('附件尚未上传成功或校验失败');
      }
      target = assertRemote(project.remoteRoot, target);
      const relative = target.slice(project.remoteRoot.length + 1).split('/');
      if (relative.some(p => p.startsWith('.')) || !relative.at(-1)) throw new Error('不可写入管理记录');
      if (!actor.admin && ![project.uploadPath, project.historyPath].some(p => target.startsWith(p + '/'))) throw new Error('只能上传到自己的公共提交目录');
      if (metadata.kind === 'contribution' && metadata.category) {
        const expected = path.posix.join(project.uploadPath, contributionCategoryInfo[metadata.category].folder);
        if (path.posix.dirname(target) !== expected) throw new Error('成果类别与上传目录不一致');
        if (Object.keys(metadata.fields || {}).some(key => !contributionCategoryFields[metadata.category!].includes(key))) throw new Error('成果字段与类别不一致');
      }
      if (!(await fs.lstat(source)).isFile()) throw new Error('只能上传普通文件，不支持符号链接');
      const sha256 = await hashFile(source); if (expectedHash && expectedHash !== sha256) throw new Error('上传快照已改变，请重新提交');
      const receiptFile = await diskPath(this.root, '/.workbench-local/upload-receipts.json', true);
      let receipts: Record<string, SharedContent> = {}; try { receipts = JSON.parse(await fs.readFile(receiptFile, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      const requestKey = createHash('sha256').update(JSON.stringify([binding.project.id, actor.username, target, sha256])).digest('hex');
      if (receipts[requestKey]) return receipts[requestKey];
      const items = await this.read(binding), existing = items.find(i => i.path === target);
      if (existing) {
        if (existing.sha256 === sha256 && existing.author === actor.username) return existing;
        throw new Error('目标已有内容，请从团队项目成果库中修改，并核对最新版本');
      }
      const submission = acceptedSubmission(metadata.submission, binding, actor.username, actor.destination, metadata.submission?.sources || (metadata.sourceSessionTitle ? [{ kind: 'session', id: metadata.sourceSessionId, title: metadata.sourceSessionTitle, snapshotHash: metadata.snapshotHash }] : undefined));
      for (const ref of submission.sources.filter(source => source.kind === 'team_result')) {
        const source = [...items, ...await this.historyRead(binding)].find(item => item.id === ref.id && item.revision === ref.version);
        if (ref.projectId !== project.id || !source) throw new Error('提交的团队来源版本不存在');
        Object.assign(ref, { title: source.title, author: source.author });
      }
      const file = await diskPath(this.root, target, true); await fs.mkdir(path.dirname(file), { recursive: true });
      try { await fs.copyFile(source, file, fs.constants.COPYFILE_EXCL); }
      catch (e: any) { if (e.code !== 'EEXIST' || await hashFile(file) !== sha256) throw e; }
      const now = new Date().toISOString(), item: SharedContent = { ...metadata, submission, id: randomUUID(), path: target, author: actor.username, revision: 1, state: 'submitted', createdAt: now, updatedAt: now, updatedBy: actor.username, sha256, size: (await fs.stat(file)).size };
      items.unshift(item); await atomicJson(await this.index(binding), items); receipts[requestKey] = item; await atomicJson(receiptFile, receipts); return item;
    });
  }
  async edit(binding: RemoteBinding, input: ContentEdit, replacement?: string) {
    const change = contentEditSchema.parse(input);
    return registryLock(this.root, async () => {
      const actor = await this.authorize(binding), items = await this.read(binding), item = items.find(i => i.id === change.id);
      if (!item || item.revision !== change.revision) throw new Error('内容已更新或删除，请刷新后再操作；本地编辑仍保留');
      if (!actor.admin && (item.author !== actor.username || item.state === 'curated')) throw new Error('只能修改自己尚未被组管理员整理的提交；可另提补充');
      if (!actor.admin && (change.curate || change.merge.length)) throw new Error('只有本组组管理员可以整理或合并内容');
      const category = change.category || item.category;
      validateResultStatus(category, change.resultStatus);
      if (resultCategory(item) === 'todo' && (change.resultStatus !== undefined || change.category && canonicalCategory(change.category) !== resultCategory(item)) && (await this.linked(binding, item.id)).length) throw new Error('已关联项目任务，请在项目任务中提交验收或调整状态');
      if (change.merge.length) throw new Error('旧版合并入口已停用，请更新客户端后重新整理；原成果保持不变');
      if (new Set(change.merge.map(m => m.id)).size !== change.merge.length) throw new Error('不能重复合并同一成果');
      const merged = change.merge.map(m => { const source = items.find(i => i.id === m.id); if (!source || source.id === item.id || source.revision !== m.revision || source.kind !== 'contribution') throw new Error('待合并内容已改变或不是文字成果，请刷新'); return source; });
      const history = await this.historyRead(binding), previous = structuredClone(item);
      const attachments = mergeAttachments([item, ...merged]);
      const provenance = [...(item.provenance || []), { id: item.id, revision: item.revision, title: item.title, author: item.author, updatedAt: item.updatedAt }, ...merged.flatMap(source => [...(source.provenance || []), { id: source.id, revision: source.revision, title: source.title, author: source.author, updatedAt: source.updatedAt }])].filter((source, index, all) => all.findIndex(value => value.id === source.id && value.revision === source.revision) === index);
      const oldPaths = [item, ...merged].map(i => i.path);
      if (change.action === 'save' && item.kind !== 'contribution') {
        if (!change.title || change.description === undefined || merged.length) throw new Error('文件说明不能为空，文件不能按文字成果合并');
        if (replacement) {
          if (!(await fs.lstat(replacement)).isFile()) throw new Error('只能替换为普通文件');
          const ext = path.extname(replacement); if (!/^\.[a-zA-Z0-9]{1,20}$/.test(ext) && ext !== '') throw new Error('文件扩展名不合法');
          const target = binding.project.remoteRoot + '/' + (actor.admin ? 'curated' : 'submissions/' + actor.username) + '/' + item.id + '-v' + (item.revision + 1) + ext;
          const file = await diskPath(this.root, target, true); await fs.mkdir(path.dirname(file), { recursive: true });
          const temp = file + '.' + randomUUID() + '.tmp'; try { await fs.copyFile(replacement, temp, fs.constants.COPYFILE_EXCL); await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }); }
          Object.assign(item, { path: target, sha256: await hashFile(file), size: (await fs.stat(file)).size });
        }
        Object.assign(item, { title: change.title, description: change.description, revision: item.revision + 1, state: actor.admin ? 'curated' : item.state, updatedAt: new Date().toISOString(), updatedBy: actor.username });
      } else if (change.action === 'save') {
        if (!change.title || change.description === undefined) throw new Error('请填写成果标题和内容');
        const revision = item.revision + 1, curated = actor.admin || item.state === 'curated';
        const target = assertRemote(binding.project.remoteRoot, path.posix.join(binding.project.remoteRoot, curated ? 'curated' : 'submissions/' + actor.username, ...(category ? [contributionCategoryInfo[category].folder] : []), `${item.id}-v${revision}.md`));
        const file = await diskPath(this.root, target, true); await fs.mkdir(path.dirname(file), { recursive: true });
        const temp = file + '.' + randomUUID() + '.tmp';
        try { await fs.writeFile(temp, `# ${change.title}\n\n${change.repoUrl ? change.repoUrl + '\n\n' : ''}${change.description}`, { flag: 'wx' }); await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }); }
        Object.assign(item, { title: change.title, description: change.description, repoUrl: change.repoUrl, ...(change.category ? { category: change.category, ...(change.category !== item.category ? { fields: {} } : {}) } : {}), resultStatus: canonicalCategory(category) !== resultCategory(previous) ? resultDefaultStatus(category) : change.resultStatus ?? item.resultStatus ?? resultDefaultStatus(category), ...(change.resultOwner !== undefined ? { resultOwner: change.resultOwner } : {}), ...(change.sourceDetails !== undefined ? { sourceDetails: change.sourceDetails } : {}), ...(change.sourceSessionTitle ? { sourceSessionTitle: change.sourceSessionTitle } : {}), path: target, revision, state: curated ? 'curated' : 'submitted', updatedAt: new Date().toISOString(), updatedBy: actor.username, sha256: await hashFile(file), size: (await fs.stat(file)).size, sources: [...new Set([...(item.sources || []), ...merged.map(i => i.id)])], ...(merged.length ? { provenance } : {}) });
      }
      await this.authorize(binding);
      if (change.action === 'save' && attachments.length) item.attachments = attachments;
      const tombstone = { ...previous, description: '', attachments: undefined, fields: undefined, sourceDetails: undefined, deletedAt: new Date().toISOString(), deletedBy: actor.username };
      const archived = [change.action === 'delete' ? tombstone : previous, ...merged.map(source => ({ ...structuredClone(source), supersededBy: { scope: 'team' as const, projectId: binding.project.id, id: item.id, version: item.revision }, supersededAt: new Date().toISOString() }))];
      const remaining = items.filter(i => !merged.includes(i) && (change.action !== 'delete' || i.id !== item.id));
      const nextHistory = [...archived, ...history.filter(entry => change.action !== 'delete' || entry.id !== item.id)];
      await atomicJson(await this.historyIndex(binding), nextHistory);
      try { await atomicJson(await this.index(binding), remaining); }
      catch (error) { await atomicJson(await this.historyIndex(binding), history); throw error; }
      const recordedFiles = (entry: { path?: string; attachments?: { path: string }[] }) => [entry.path, ...(entry.attachments || []).map(file => file.path)].filter((value): value is string => !!value);
      const retained = new Set([...remaining, ...nextHistory.filter(entry => !entry.deletedAt)].flatMap(recordedFiles));
      const retainedBodies = change.action === 'delete' ? retained : new Set(remaining.flatMap(recordedFiles));
      for (const target of oldPaths.filter(target => (change.action === 'delete' || target !== item.path) && !retainedBodies.has(target))) await fs.unlink(await diskPath(this.root, target)).catch(() => {});
      if (change.action === 'delete') {
        const projectPrefix = binding.project.remoteRoot + '/';
        for (const target of [...new Set([previous, ...history].filter(entry => entry.id === item.id).flatMap(recordedFiles))]) {
          if (retained.has(target)) continue;
          if (!target.startsWith(projectPrefix)) continue;
          if (!target.includes(item.id) && !target.includes('/.workbench-attachments/') && !target.startsWith(projectPrefix + 'submissions/') && !target.startsWith(projectPrefix + 'curated/')) continue;
          await fs.unlink(await diskPath(this.root, target, true)).catch(() => {});
        }
        const receiptFile = await diskPath(this.root, '/.workbench-local/upload-receipts.json', true);
        const receipts = JSON.parse(await fs.readFile(receiptFile, 'utf8').catch(() => '{}')) as Record<string, { id?: string }>;
        const trimmed = Object.fromEntries(Object.entries(receipts).filter(([, value]) => value?.id !== item.id));
        if (Object.keys(trimmed).length !== Object.keys(receipts).length) await atomicJson(receiptFile, trimmed);
      }
      return change.action === 'delete' ? undefined : item;
    });
  }
}
