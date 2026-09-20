import { ownDataDirectory } from '../shared/single-instance';
import { contentEditSchema } from '../shared/content';
import { errorMessage } from '../shared/errors';
import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { serverIdentityKey } from '../shared/server-identity';
import { Workbench } from '../core/workbench';
import { settingsSchema, profileSchema } from '../core/config';
import { historyMarkdown, packageDraft, freezeFile } from '../core/artifacts';
import type { WorkbenchEvent } from '../shared/types';
import { projectBriefSchema } from '../shared/project-brief';
import { ServerIdentityStore } from '../core/server-identities';
type WindowContext = { workbench: Workbench; slot: number; broadcast: () => void; notice: (message: string) => void };
const windows = new Set<BrowserWindow>(), contexts = new Map<BrowserWindow, WindowContext>(), activeSlots = new Set<number>(), closingWindows = new Set<BrowserWindow>();
let quitting = false; let closing = false; let windowsReady = false; let pendingWindows = 0;
const entry = path.join(__dirname, 'index.html');
app.setName('Team Agent User');
app.setPath('userData', process.env.WORKBENCH_DATA_DIR || path.join(app.getPath('appData'), 'TeamAgentUser'));
const serverIdentities = new ServerIdentityStore(path.join(app.getPath('userData'), 'server-identities.json'));
async function syncServerIdentities(clearKey?: string) {
  const identities = serverIdentities.snapshot();
  await Promise.all([...contexts.values()].map(async context => {
    const settings = context.workbench.store.settings;
    settings.trustedServerIdentities = { ...identities };
    if (clearKey) {
      if (context.workbench.remote.profile && serverIdentityKey(context.workbench.remote.profile.host, context.workbench.remote.profile.port) === clearKey) context.workbench.remote.disconnect();
      settings.connections = settings.connections.map(profile => serverIdentityKey(profile.host, profile.port) === clearKey ? { ...profile, fingerprint: '' } : profile);
      if (settings.workspaceSnapshot && serverIdentityKey(settings.workspaceSnapshot.profile.host, settings.workspaceSnapshot.profile.port) === clearKey) settings.workspaceSnapshot.profile.fingerprint = '';
    }
    await context.workbench.store.save(); context.broadcast();
  }));
}
const id = z.string().uuid(), text = z.string().max(2 * 1024 * 1024), provider = z.enum(['codex', 'cursor']);
const sessionInput = z.object({ id });
const capability = z.object({ id: z.string().min(1).max(500), kind: z.enum(['skill', 'plugin']), name: z.string().min(1).max(200) });
async function chooseFiles(owner: BrowserWindow) { return (await dialog.showOpenDialog(owner, { title: '选择要共享的文件', properties: ['openFile', 'multiSelections'] })).filePaths; }
async function dispatch(action: string, raw: unknown, owner: BrowserWindow): Promise<unknown> {
  const context = contexts.get(owner); if (!context) throw new Error('当前窗口的独立工作台尚未就绪');
  const { workbench, broadcast, notice } = context;
  const setupActions = new Set(['snapshot', 'settings.save', 'layout.sidebar', 'providers.detect', 'provider.auth', 'provider.login.cancel', 'choose.directory', 'choose.executable', 'server.identity.forget', 'remote.connect', 'remote.disconnect', 'provider.login', 'open.data', 'open.link', 'copy', 'session.stop', 'remote.manifest', 'session.history', 'handoff.read']);
  if (!setupActions.has(action)) workbench.assertWorkspace();
  switch (action) {
    case 'snapshot': return workbench.snapshot();
    case 'settings.save': {
      const next: import('../shared/types').Settings = settingsSchema.parse(raw);
      for (const p of ['codex', 'cursor'] as const) if (next.providerPaths[p] !== workbench.store.settings.providerPaths[p]) workbench.accounts.invalidate(p);
      next.verifiedLocalWorkspace = workbench.store.settings.verifiedLocalWorkspace; next.workspaceSnapshot = workbench.store.settings.workspaceSnapshot; workbench.store.settings = next; await workbench.store.save(); broadcast(); return true;
    }
    case 'layout.sidebar': { const p = z.object({ height: z.number().int().min(180).max(4000) }).parse(raw); workbench.store.settings.sidebarProjectHeight = p.height; await workbench.store.save(); return true; }
    case 'providers.detect': return workbench.detect();
    case 'provider.auth': {
      const p = z.object({ provider, cwd: z.string().optional() }).parse(raw);
      return workbench.accounts.check(p.provider, p.cwd || workbench.store.settings.localWorkspace || app.getPath('home'));
    }
    case 'provider.login.cancel': workbench.accounts.cancel(z.object({ provider }).parse(raw).provider); return true;
    case 'provider.catalog': { const p = z.object({ provider, cwd: text.min(1) }).parse(raw); return workbench.catalog(p.provider, p.cwd); }
    case 'session.capabilities': { const p = z.object({ id, forceRefresh: z.boolean().optional() }).parse(raw); return workbench.capabilities(p.id, p.forceRefresh); }
    case 'provider.permissions': { const p = z.object({ provider, cwd: text.min(1) }).parse(raw); return workbench.inspectPermissions(p.provider, p.cwd); }
    case 'provider.cursorReview': return workbench.configureCursorReview(z.object({ cwd: text.min(1) }).parse(raw).cwd);
    case 'session.permissions': { const p = z.object({ id, mode: z.enum(['inherit', 'review', 'auto', 'full']), stop: z.boolean().optional() }).parse(raw); return workbench.changePermissions(p.id, p.mode, p.stop); }
    case 'session.model': { const p = z.object({ id, model: z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/), stop: z.boolean().optional() }).parse(raw); return workbench.changeModel(p.id, p.model, p.stop); }
    case 'choose.directory': return (await dialog.showOpenDialog(owner, { properties: ['openDirectory'] })).filePaths[0] || '';
    case 'choose.executable': return (await dialog.showOpenDialog(owner, { title: '选择 CLI 程序（不是编辑器）', properties: ['openFile'], filters: [{ name: 'CLI', extensions: ['exe', 'cmd', 'ps1'] }] })).filePaths[0] || '';
    case 'remote.connect': {
      const p = z.object({ profile: profileSchema, password: z.string().min(1).max(4096), localPath: z.string().min(1) }).parse(raw);
      const key = serverIdentityKey(p.profile.host, p.profile.port);
      const profile = { ...p.profile, fingerprint: p.profile.mode === 'local' ? p.profile.fingerprint : serverIdentities.get(key) };
      return workbench.configureWorkspace(profile, p.password, p.localPath, async fingerprint => {
        const accepted = (await dialog.showMessageBox(owner, {
        type: 'question', title: '首次连接团队服务器', message: p.profile.name || '团队共享服务器',
        detail: `这是本机第一次连接 ${p.profile.host}:${p.profile.port}，请确认服务器地址填写正确。`,
        buttons: ['取消', '继续登录'], defaultId: 0, cancelId: 0,
        })).response === 1;
        if (accepted) {
          await serverIdentities.remember(key, fingerprint); await syncServerIdentities();
        }
        return accepted;
      });
    }
    case 'server.identity.forget': {
      const p = z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535) }).parse(raw), key = serverIdentityKey(p.host, p.port);
      await serverIdentities.forget(key); await syncServerIdentities(key); return true;
    }
    case 'project.create': { const p = z.object({ name: z.string().min(1).max(180), groupName: z.string().optional(), brief: projectBriefSchema.optional() }).parse(raw); return workbench.createProject(p.name, p.groupName, p.brief); }
    case 'project.initialize': { const p = z.object({ name: z.string().min(1).max(180), groupName: z.string().min(1).max(80), contextKey: z.string().max(4096), brief: projectBriefSchema }).parse(raw); return workbench.initializeProject(p.name, p.groupName, p.brief, p.contextKey); }
    case 'remote.disconnect': workbench.remote.disconnect(); return true;
    case 'remote.manifest': return workbench.refreshGroups();
    case 'remote.list': { const p = z.object({ projectId: z.string(), path: text }).parse(raw); return workbench.remote.list(workbench.remote.binding(p.projectId), p.path); }
    case 'remote.preview': { const p = z.object({ projectId: z.string(), path: text }).parse(raw); return workbench.remote.preview(workbench.remote.binding(p.projectId), p.path); }
    case 'remote.download': {
      const p = z.object({ projectId: z.string(), path: text }).parse(raw); const binding = workbench.remote.binding(p.projectId);
      const result = await dialog.showSaveDialog(owner, { defaultPath: path.posix.basename(p.path) }); if (!result.filePath) return false;
      await workbench.remote.download(binding, p.path, result.filePath); notice('已下载到 ' + result.filePath); return true;
    }
    case 'remote.upload': { const p = z.object({ projectId: z.string(), folder: text }).parse(raw); const binding = workbench.remote.binding(p.projectId); const files = await chooseFiles(owner); await workbench.uploadFiles(binding, p.folder, files); return files.length; }
    case 'session.create': { const p = z.object({ provider, cwd: text, projectId: z.string().optional(), model: z.string().min(1).max(256).regex(/^[^\x00-\x1f]+$/).optional(), permissionMode: z.enum(['inherit', 'review', 'auto', 'full']).optional(), includeBrief: z.boolean().default(true) }).parse(raw); await workbench.requireAuth(p.provider, p.cwd); return workbench.createSession(p.provider, p.cwd, p.projectId, 'work', undefined, p.model, p.permissionMode, p.includeBrief); }
    case 'project.brief': return workbench.remote.projectBrief(workbench.remote.binding(z.object({ projectId: z.string() }).parse(raw).projectId));
    case 'project.brief.save': { const p = z.object({ projectId: z.string(), brief: projectBriefSchema, revision: z.number().int().nonnegative() }).parse(raw); const value = await workbench.remote.saveProjectBrief(workbench.remote.binding(p.projectId), p.brief, p.revision); await workbench.refreshGroups(); return value; }
    case 'content.list': return workbench.remote.contentList(workbench.remote.binding(z.object({ projectId: z.string() }).parse(raw).projectId));
    case 'content.sync': return workbench.syncContentUpdates();
    case 'content.merge.prepare': { const p = z.object({ projectId: z.string(), sessionId: id, sourceIds: z.array(z.string().uuid()).min(2).max(20) }).parse(raw); return workbench.prepareContentMerge(p.projectId, p.sessionId, p.sourceIds); }
    case 'content.merge.save': { const p = z.object({ id, title: z.string().max(200), body: text }).parse(raw); return workbench.saveContentMerge(p.id, p.title, p.body); }
    case 'content.merge.commit': return workbench.commitContentMerge(sessionInput.parse(raw).id);
    case 'content.adopt': { const p = z.object({ projectId: z.string(), path: text }).parse(raw); return workbench.remote.contentAdopt(workbench.remote.binding(p.projectId), p.path); }
    case 'content.edit': { const p = z.object({ projectId: z.string(), change: contentEditSchema }).parse(raw); return workbench.remote.contentEdit(workbench.remote.binding(p.projectId), p.change); }
    case 'content.replace': {
      const p = z.object({ projectId: z.string(), change: contentEditSchema }).parse(raw), binding = workbench.remote.binding(p.projectId);
      const file = (await dialog.showOpenDialog(owner, { title: '选择替换文件（保存为新修订）', properties: ['openFile'] })).filePaths[0];
      if (!file) return false;
      const snapshot = await freezeFile(file, path.join(workbench.store.root, 'uploads', 'replacements'));
      try { await workbench.remote.contentReplace(binding, p.change, snapshot.localPath); return true; } finally { await fs.rm(snapshot.localPath, { force: true }); }
    }
    case 'session.attachContent': { const p = z.object({ id, contentId: z.string().uuid() }).parse(raw); return workbench.attachContent(p.id, p.contentId); }
    case 'session.projectContext': return workbench.refreshProjectContext(sessionInput.parse(raw).id);
    case 'draft.revise': return workbench.reviseDraft(sessionInput.parse(raw).id);
    case 'draft.git': { const p = z.object({ id, include: z.boolean() }).parse(raw); const draft = workbench.draft(p.id); if (draft.submitted) throw new Error('已提交的快照不能修改'); draft.includeGit = p.include; await workbench.store.save(); broadcast(); return true; }
    case 'cache.clean': return workbench.cleanUploadCache();
    case 'session.send': {
      const p = z.object({ id, text: text.min(1), sourceIds: z.array(z.string()).default([]), capabilities: z.array(capability).max(20).default([]) }).parse(raw); const s = workbench.session(p.id); workbench.assertCanWork(s.binding);
      await workbench.requireAuth(s.provider, s.cwd);
      if (s.title === '新会话') s.title = p.text.trim().slice(0, 40);
      return new Promise<boolean>((resolve, reject) => {
        let submitted = false;
        void workbench.send(p.id, p.text, p.sourceIds, p.capabilities, () => { submitted = true; resolve(true); }).catch(error => { notice(error.message); if (!submitted) reject(error); });
      });
    }
    case 'session.input': { const p = z.object({ id, input: z.object({ text, sourceIds: z.array(z.string()), answers: z.record(z.string(), z.string()), capabilities: z.array(capability).max(20).optional() }) }).parse(raw); await workbench.saveInput(p.id, p.input); return true; }
    case 'session.stop': return workbench.stop(sessionInput.parse(raw).id);
    case 'session.close': return workbench.closeSession(sessionInput.parse(raw).id);
    case 'session.reopen': return workbench.reopenSession(sessionInput.parse(raw).id);
    case 'session.answer': { const p = z.object({ id, requestId: z.string(), option: z.string(), answers: z.record(z.string(), z.string()).optional() }).parse(raw); return workbench.answer(p.id, p.requestId, p.option, p.answers); }
    case 'session.attachLocal': { const p = sessionInput.parse(raw); return workbench.attachLocal(p.id, await chooseFiles(owner)); }
    case 'session.attachRemote': { const p = z.object({ id, projectId: z.string(), path: text }).parse(raw); return workbench.attachRemote(p.id, p.projectId, p.path); }
    case 'session.autoUpload': { const p = z.object({ id, enabled: z.boolean() }).parse(raw); const s = workbench.session(p.id); if (p.enabled && (!s.binding || s.purpose !== 'work')) throw new Error('只有绑定远端项目的工作会话可开启自动上传'); s.autoUpload = p.enabled; await workbench.store.save(); broadcast(); return true; }
    case 'session.history': return historyMarkdown(workbench.session(sessionInput.parse(raw).id));
    case 'session.uploadTrajectory': return workbench.archive(sessionInput.parse(raw).id);
    case 'handoff.read': return workbench.readHandoff(sessionInput.parse(raw).id);
    case 'handoff.save': { const p = z.object({ id, text }).parse(raw); return workbench.saveHandoff(p.id, p.text); }
    case 'draft.prepare': { const p = sessionInput.parse(raw); return workbench.prepare(p.id); }
    case 'draft.retry': return workbench.retryPreparation(sessionInput.parse(raw).id);
    case 'draft.cancel': return workbench.cancelPreparation(sessionInput.parse(raw).id);
    case 'draft.supplement': { const p = z.object({ id, supplement: text, repoUrlOverride: z.string().max(2048) }).parse(raw); return workbench.saveDraftSupplement(p.id, p.supplement, p.repoUrlOverride); }
    case 'draft.artifactSelection': { const p = z.object({ id, artifactId: z.string(), selected: z.boolean() }).parse(raw); return workbench.selectDraftArtifact(p.id, p.artifactId, p.selected); }
    case 'draft.save': { const p = z.object({ id, title: z.string().max(120), body: text, repoUrl: z.string().max(2048), target: z.string().optional() }).parse(raw); return workbench.saveDraft(p.id, p.title, p.body, p.repoUrl, p.target); }
    case 'draft.attach': { const p = sessionInput.parse(raw); return workbench.addDraftFiles(p.id, await chooseFiles(owner)); }
    case 'draft.submit': { const p = z.object({ id, target: z.string().optional() }).parse(raw); return workbench.submitDraft(p.id, p.target); }
    case 'draft.export': {
      const d = workbench.draft(sessionInput.parse(raw).id); const target = await dialog.showSaveDialog(owner, { defaultPath: 'contribution.zip', filters: [{ name: '成果包', extensions: ['zip'] }] }); if (!target.filePath) return false;
      const zip = await packageDraft(d, workbench.store.root); await fs.copyFile(zip, target.filePath); return true;
    }
    case 'transfer.retry': return workbench.queue.retry(sessionInput.parse(raw).id);
    case 'provider.login': {
      const p = z.object({ provider, cwd: z.string().optional() }).parse(raw);
      await workbench.accounts.login(p.provider, p.cwd || workbench.store.settings.localWorkspace || app.getPath('home'));
      return true;
    }
    case 'copy': clipboard.writeText(text.parse(raw)); return true;
    case 'open.link': { const url = new URL(text.parse(raw)); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('只允许打开网页链接'); await shell.openExternal(url.href); return true; }
    case 'open.data': await shell.openPath(workbench.store.root); return true;
    default: throw new Error('未知操作：' + action);
  }
}
function latestWindow() {
  const list = [...windows];
  for (let index = list.length - 1; index >= 0; index -= 1) if (!list[index].isDestroyed() && list[index].isFocused()) return list[index];
  for (let index = list.length - 1; index >= 0; index -= 1) if (!list[index].isDestroyed()) return list[index];
}
function claimSlot() { let slot = 1; while (activeSlots.has(slot)) slot += 1; activeSlots.add(slot); return slot; }
function instanceRoot(slot: number) { return slot === 1 ? app.getPath('userData') : path.join(app.getPath('userData'), 'instances', String(slot)); }
async function createWindow() {
  const slot = claimSlot();
  const window = new BrowserWindow({ width: 1520, height: 980, minWidth: 1100, minHeight: 720, backgroundColor: '#f5f6f8', show: process.env.WORKBENCH_TEST !== '1', title: '团队工作台 · 用户版', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  windows.add(window);
  const emit = (event: WorkbenchEvent) => { if (!window.isDestroyed()) window.webContents.send('workbench:event', event); };
  let emitTimer: NodeJS.Timeout | undefined;
  const broadcast = () => { if (!emitTimer) emitTimer = setTimeout(() => { emitTimer = undefined; emit({ type: 'state' }); }, 80); };
  const notice = (message: string) => { emit({ type: 'notice', message }); if (message.startsWith('待授权：') && !window.isDestroyed() && !window.isFocused()) window.flashFrame(true); };
  const workbench = new Workbench(instanceRoot(slot), broadcast, notice);
  try {
    await workbench.init(); await serverIdentities.init(slot === 1 ? workbench.store.settings.trustedServerIdentities || {} : {});
    workbench.store.settings.trustedServerIdentities = serverIdentities.snapshot(); contexts.set(window, { workbench, slot, broadcast, notice });
  }
  catch (error) { windows.delete(window); activeSlots.delete(slot); window.destroy(); throw error; }
  window.setMenuBarVisibility(false);
  window.on('focus', () => window.flashFrame(false));
  window.on('close', event => {
    if (quitting || closingWindows.has(window)) return;
    event.preventDefault();
    if (windows.size === 1) void finishQuit(window);
    else void closeWindow(window);
  });
  window.on('closed', () => {
    windows.delete(window); const context = contexts.get(window); contexts.delete(window);
    if (context) { activeSlots.delete(context.slot); if (!quitting && !closingWindows.has(window)) void context.workbench.close(); }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  await window.loadFile(entry);
  return window;
}
function openAdditionalWindow() {
  if (quitting || closing) return;
  if (!windowsReady) { pendingWindows += 1; return; }
  void createWindow().catch(error => dialog.showErrorBox('工作台窗口启动失败', error.message));
}
if (ownDataDirectory(latestWindow, openAdditionalWindow)) app.whenReady().then(async () => {
  ipcMain.handle('workbench', async (event, action, payload) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || !windows.has(owner) || event.senderFrame?.url !== pathToFileURL(entry).href) return { ok: false, error: '不允许的调用来源' };
    try { return { ok: true, value: await dispatch(z.string().parse(action), payload, owner) }; } catch (e: any) { return { ok: false, error: errorMessage(e) }; }
  });
  await createWindow();
  windowsReady = true;
  while (pendingWindows > 0) { pendingWindows -= 1; await createWindow(); }
}).catch(error => { dialog.showErrorBox('工作台启动失败', error.message); app.quit(); });
app.on('window-all-closed', () => { if (!closing) void finishQuit(); });
async function closeWindow(window: BrowserWindow) {
  if (closingWindows.has(window) || window.isDestroyed()) return;
  const context = contexts.get(window); if (!context) { window.destroy(); return; }
  closingWindows.add(window);
  try {
    await context.workbench.close(); contexts.delete(window); activeSlots.delete(context.slot); windows.delete(window); window.destroy();
  } catch (e: any) {
    if (!window.isDestroyed()) await dialog.showMessageBox(window, { type: 'error', title: '未保存的编辑', message: '保存失败，已保留此账号窗口和待保存内容。', detail: e.message + '\n请恢复目录或磁盘空间后重试关闭。', buttons: ['返回工作台'] });
  } finally { closingWindows.delete(window); }
}
async function finishQuit(owner = latestWindow()) {
  if (closing) return; closing = true;
  try { await Promise.all([...contexts.values()].map(context => context.workbench.close())); quitting = true; app.quit(); }
  catch (e: any) { if (owner && !owner.isDestroyed()) await dialog.showMessageBox(owner, { type: 'error', title: '未保存的编辑', message: '保存失败，已保留窗口和待保存内容。', detail: e.message + '\n请恢复目录或磁盘空间后重试保存或退出。', buttons: ['返回工作台'] }); }
  finally { closing = false; }
}
app.on('before-quit', event => { if (!quitting && contexts.size) { event.preventDefault(); void finishQuit(); } });
