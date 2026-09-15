import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Workbench } from '../core/workbench';
import { settingsSchema, profileSchema } from '../core/config';
import { historyMarkdown, packageDraft, packageHistory } from '../core/artifacts';
import { resolveProvider } from '../core/providers';
import { spawnCLI } from '../core/rpc';
import type { WorkbenchEvent } from '../shared/types';
let window: BrowserWindow; let workbench: Workbench; let quitting = false;
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
  switch (action) {
    case 'snapshot': return workbench.snapshot();
    case 'settings.save': workbench.store.settings = settingsSchema.parse(raw); await workbench.store.save(); broadcast(); return true;
    case 'providers.detect': return workbench.detect();
    case 'choose.directory': return (await dialog.showOpenDialog(window, { properties: ['openDirectory'] })).filePaths[0] || '';
    case 'choose.executable': return (await dialog.showOpenDialog(window, { title: '选择 CLI 程序（不是编辑器）', properties: ['openFile'], filters: [{ name: 'CLI', extensions: ['exe', 'cmd', 'ps1'] }] })).filePaths[0] || '';
    case 'profile.import': {
      const file = (await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: '连接配置', extensions: ['json'] }] })).filePaths[0];
      if (!file) return null; const p = profileSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
      workbench.store.settings.connections = [...workbench.store.settings.connections.filter(x => x.id !== p.id), p]; await workbench.store.save(); broadcast(); return p;
    }
    case 'remote.connect': {
      const p = z.object({ profile: profileSchema, password: z.string().min(1).max(4096) }).parse(raw);
      const profile = await workbench.remote.connect(p.profile, p.password, async fingerprint => (await dialog.showMessageBox(window, { type: 'question', title: '核对共享服务器', message: `${p.profile.host}:${p.profile.port}`, detail: `首次连接，请与管理员提供的指纹核对：\n\n${fingerprint}\n\n确认后此连接将固定校验该指纹。`, buttons: ['取消', '指纹一致，连接'], defaultId: 0, cancelId: 0 })).response === 1);
      if (profile.manifestPath) { try { await workbench.remote.loadManifest(); } catch (e: any) { workbench.remote.disconnect(); throw new Error('项目入口清单读取失败，已断开连接：' + e.message); } }
      workbench.store.settings.connections = [...workbench.store.settings.connections.filter(x => x.id !== profile.id), profile]; await workbench.store.save(); broadcast(); return profile;
    }
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
    case 'session.create': { const p = z.object({ provider, cwd: text, projectId: z.string().optional() }).parse(raw); return workbench.createSession(p.provider, p.cwd, p.projectId); }
    case 'session.send': {
      const p = z.object({ id, text: text.min(1), sourceIds: z.array(z.string()).default([]) }).parse(raw); const s = workbench.session(p.id);
      if (s.title === '新会话') s.title = p.text.trim().slice(0, 40);
      void workbench.send(p.id, p.text, p.sourceIds).catch(e => notice(e.message)); return true;
    }
    case 'session.stop': return workbench.stop(sessionInput.parse(raw).id);
    case 'session.answer': { const p = z.object({ id, requestId: z.string(), option: z.string(), answers: z.record(z.string(), z.string()).optional() }).parse(raw); return workbench.answer(p.id, p.requestId, p.option, p.answers); }
    case 'session.attachLocal': { const p = sessionInput.parse(raw); return workbench.attachLocal(p.id, await chooseFiles()); }
    case 'session.attachRemote': { const p = z.object({ id, projectId: z.string(), path: text }).parse(raw); return workbench.attachRemote(p.id, p.projectId, p.path); }
    case 'session.autoUpload': { const p = z.object({ id, enabled: z.boolean() }).parse(raw); const s = workbench.session(p.id); if (p.enabled && (!s.binding || s.purpose !== 'work')) throw new Error('只有绑定远端项目的工作会话可开启自动上传'); s.autoUpload = p.enabled; await workbench.store.save(); broadcast(); return true; }
    case 'session.history': return historyMarkdown(workbench.session(sessionInput.parse(raw).id));
    case 'session.archive': return workbench.archive(sessionInput.parse(raw).id);
    case 'session.export': {
      const s = workbench.session(sessionInput.parse(raw).id); const target = await dialog.showSaveDialog(window, { defaultPath: `session-${s.id}.zip`, filters: [{ name: '会话归档', extensions: ['zip'] }] });
      if (!target.filePath) return false; const zip = await packageHistory(s, workbench.store.sessionDir(s.id), workbench.store.root); await fs.copyFile(zip, target.filePath); return true;
    }
    case 'handoff.read': return workbench.readHandoff(sessionInput.parse(raw).id);
    case 'handoff.save': { const p = z.object({ id, text }).parse(raw); return workbench.saveHandoff(p.id, p.text); }
    case 'draft.prepare': { const p = sessionInput.parse(raw); return workbench.prepare(p.id); }
    case 'draft.save': { const p = z.object({ id, title: z.string().min(1).max(120), body: text, fileIds: z.array(z.string()) }).parse(raw); return workbench.saveDraft(p.id, p.title, p.body, p.fileIds); }
    case 'draft.attach': { const p = sessionInput.parse(raw); return workbench.addDraftFiles(p.id, await chooseFiles()); }
    case 'draft.submit': { const p = z.object({ id, target: z.string().optional() }).parse(raw); return workbench.submitDraft(p.id, p.target); }
    case 'draft.export': {
      const d = workbench.draft(sessionInput.parse(raw).id); const target = await dialog.showSaveDialog(window, { defaultPath: 'contribution.zip', filters: [{ name: '成果包', extensions: ['zip'] }] }); if (!target.filePath) return false;
      const zip = await packageDraft(d, workbench.store.root); await fs.copyFile(zip, target.filePath); return true;
    }
    case 'transfer.retry': return workbench.queue.retry(sessionInput.parse(raw).id);
    case 'provider.login': {
      const p = z.object({ provider }).parse(raw); const executable = await resolveProvider(p.provider, workbench.store.settings.providerPaths[p.provider]);
      const process = spawnCLI(executable, ['login'], app.getPath('home')); let output = '';
      process.stdout.on('data', data => { output = (output + data.toString()).slice(-4000); notice(output); });
      process.stderr.on('data', data => { output = (output + data.toString()).slice(-4000); notice(output); });
      process.on('error', error => notice(error.message)); process.on('exit', code => notice(code === 0 ? 'CLI 登录完成，可返回创建会话' : '登录未完成，请在本机终端运行 ' + p.provider + ' login'));
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
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle('workbench', async (event, action, payload) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== pathToFileURL(entry).href) return { ok: false, error: '不允许的调用来源' };
    try { return { ok: true, value: await dispatch(z.string().parse(action), payload) }; } catch (e: any) { return { ok: false, error: e.message || '操作失败' }; }
  });
  await window.loadFile(entry);
}).catch(error => { dialog.showErrorBox('工作台启动失败', error.message); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => { if (!quitting && workbench) { event.preventDefault(); quitting = true; void workbench.close().finally(() => app.quit()); } });
