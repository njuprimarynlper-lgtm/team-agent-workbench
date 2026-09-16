import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { AdminConnection } from './connection';
import { LocalAdminConnection } from './local-connection';
import { adminProfileSchema, adminOperationSchema } from './types';
import { memberConfig } from './member-config';
app.setName('Team Agent Admin');
app.setPath('userData', process.env.WORKBENCH_ADMIN_DATA_DIR || path.join(app.getPath('appData'), 'TeamAgentAdmin'));
let window: BrowserWindow; let remote: AdminConnection | LocalAdminConnection;
const entry = path.join(__dirname, 'index.html');
app.whenReady().then(async () => {
  const config = path.join(app.getPath('userData'), 'connection.json');
  remote = new AdminConnection(path.join(__dirname, 'admin.py'), () => { if (window && !window.isDestroyed()) window.webContents.send('admin:changed'); });
  try { remote.snapshot.profile = adminProfileSchema.parse(JSON.parse(await fs.readFile(config, 'utf8'))); } catch {}
  window = new BrowserWindow({ width: 1320, height: 900, minWidth: 1040, minHeight: 720, show: process.env.WORKBENCH_TEST !== '1', title: '团队工作台 · 管理员版', backgroundColor: '#f6f7f9', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.setMenuBarVisibility(false); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault()); window.webContents.session.setPermissionRequestHandler((_c, _p, cb) => cb(false));
  ipcMain.handle('admin', async (event, action: string, payload: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== pathToFileURL(entry).href) return { ok: false, error: '不允许的调用来源' };
    try {
      let value;
      if (action === 'snapshot') value = remote.snapshot;
      else if (action === 'connect') {
        if (remote.snapshot.busy) throw new Error('请等待当前管理操作完成后更换连接');
        const input = z.object({ profile: adminProfileSchema, password: z.string().min(1).max(4096), sudoPassword: z.string().max(4096).default('') }).parse(payload);
        remote.disconnect();
        const changed = () => { if (window && !window.isDestroyed()) window.webContents.send('admin:changed'); };
        remote = input.profile.mode === 'local' ? new LocalAdminConnection(changed) : new AdminConnection(path.join(__dirname, 'admin.py'), changed);
        value = await remote.connect(input.profile, input.password, input.sudoPassword, async fingerprint => (await dialog.showMessageBox(window, { type: 'question', title: '核对服务器身份', message: input.profile.host, detail: '请与运维提供的 SSH 主机指纹核对：\n\n' + fingerprint, buttons: ['取消', '指纹一致，连接'], defaultId: 0, cancelId: 0 })).response === 1);
        await fs.mkdir(path.dirname(config), { recursive: true }); await fs.writeFile(config, JSON.stringify(value, null, 2));
      } else if (action === 'choose.directory') value = (await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })).filePaths[0] || '';
      else if (action === 'disconnect') { if (remote.snapshot.busy) throw new Error('请等待操作完成'); remote.disconnect(); value = true; }
      else if (action === 'operation') value = await remote.operation(adminOperationSchema.parse(payload));
      else if (action === 'member.export') {
        const input = z.object({ username: z.string(), group: z.string() }).parse(payload);
        await remote.operation({ op: 'status' });
        const profile = memberConfig(remote.snapshot.profile!, remote.snapshot.state!, input.username, input.group);
        const result = await dialog.showSaveDialog(window, { defaultPath: `${input.username}-${input.group}.json`, filters: [{ name: '成员连接配置（不含密码）', extensions: ['json'] }] });
        if (result.filePath) await fs.writeFile(result.filePath, JSON.stringify(profile, null, 2), { mode: 0o600 });
        value = !!result.filePath;
      }
      else throw new Error('管理员版不支持此操作');
      return { ok: true, value };
    } catch (error: any) { return { ok: false, error: error.message }; }
  });
  await window.loadFile(entry);
}).catch(e => { dialog.showErrorBox('管理员版启动失败', e.message); app.quit(); });
app.on('window-all-closed', () => app.quit()); app.on('before-quit', () => remote?.disconnect());
