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
const windows = new Set<BrowserWindow>(); let workbench: Workbench; let quitting = false; let closing = false; let windowsReady = false; let pendingWindows = 0;
const entry = path.join(__dirname, 'index.html');
app.setName('Team Agent User');
app.setPath('userData', process.env.WORKBENCH_DATA_DIR || path.join(app.getPath('appData'), 'TeamAgentUser'));
function emit(event: WorkbenchEvent) { for (const window of windows) if (!window.isDestroyed()) window.webContents.send('workbench:event', event); }
let emitTimer: NodeJS.Timeout | undefined;
function broadcast() { if (!emitTimer) emitTimer = setTimeout(() => { emitTimer = undefined; emit({ type: 'state' }); }, 80); }
const notice = (message: string) => { emit({ type: 'notice', message }); if (message.startsWith('待授权：')) for (const window of windows) if (!window.isDestroyed() && !window.isFocused()) window.flashFrame(true); };
const id = z.string().uuid(), text = z.string().max(2 * 1024 * 1024), provider = z.enum(['codex', 'cursor']);
const sessionInput = z.object({ id });
async function chooseFiles(owner: BrowserWindow) { return (await dialog.showOpenDialog(owner, { title: '选择要共享的文件', properties: ['openFile', 'multiSelections'] })).filePaths; }
async function dispatch(action: string, raw: unknown, owner: BrowserWindow): Promise<unknown> {
  const setupActions = new Set(['snapshot', 'settings.save', 'providers.detect', 'provider.auth', 'provider.login.cancel', 'choose.directory', 'choose.executable', 'server.identity.forget', 'remote.connect', 'remote.disconnect', 'provider.login', 'open.data', 'open.link', 'copy', 'session.stop', 'remote.manifest', 'session.history', 'handoff.read']);
  if (!setupActions.has(action)) workbench.assertWorkspace();
  switch (action) {
    case 'snapshot': return workbench.snapshot();
    case 'settings.save': {
      const next: import('../shared/types').Settings = settingsSchema.parse(raw);
      for (const p of ['codex', 'cursor'] as const) if (next.providerPaths[p] !== workbench.store.settings.providerPaths[p]) workbench.accounts.invalidate(p);
      next.verifiedLocalWorkspace = workbench.store.settings.verifiedLocalWorkspace; next.workspaceSnapshot = workbench.store.settings.workspaceSnapshot; workbench.store.settings = next; await workbench.store.save(); broadcast(); return true;
    }
    case 'providers.detect': return workbench.detect();
    case 'provider.auth': {
      const p = z.object({ provider, cwd: z.string().optional() }).parse(raw);
      return workbench.accounts.check(p.provider, p.cwd || workbench.store.settings.localWorkspace || app.getPath('home'));
    }
    case 'provider.login.cancel': workbench.accounts.cancel(z.object({ provider }).parse(raw).provider); return true;
    case 'provider.catalog': { const p = z.object({ provider, cwd: text.min(1) }).parse(raw); return workbench.catalog(p.provider, p.cwd); }
    case 'provider.permissions': { const p = z.object({ provider, cwd: text.min(1) }).parse(raw); return workbench.inspectPermissions(p.provider, p.cwd); }
    case 'provider.cursorReview': return workbench.configureCursorReview(z.object({ cwd: text.min(1) }).parse(raw).cwd);
    case 'session.permissions': { const p = z.object({ id, mode: z.enum(['inherit', 'review', 'auto', 'full']), stop: z.boolean().optional() }).parse(raw); return workbench.changePermissions(p.id, p.mode, p.stop); }
    case 'session.model': { const p = z.object({ id, model: z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/), stop: z.boolean().optional() }).parse(raw); return workbench.changeModel(p.id, p.model, p.stop); }
    case 'choose.directory': return (await dialog.showOpenDialog(owner, { properties: ['openDirectory'] })).filePaths[0] || '';
    case 'choose.executable': return (await dialog.showOpenDialog(owner, { title: '选择 CLI 程序（不是编辑器）', properties: ['openFile'], filters: [{ name: 'CLI', extensions: ['exe', 'cmd', 'ps1'] }] })).filePaths[0] || '';
    case 'remote.connect': {
      const p = z.object({ profile: profileSchema, password: z.string().min(1).max(4096), localPath: z.string().min(1) }).parse(raw);
      const key = serverIdentityKey(p.profile.host, p.profile.port);
      const profile = { ...p.profile, fingerprint: p.profile.fingerprint || workbench.store.settings.trustedServerIdentities?.[key] || '' };
      return workbench.configureWorkspace(profile, p.password, p.localPath, async fingerprint => {
        const accepted = (await dialog.showMessageBox(owner, {
        type: 'question', title: '首次连接团队服务器', message: p.profile.name || '团队共享服务器',
        detail: `这是本机第一次连接 ${p.profile.host}:${p.profile.port}，请确认服务器地址填写正确。`,
        buttons: ['取消', '继续登录'], defaultId: 0, cancelId: 0,
        })).response === 1;
        if (accepted) {
          workbench.store.settings.trustedServerIdentities = { ...(workbench.store.settings.trustedServerIdentities || {}), [key]: fingerprint };
          await workbench.store.save(); broadcast();
        }
        return accepted;
      });
    }
    case 'server.identity.forget': {
      const p = z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535) }).parse(raw), key = serverIdentityKey(p.host, p.port);
      workbench.remote.disconnect();
      const identities = { ...(workbench.store.settings.trustedServerIdentities || {}) }; delete identities[key];
      workbench.store.settings.trustedServerIdentities = identities;
      workbench.store.settings.connections = workbench.store.settings.connections.map(profile => serverIdentityKey(profile.host, profile.port) === key ? { ...profile, fingerprint: '' } : profile);
      if (workbench.store.settings.workspaceSnapshot && serverIdentityKey(workbench.store.settings.workspaceSnapshot.profile.host, workbench.store.settings.workspaceSnapshot.profile.port) === key) workbench.store.settings.workspaceSnapshot.profile.fingerprint = '';
      await workbench.store.save(); broadcast(); return true;
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
      const p = z.object({ id, text: text.min(1), sourceIds: z.array(z.string()).default([]) }).parse(raw); const s = workbench.session(p.id); workbench.assertCanWork(s.binding);
      await workbench.requireAuth(s.provider, s.cwd);
      if (s.title === '新会话') s.title = p.text.trim().slice(0, 40);
      void workbench.send(p.id, p.text, p.sourceIds).catch(e => notice(e.message)); return true;
    }
    case 'session.input': { const p = z.object({ id, input: z.object({ text, sourceIds: z.array(z.string()), answers: z.record(z.string(), z.string()) }) }).parse(raw); await workbench.saveInput(p.id, p.input); return true; }
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
async function createWindow() {
  const window = new BrowserWindow({ width: 1520, height: 980, minWidth: 1100, minHeight: 720, backgroundColor: '#f5f6f8', show: process.env.WORKBENCH_TEST !== '1', title: '团队工作台 · 用户版', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  windows.add(window);
  window.setMenuBarVisibility(false);
  window.on('focus', () => window.flashFrame(false));
  window.on('close', event => {
    if (quitting) return;
    if (windows.size === 1) { event.preventDefault(); void finishQuit(window); }
    else windows.delete(window);
  });
  window.on('closed', () => windows.delete(window));
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
  workbench = new Workbench(app.getPath('userData'), broadcast, notice); await workbench.init();
  ipcMain.handle('workbench', async (event, action, payload) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || !windows.has(owner) || event.senderFrame?.url !== pathToFileURL(entry).href) return { ok: false, error: '不允许的调用来源' };
    try { return { ok: true, value: await dispatch(z.string().parse(action), payload, owner) }; } catch (e: any) { return { ok: false, error: errorMessage(e) }; }
  });
  windowsReady = true;
  await createWindow();
  while (pendingWindows > 0) { pendingWindows -= 1; await createWindow(); }
}).catch(error => { dialog.showErrorBox('工作台启动失败', error.message); app.quit(); });
app.on('window-all-closed', () => { if (!closing) void finishQuit(); });
async function finishQuit(owner = latestWindow()) {
  if (closing) return; closing = true;
  try { await workbench.close(); quitting = true; app.quit(); }
  catch (e: any) { if (owner && !owner.isDestroyed()) await dialog.showMessageBox(owner, { type: 'error', title: '未保存的编辑', message: '保存失败，已保留窗口和待保存内容。', detail: e.message + '\n请恢复目录或磁盘空间后重试保存或退出。', buttons: ['返回工作台'] }); }
  finally { closing = false; }
}
app.on('before-quit', event => { if (!quitting && workbench) { event.preventDefault(); void finishQuit(); } });
