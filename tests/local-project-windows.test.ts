import { legacyLocalProject } from './fixtures/legacy-local-project';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Workbench } from '../src/core/workbench';
import { PERSONAL_PROJECT_ID } from '../src/shared/personal-workspace';
import type { Snapshot } from '../src/shared/types';
// @ts-expect-error Background-only SSH fixture.
import { teamServer } from './fixtures/team-server.mjs';

// Production main-process lifecycle and disk persistence, with no real Electron windows or models.
test('local project selection survives startup with and without a server account and stays separate per window', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-local-windows-')));
  const base = path.join(root, 'data'), server = await teamServer();
  const local = new Workbench(path.join(base, 'personal'), () => {}, () => {}, undefined, () => ({}), undefined, undefined, undefined, true);
  await local.store.init(); await local.restoreLocalWorkspace();
  const projectA = await legacyLocalProject(local, '算法研究'), projectB = await legacyLocalProject(local, '软件开发');
  const session = await local.createSession('codex', root, projectA.id); await local.close();
  const seed = new Workbench(path.join(base, 'instances', '2'), () => {}, () => {});
  await seed.store.init(); await seed.configureWorkspace(server.profile('alice'), 'test-password', '', async () => true);
  const teamProject = await seed.createProject('团队项目'); await seed.projectSync.sync(); await seed.refreshGroups();
  const profile = structuredClone(seed.remote.profile!); await seed.close();
  const stateFile = (slot: number) => path.join(base, 'window-state', slot + '.json');
  const saved = async (slot: number) => JSON.parse(await fs.readFile(stateFile(slot), 'utf8'));
  await fs.mkdir(path.dirname(stateFile(1)), { recursive: true });
  await fs.writeFile(stateFile(1), JSON.stringify({ selectedProjectId: projectA.id, sidebarProjectHeight: 350, sidebarPanes: { workgroups: 240 } }));
  await fs.writeFile(stateFile(2), JSON.stringify({ profile, selectedProjectId: projectB.id }));
  const opened: FakeWindow[] = [], dialogs: string[] = [], app = new EventEmitter() as any;
  const ipc = new Map<string, Function>(), paths: Record<string, string> = { appData: root, home: root };
  let didQuit = false;
  Object.assign(app, { setName() {}, setAppUserModelId() {}, setPath(key: string, value: string) { paths[key] = value; }, getPath(key: string) { return paths[key]; }, requestSingleInstanceLock: () => true, whenReady: async () => {}, quit() { didQuit = true; } });
  class FakeWindow extends EventEmitter {
    destroyed = false; entry = '';
    webContents = Object.assign(new EventEmitter(), { send() {}, setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {} } });
    constructor(_options: unknown) { super(); opened.push(this); }
    static fromWebContents(contents: unknown) { return opened.find(window => window.webContents === contents); }
    static getFocusedWindow() { return opened.find(window => !window.destroyed); }
    isDestroyed() { return this.destroyed; } isFocused() { return false; } isMinimized() { return false; }
    flashFrame() {} setMenuBarVisibility() {} focus() {} show() {} hide() {} restore() {}
    async loadFile(file: string) { this.entry = file; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    close() { this.emit('close', { preventDefault() {} }); }
  }
  const electron = { app, BrowserWindow: FakeWindow, ipcMain: { handle(name: string, fn: Function) { ipc.set(name, fn); } }, dialog: { showMessageBox: async () => ({ response: 1 }), showErrorBox: (_title: string, message: string) => dialogs.push(message) }, safeStorage: { isEncryptionAvailable: () => false }, shell: {}, clipboard: {} };
  const loader = (Module as any)._load, detect = Workbench.prototype.detect;
  const oldData = process.env.WORKBENCH_DATA_DIR, oldTest = process.env.WORKBENCH_TEST;
  (Module as any)._load = function (name: string, ...args: any[]) { return name === 'electron' ? electron : loader.call(this, name, ...args); };
  Workbench.prototype.detect = async () => [];
  process.env.WORKBENCH_DATA_DIR = base; process.env.WORKBENCH_TEST = '1';
  async function until(check: () => boolean) {
    const end = Date.now() + 10000;
    while (!check()) { if (Date.now() > end) throw new Error('window lifecycle timed out: ' + dialogs.join('; ')); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  t.after(async () => {
    app.emit('before-quit', { preventDefault() {} }); await until(() => didQuit);
    (Module as any)._load = loader; Workbench.prototype.detect = detect;
    if (oldData === undefined) delete process.env.WORKBENCH_DATA_DIR; else process.env.WORKBENCH_DATA_DIR = oldData;
    if (oldTest === undefined) delete process.env.WORKBENCH_TEST; else process.env.WORKBENCH_TEST = oldTest;
    await server.close(); assert.equal(path.dirname(root), await fs.realpath(os.tmpdir())); assert(path.basename(root).startsWith('workbench-local-windows-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await import('../src/main/index'); await until(() => !!opened[0]?.entry);
  async function call(window: FakeWindow, action: string, payload?: unknown) {
    const response = await ipc.get('workbench')!({ sender: window.webContents, senderFrame: { url: pathToFileURL(window.entry).href } }, action, payload);
    if (!response.ok) throw new Error(response.error); return response.value;
  }
  const snapshot = (window: FakeWindow): Promise<Snapshot> => call(window, 'snapshot');
  const first = opened[0], initial = await snapshot(first);
  assert.equal(initial.selectedProjectId, projectA.id, 'profile-less startup must not erase the selection');
  assert.equal(initial.settings.sidebarProjectHeight, 350); assert.equal(initial.settings.sidebarPanes?.workgroups, 240);
  assert.equal(initial.settings.workspaceSnapshot, undefined);
  assert(initial.personal?.settings.workspaceSnapshot?.profile.projects.some(project => project.id === projectA.id));
  assert(initial.sessions.some(item => item.id === session.id));
  await call(first, 'session.rename', { id: session.id, title: '重启后继续本机项目' });
  assert.equal((await snapshot(first)).sessions.find(item => item.id === session.id)?.title, '重启后继续本机项目');
  app.emit('second-instance'); await until(() => !!opened[1]?.entry);
  const second = opened[1];
  assert.equal((await snapshot(second)).selectedProjectId, projectB.id, 'a saved server account may also select a local project');
  assert.equal((await snapshot(second)).settings.workspaceSnapshot?.profile.username, 'alice');
  await call(second, 'workspace.select', { personal: false, projectId: teamProject.id });
  assert.equal((await saved(2)).selectedProjectId, teamProject.id);
  await call(second, 'workspace.select', { personal: true, projectId: projectA.id });
  assert.equal((await saved(2)).selectedProjectId, projectA.id);
  await assert.rejects(call(first, 'workspace.select', { personal: true, projectId: teamProject.id }), /本机项目已不存在/);
  assert.equal((await saved(1)).selectedProjectId, projectA.id);
  // Delay the first save to reproduce rapid project changes racing a layout save.
  const rename = fs.rename; let delayNext = true;
  fs.rename = async (...args) => {
    if (delayNext && String(args[1]) === stateFile(1)) { delayNext = false; await new Promise(resolve => setTimeout(resolve, 60)); }
    return rename(...args);
  };
  try {
    await Promise.all([
      call(first, 'workspace.select', { personal: true, projectId: projectB.id }),
      call(first, 'layout.sidebar', { height: 500 }),
      call(first, 'workspace.select', { personal: true, projectId: PERSONAL_PROJECT_ID }),
    ]);
  } finally { fs.rename = rename; }
  assert.equal((await saved(1)).selectedProjectId, PERSONAL_PROJECT_ID);
  assert.equal((await saved(1)).sidebarProjectHeight, 500);
  assert.equal((await snapshot(first)).selectedProjectId, PERSONAL_PROJECT_ID);
  assert.equal((await saved(2)).selectedProjectId, projectA.id, 'another window must keep its own selection');
  second.close(); await until(() => second.destroyed);
  app.emit('second-instance'); await until(() => !!opened[2]?.entry);
  assert.equal((await snapshot(opened[2])).selectedProjectId, projectA.id, 'reopening an account window restores its local project');
  assert.equal((await snapshot(opened[2])).settings.workspaceSnapshot?.profile.username, 'alice');
  assert.deepEqual(dialogs, []);
});
