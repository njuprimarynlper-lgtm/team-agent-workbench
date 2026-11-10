import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { _electron as electron, expect } from '@playwright/test';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';

const data = await fs.mkdtemp(path.resolve('.test-data/session-results-desktop-'));
const store = path.join(data, 'app'), personal = path.join(store, 'personal'), cwd = path.join(data, 'workspace');
await fs.mkdir(personal, { recursive: true }); await fs.mkdir(cwd, { recursive: true });
const cli = await authLauncher(path.join(data, 'cli'), { status: 'ready', turn: 'success' });
const project = { id: 'project_' + 'd'.repeat(32), name: '成果关联验收', remoteRoot: '/local-projects/results', uploadPath: '/local-projects/results/uploads', historyPath: '/local-projects/results/history' };
const owner = JSON.stringify(['personal', 22, 'local', 'PERSONAL']), bytes = 'only fetched on demand\n';
const localPath = path.join(data, 'cached.csv'), sha256 = createHash('sha256').update(bytes).digest('hex'); await fs.writeFile(localPath, bytes);
const result = { id: randomUUID(), projectId: project.id, title: '离线测试资料', content: '精确版本的成果正文', category: 'exploration', sources: [], accountOwner: owner, version: 1, updatedAt: new Date().toISOString(), localFiles: [{ id: randomUUID(), name: 'cached.csv', localPath, sha256, size: Buffer.byteLength(bytes) }] };
await fs.writeFile(path.join(personal, 'conclusions.json'), JSON.stringify([result]));
await fs.writeFile(path.join(personal, 'project-sync.json'), JSON.stringify({ accounts: { [owner]: { [project.id]: { project, localOnly: true, revision: 1, centralRevision: 0 } } } }));
await fs.writeFile(path.join(personal, 'settings.json'), JSON.stringify({ connections: [], codexRequestGuard: false, providerPaths: { codex: cli.launcher, cursor: cli.launcher, claude: cli.launcher }, lastWorkspace: '' }));
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
const target = await fs.realpath(process.argv[2] || 'dist/user');
const get = url => new Promise((resolve, reject) => {
  const req = http.get(url, { agent: false }, response => { let body = ''; response.on('data', part => { body += part; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) })); });
  req.setTimeout(3000, () => req.destroy(Error('gateway timeout'))); req.on('error', reject);
});
const quit = async app => {
  const exited = once(app.process(), 'exit'); await app.evaluate(({ app }) => app.quit()).catch(() => {});
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('工作台未完成正常退出')), 20000); })]); }
  finally { clearTimeout(timer); await app.close(); }
};
let app, sessionId, oldUrl;
try {
  app = await electron.launch({ args: [target], cwd: process.cwd(), env, timeout: 60000 });
  const page = await app.firstWindow(); await page.waitForURL(/index\.html$/); await page.locator('.rail').waitFor();
  const session = await page.evaluate(async p => window.workbench.call('session.create', p), { provider: 'codex', cwd, projectId: project.id, includeBrief: false, networkRoute: 'direct', desktopSync: false }); sessionId = session.id;
  const candidates = await page.evaluate(async id => window.workbench.call('session.resultCandidates', { id, scope: 'personal' }), sessionId);
  expect(candidates.items.map(item => item.reference.id)).toEqual([result.id]);
  const attached = await page.evaluate(async payload => window.workbench.call('session.attachResults', payload), { id: sessionId, references: candidates.items.map(item => item.reference) }); expect(attached.failed).toEqual([]);
  await expect(fs.stat(path.join(personal, 'result-attachment-cache', sha256))).rejects.toThrow();
  await page.evaluate(async id => window.workbench.call('session.send', { id, text: '检查成果', sourceIds: [] }), sessionId);
  await expect.poll(() => page.evaluate(async id => (await window.workbench.call('snapshot')).sessions.find(session => session.id === id)?.status, sessionId)).toBe('idle');
  const manifest = path.join(personal, 'sessions', sessionId, 'result-attachments.json');
  const url = async () => { const index = JSON.parse(await fs.readFile(manifest, 'utf8')); return JSON.parse(await fs.readFile(index.results[0].indexPath, 'utf8')).attachments[0].url; };
  oldUrl = await url();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
  const fetched = await get(oldUrl); expect(fetched.status).toBe(200); expect(await fs.readFile(fetched.body.path, 'utf8')).toBe(bytes);
  await quit(app); app = undefined; await expect(get(oldUrl)).rejects.toThrow();
  app = await electron.launch({ args: [target], cwd: process.cwd(), env, timeout: 60000 });
  const restored = await app.firstWindow(); await restored.waitForURL(/index\.html$/); await restored.locator('.rail').waitFor();
  await expect.poll(url).not.toBe(oldUrl);
  const fetchedAgain = await get(await url()); expect(fetchedAgain.status).toBe(200); expect(await fs.readFile(fetchedAgain.body.path, 'utf8')).toBe(bytes);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  console.log(JSON.stringify({ passed: true, checks: ['real IPC candidates and attachResults without central node', 'no bytes downloaded at association', 'next-turn index delivered', 'gateway continues in tray', 'explicit exit closes gateway', 'restart refreshes links and keeps cached bytes'], data }));
} finally { if (app) await quit(app); }
