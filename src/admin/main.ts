import { ownDataDirectory } from '../shared/single-instance';
import { app, BrowserWindow, ipcMain, dialog, clipboard, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { errorMessage } from '../shared/errors';
import { AdminConnection } from './connection';
import { LocalAdminConnection } from './local-connection';
import { adminProfileSchema, adminConnectSchema, adminOperationSchema } from './types';
import { adminEgressConfigSchema, encodeEgressInvite } from '../core/egress-config';
import { EgressRelay } from '../core/egress';
import { ensureEgressCertificate } from './egress-certificate';
import type { AdminEgressConfig } from '../shared/egress';
app.setName('Team Agent Admin');
app.setPath('userData', process.env.WORKBENCH_ADMIN_DATA_DIR || path.join(app.getPath('appData'), 'TeamAgentAdmin'));
let window: BrowserWindow; let remote: AdminConnection | LocalAdminConnection; let egress: EgressRelay; let egressConfig: AdminEgressConfig; let egressSecret: { accessCode: string; upstreamPassword?: string };
let storageAbort: AbortController | undefined;
const entry = path.join(__dirname, 'index.html');
if (ownDataDirectory(() => window)) app.whenReady().then(async () => {
  const config = path.join(app.getPath('userData'), 'connection.json');
  const egressConfigFile = path.join(app.getPath('userData'), 'egress.json'), egressSecretFile = path.join(app.getPath('userData'), 'egress-secrets.bin');
  const changed = () => { if (window && !window.isDestroyed()) window.webContents.send('admin:changed'); };
  const protect = (value: string) => safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8');
  const unprotect = (value: Buffer) => safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(value) : value.toString('utf8');
  egressConfig = { enabled: false, listenHost: '0.0.0.0', listenPort: 18443, publicHost: os.hostname(), upstreamMode: 'direct', upstreamHost: '', upstreamPort: 0, upstreamUsername: '', codex: true, cursor: true };
  try { egressConfig = adminEgressConfigSchema.parse(JSON.parse(await fs.readFile(egressConfigFile, 'utf8'))); } catch {}
  try { egressSecret = JSON.parse(unprotect(await fs.readFile(egressSecretFile))); } catch { egressSecret = { accessCode: randomBytes(24).toString('base64url') }; }
  const certificate = await ensureEgressCertificate(path.join(app.getPath('userData'), 'egress-tls'));
  egress = new EgressRelay(egressConfig, egressSecret, certificate); egress.on('changed', changed);
  const saveEgress = async () => { await fs.mkdir(app.getPath('userData'), { recursive: true }); await fs.writeFile(egressConfigFile, JSON.stringify(egressConfig, null, 2)); await fs.writeFile(egressSecretFile, protect(JSON.stringify(egressSecret)), { mode: 0o600 }); };
  await saveEgress(); if (egressConfig.enabled) await egress.start().catch(() => {});
  remote = new AdminConnection(path.join(__dirname, 'admin.py'), changed);
  try {
    const profile = adminProfileSchema.parse(JSON.parse(await fs.readFile(config, 'utf8')));
    remote.snapshot.profile = profile;
    if (profile.mode === 'local') {
      remote = new LocalAdminConnection(changed); remote.snapshot.profile = profile;
      try { await remote.connect(profile, '', '', async () => false); }
      catch (error) { remote.snapshot.connectionError = errorMessage(error); }
    }
  } catch {}
  window = new BrowserWindow({ width: 1320, height: 900, minWidth: 1040, minHeight: 720, show: process.env.WORKBENCH_TEST !== '1', title: '团队工作台 · 管理员版', backgroundColor: '#f6f7f9', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.setMenuBarVisibility(false); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault()); window.webContents.session.setPermissionRequestHandler((_c, _p, cb) => cb(false));
  ipcMain.handle('admin', async (event, action: string, payload: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== pathToFileURL(entry).href) return { ok: false, error: '不允许的调用来源' };
    try {
      let value;
      if (action === 'snapshot') value = { ...remote.snapshot, egress: { config: egressConfig, ...egress.snapshot(), inviteCode: encodeEgressInvite({ version: 1, host: egressConfig.publicHost, port: egressConfig.listenPort, fingerprint: certificate.fingerprint, accessCode: egressSecret.accessCode }), hasUpstreamPassword: !!egressSecret.upstreamPassword } };
      else if (action === 'egress.save') {
        const input = payload as any; const next = adminEgressConfigSchema.parse(input?.config);
        egressConfig = next;
        if (typeof input?.upstreamPassword === 'string' && input.upstreamPassword) egressSecret.upstreamPassword = input.upstreamPassword;
        if (input?.clearUpstreamPassword) delete egressSecret.upstreamPassword;
        await saveEgress(); await egress.restart(egressConfig, egressSecret); value = true;
      } else if (action === 'egress.rotate') {
        egressSecret.accessCode = randomBytes(24).toString('base64url'); await saveEgress(); await egress.restart(egressConfig, egressSecret); changed(); value = true;
      } else if (action === 'egress.copy') {
        const invite = encodeEgressInvite({ version: 1, host: egressConfig.publicHost, port: egressConfig.listenPort, fingerprint: certificate.fingerprint, accessCode: egressSecret.accessCode }); clipboard.writeText(invite); value = true;
      } else if (action === 'egress.test') { value = await egress.probe((payload as any)?.provider === 'cursor' ? 'cursor' : 'codex'); }
      else if (action === 'connect') {
        if (remote.snapshot.busy) throw new Error('请等待当前管理操作完成后更换连接');
        storageAbort?.abort(); storageAbort = undefined;
        const input = adminConnectSchema.parse(payload);
        remote.disconnect();
        remote = input.profile.mode === 'local' ? new LocalAdminConnection(changed) : new AdminConnection(path.join(__dirname, 'admin.py'), changed);
        value = await remote.connect(input.profile, input.password, input.sudoPassword, async fingerprint => (await dialog.showMessageBox(window, {
          type: 'question', title: '首次连接团队服务器', message: input.profile.host,
          detail: `当前管理员电脑尚未连接过这台服务器。请确认地址无误；确认后，本机会记住服务器身份，后续连接将自动验证。\n\n技术信息：${fingerprint}`,
          buttons: ['取消', '确认并连接'], defaultId: 0, cancelId: 0,
        })).response === 1);
        await fs.mkdir(path.dirname(config), { recursive: true }); await fs.writeFile(config, JSON.stringify(value, null, 2));
      } else if (action === 'choose.directory') value = (await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })).filePaths[0] || '';
      else if (action === 'disconnect') { if (remote.snapshot.busy) throw new Error('请等待操作完成'); storageAbort?.abort(); storageAbort = undefined; remote.disconnect(); value = true; }
      else if (action === 'operation') value = await remote.operation(adminOperationSchema.parse(payload));
      else if (action === 'storage.scan') {
        if (storageAbort) throw new Error('共享空间统计正在进行，请等待完成或取消');
        const controller = new AbortController(); storageAbort = controller;
        try { value = await remote.storageUsage(payload as any, controller.signal); }
        finally { if (storageAbort === controller) storageAbort = undefined; }
      } else if (action === 'storage.cancel') { storageAbort?.abort(); value = true; }
      else throw new Error('管理员版不支持此操作');
      return { ok: true, value };
    } catch (error: any) { return { ok: false, error: errorMessage(error) }; }
  });
  await window.loadFile(entry);
}).catch(e => { dialog.showErrorBox('管理员版启动失败', e.message); app.quit(); });
app.on('window-all-closed', () => app.quit()); app.on('before-quit', () => { storageAbort?.abort(); remote?.disconnect(); void egress?.stop(); });
