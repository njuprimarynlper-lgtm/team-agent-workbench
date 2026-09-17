import { errorMessage } from '../shared/errors';
import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Workbench } from '../core/workbench';
import { settingsSchema, profileSchema } from '../core/config';
import { historyMarkdown, packageDraft } from '../core/artifacts';
import type { WorkbenchEvent } from '../shared/types';
let window: BrowserWindow; let workbench: Workbench; let quitting = false; let closing = false;
const entry = path.join(__dirname, 'index.html');
app.setName('Team Agent User');
app.setPath('userData', process.env.WORKBENCH_DATA_DIR || path.join(app.getPath('appData'), 'TeamAgentUser'));
function emit(event: WorkbenchEvent) { if (window && !window.isDestroyed()) window.webContents.send('workbench:event', event); }
let emitTimer: NodeJS.Timeout | undefined;
function broadcast() { if (!emitTimer) emitTimer = setTimeout(() => { emitTimer = undefined; emit({ type: 'state' }); }, 80); }
const notice = (message: string) => emit({ type: 'notice', message });
const id = z.string().uuid(), text = z.string().max(2 * 1024 * 1024), provider = z.enum(['codex', 'cursor']);
const sessionInput = z.object({ id });
async function chooseFiles() { return (await dialog.showOpenDialog(window, { title: '选择要共享的文件', properties: ['openFile', 'multiSelections'] })).filePaths; }
async function dispatch(action: string, raw: unknown): Promise<unknown> {
  const setupActions = new Set(['snapshot', 'settings.save', 'providers.detect', 'provider.auth', 'provider.login.cancel', 'choose.directory', 'choose.executable', 'profile.import', 'remote.connect', 'remote.disconnect', 'provider.login', 'open.data', 'open.link', 'copy', 'session.stop']);
  if (!setupActions.has(action)) workbench.assertWorkspace();
  switch (action) {
    case 'snapshot': return workbench.snapshot();
    case 'settings.save': {
      const next = settingsSchema.parse(raw);
      for (const p of ['codex', 'cursor'] as const) if (next.providerPaths[p] !== workbench.store.settings.providerPaths[p]) workbench.accounts.invalidate(p);
      next.verifiedLocalWorkspace = workbench.store.settings.verifiedLocalWorkspace; workbench.store.settings = next; await workbench.store.save(); broadcast(); return true;
    }
    case 'providers.detect': return workbench.detect();
    case 'provider.auth': {
      const p = z.object({ provider, cwd: z.string().optional() }).parse(raw);
      return workbench.accounts.check(p.provider, p.cwd || workbench.store.settings.localWorkspace || app.getPath('home'));
    }
    case 'provider.login.cancel': workbench.accounts.cancel(z.object({ provider }).parse(raw).provider); return true;
    case 'provider.catalog': { const p = z.object({ provider, cwd: text.min(1) }).parse(raw); return workbench.catalog(p.provider, p.cwd); }
    case 'choose.directory': return (await dialog.showOpenDialog(window, { properties: ['openDirectory'] })).filePaths[0] || '';
    case 'choose.executable': return (await dialog.showOpenDialog(window, { title: '选择 CLI 程序（不是编辑器）', properties: ['openFile'], filters: [{ name: 'CLI', extensions: ['exe', 'cmd', 'ps1'] }] })).filePaths[0] || '';
    case 'profile.import': {
      const file = (await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: '连接配置', extensions: ['json'] }] })).filePaths[0];
      if (!file) return null; const p = profileSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
      workbench.store.settings.connections = [...workbench.store.settings.connections.filter(x => x.id !== p.id), p]; await workbench.store.save(); broadcast(); return p;
    }
    case 'remote.connect': {
      const p = z.object({ profile: profileSchema, password: z.string().min(1).max(4096), localPath: z.string().min(1) }).parse(raw);
      return workbench.configureWorkspace(p.profile, p.password, p.localPath, async fingerprint => (await dialog.showMessageBox(window, { type: 'question', title: '核对共享服务器', message: `${p.profile.host}:${p.profile.port}`, detail: `首次连接，请与管理员提供的指纹核对：\n\n${fingerprint}\n\n确认后此连接将固定校验该指纹。`, buttons: ['取消', '指纹一致，连接'], defaultId: 0, cancelId: 0 })).response === 1);
    }
    case 'project.create': { const p = z.object({ name: z.string().min(1).max(180), groupName: z.string().optional() }).parse(raw); return workbench.createProject(p.name, p.groupName); }
    case 'remote.disconnect': workbench.remote.disconnect(); return true;
    case 'remote.manifest': { const projects = await workbench.remote.loadManifest(); const p = workbench.remote.profile!; workbench.store.settings.connections = workbench.store.settings.connections.map(x => x.id === p.id ? p : x); await workbench.store.save(); broadcast(); return projects; }
    case 'remote.list': { const p = z.object({ projectId: z.string(), path: text }).parse(raw); return workbench.remote.list(workbench.remote.binding(p.projectId), p.path); }
    case 'remote.preview': { const p = z.object({ projectId: z.string(), path: text }).parse(raw); return workbench.remote.preview(workbench.remote.binding(p.projectId), p.path); }
    case 'remote.download': {
      const p = z.object({ projectId: z.string(), path: text }).parse(raw); const binding = workbench.remote.binding(p.projectId);
      const result = await dialog.showSaveDialog(window, { defaultPath: path.posix.basename(p.path) }); if (!result.filePath) return false;
      await workbench.remote.download(binding, p.path, result.filePath); notice('已下载到 ' + result.filePath); return true;
    }
    case 'remote.upload': { const p = z.object({ projectId: z.string(), folder: text }).parse(raw); const binding = workbench.remote.binding(p.projectId); const files = await chooseFiles(); await workbench.uploadFiles(binding, p.folder, files); return files.length; }
    case 'session.create': { const p = z.object({ provider, cwd: text, projectId: z.string().optional(), model: z.string().min(1).max(256).regex(/^[^\x00-\x1f]+$/).optional() }).parse(raw); await workbench.requireAuth(p.provider, p.cwd); return workbench.createSession(p.provider, p.cwd, p.projectId, 'work', undefined, p.model); }
    case 'session.send': {
      const p = z.object({ id, text: text.min(1), sourceIds: z.array(z.string()).default([]) }).parse(raw); const s = workbench.session(p.id);
      await workbench.requireAuth(s.provider, s.cwd);
      if (s.title === '新会话') s.title = p.text.trim().slice(0, 40);
      void workbench.send(p.id, p.text, p.sourceIds).catch(e => notice(e.message)); return true;
    }
    case 'session.input': { const p = z.object({ id, input: z.object({ text, sourceIds: z.array(z.string()), answers: z.record(z.string(), z.string()) }) }).parse(raw); await workbench.saveInput(p.id, p.input); return true; }
    case 'session.stop': return workbench.stop(sessionInput.parse(raw).id);
    case 'session.close': return workbench.closeSession(sessionInput.parse(raw).id);
    case 'session.reopen': return workbench.reopenSession(sessionInput.parse(raw).id);
    case 'session.answer': { const p = z.object({ id, requestId: z.string(), option: z.string(), answers: z.record(z.string(), z.string()).optional() }).parse(raw); return workbench.answer(p.id, p.requestId, p.option, p.answers); }
    case 'session.attachLocal': { const p = sessionInput.parse(raw); return workbench.attachLocal(p.id, await chooseFiles()); }
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
    case 'draft.attach': { const p = sessionInput.parse(raw); return workbench.addDraftFiles(p.id, await chooseFiles()); }
    case 'draft.submit': { const p = z.object({ id, target: z.string().optional() }).parse(raw); return workbench.submitDraft(p.id, p.target); }
    case 'draft.export': {
      const d = workbench.draft(sessionInput.parse(raw).id); const target = await dialog.showSaveDialog(window, { defaultPath: 'contribution.zip', filters: [{ name: '成果包', extensions: ['zip'] }] }); if (!target.filePath) return false;
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
app.whenReady().then(async () => {
  workbench = new Workbench(app.getPath('userData'), broadcast, notice); await workbench.init();
  window = new BrowserWindow({ width: 1520, height: 980, minWidth: 1100, minHeight: 720, backgroundColor: '#f5f6f8', show: process.env.WORKBENCH_TEST !== '1', title: '团队工作台 · 用户版', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  window.setMenuBarVisibility(false);
  window.on('close', event => { if (!quitting) { event.preventDefault(); void finishQuit(); } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle('workbench', async (event, action, payload) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== pathToFileURL(entry).href) return { ok: false, error: '不允许的调用来源' };
    try { return { ok: true, value: await dispatch(z.string().parse(action), payload) }; } catch (e: any) { return { ok: false, error: errorMessage(e) }; }
  });
  await window.loadFile(entry);
}).catch(error => { dialog.showErrorBox('工作台启动失败', error.message); app.quit(); });
app.on('window-all-closed', () => app.quit());
async function finishQuit() {
  if (closing) return; closing = true;
  try { await workbench.close(); quitting = true; app.quit(); }
  catch (e: any) { if (window && !window.isDestroyed()) await dialog.showMessageBox(window, { type: 'error', title: '未保存的编辑', message: '保存失败，已保留窗口和待保存内容。', detail: e.message + '\n请恢复目录或磁盘空间后重试保存或退出。', buttons: ['返回工作台'] }); }
  finally { closing = false; }
}
app.on('before-quit', event => { if (!quitting && workbench) { event.preventDefault(); void finishQuit(); } });
