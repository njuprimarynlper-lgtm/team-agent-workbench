import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.split('=').slice(1).join('=');
const source = path.resolve(root, option('source') === 'baseline' ? '.test-data/error-audit/baseline' : option('source') || '.');
// Preserve the caller's path, including Windows 8.3 aliases, so the production
// entry-path normalization is exercised by the real Electron launch.
const buildDirectory = path.resolve(root, option('build') || path.join(source, 'dist'));
const canonicalBuildDirectory = await fs.realpath(buildDirectory);
const phase = option('phase');
const entryOnly = process.argv.includes('--entry-only');
const only = option('only');
const sourceVersion = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')).version;
if (!['before', 'after'].includes(phase)) throw Error('Use --phase=before or --phase=after');
const output = path.join(root, 'docs/error-audit'), screenshots = path.join(output, 'screenshots');
await fs.mkdir(screenshots, { recursive: true });
const data = path.join(root, '.test-data/error-audit/logs-' + phase + '-' + Date.now());
const cli = await authLauncher(path.join(data, 'cli'), { status: 'ready', turn: 'success', nativeHistory: true });
const reference = { id: '2a36b02a-8f04-449d-8c97-d06d7648de6e', operationId: '99f9a682-0f0a-4813-8c32-0df9c128da68' };
const reports = [];
for (const edition of entryOnly ? ['user'] : ['user', 'admin']) {
  if (only && !only.startsWith(`logs-${edition}-`)) continue;
  const directory = path.join(data, edition); await fs.mkdir(path.join(directory, 'logs'), { recursive: true });
  const scopes = edition === 'user' ? ['personal', 'window-state/1'].map(value => path.join(directory, value)) : [directory];
  if (edition === 'user') for (const scope of scopes) { await fs.mkdir(scope, { recursive: true }); await fs.writeFile(path.join(scope, 'settings.json'), JSON.stringify({ connections: [], providerPaths: { codex: cli.launcher, cursor: cli.launcher, claude: cli.launcher }, lastWorkspace: '' })); }
  const records = scopes.flatMap((scope, index) => Array.from({ length: 24 }, (_, offset) => ({ schema: 1, id: !index && !offset ? reference.id : randomUUID(), at: new Date(Date.now() - offset * 1000).toISOString(), version: '2.3.46', instance: randomUUID(), category: 'diagnostic', account: createHash('sha256').update(path.resolve(scope).toLowerCase()).digest('hex').slice(0, 24), operationId: reference.operationId, name: offset ? 'transfer.fixture.' + offset : 'transfer.failed', level: 'error', code: 'CENTRAL_CONNECTION_REFUSED', detail: 'connect ECONNREFUSED 192.0.2.10:22 token=FIXTURE_SECRET', stack: 'Error: connect ECONNREFUSED\n    at fixture-transfer (synthetic fixture)', ignoredPayload: 'NEVER_EXPOSE_PAYLOAD' })));
  await fs.writeFile(path.join(directory, 'logs', `diagnostic-${Date.now()}-${randomUUID()}.jsonl`), records.map(row => JSON.stringify(row)).join('\n') + '\n');
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: directory, WORKBENCH_ADMIN_DATA_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(buildDirectory, edition)], cwd: source, env, timeout: 60000 });
  let page;
  try {
    page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
    if (entryOnly && phase === 'before') {
      await expect(page.getByText('不允许的调用来源', { exact: true })).toBeInViewport({ ratio: 1 });
      const screenshot = 'screenshots/logs-user-source-path-before.png'; await page.screenshot({ path: path.join(output, screenshot) });
      reports.push({ id: 'logs-user-source-path', phase, edition, source, sourceVersion, buildDirectory, canonicalBuildDirectory, entry: '从 Windows 短路径启动用户端', condition: '8.3运行目录触发初始界面的可信来源误拒绝', observed: '初始界面显示“不允许的调用来源”，无法进入工作台', screenshot, fixture: 'fixed baseline Electron app with actual Windows 8.3 build path', viewportVerified: ['不允许的调用来源'] });
      continue;
    }
    if (edition === 'user') {
      await Promise.race([page.getByRole('button', { name: '跳过', exact: true }).waitFor(), page.getByRole('button', { name: '更多功能', exact: true }).waitFor()]);
      if (await page.getByRole('button', { name: '跳过', exact: true }).isVisible()) await page.getByRole('button', { name: '跳过', exact: true }).click();
      if (entryOnly) {
        await expect(page.getByRole('button', { name: '更多功能', exact: true })).toBeInViewport({ ratio: 1 });
        await expect(page.getByText('不允许的调用来源', { exact: true })).toHaveCount(0);
        const screenshot = 'screenshots/logs-user-source-path-after.png'; await page.screenshot({ path: path.join(output, screenshot) });
        reports.push({ id: 'logs-user-source-path', phase, edition, source, sourceVersion, buildDirectory, canonicalBuildDirectory, entry: '从 Windows 短路径启动用户端', condition: '8.3运行目录触发初始界面的可信来源误拒绝', observed: '同样用未规范化的8.3路径启动，初始工作台正常加载；没有误拒绝提示', screenshot, fixture: 'current production Electron app with actual Windows 8.3 build path', viewportVerified: ['更多功能'] });
        continue;
      }
      await page.getByRole('button', { name: '更多功能', exact: true }).click(); await page.getByRole('menuitem', { name: /日志与分析/ }).click();
    } else await page.getByRole('button', { name: '日志与分析', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '日志与分析', exact: true }); await expect(panel).toBeVisible();
    const capture = async (id, extra = {}) => {
      if (only && only !== `logs-${edition}-${id}`) return;
      await page.mouse.move(10, 10); // A hovered unrelated row must not look selected in a report.
      const name = `logs-${edition}-${id}-${phase}.png`; await page.screenshot({ path: path.join(screenshots, name) });
      reports.push({ id: `logs-${edition}-${id}`, phase, edition, source, buildDirectory, canonicalBuildDirectory, sourceVersion, capturedAt: new Date().toISOString(), fixture: 'isolated synthetic log records; real Electron LogsPanel; shell.openPath recorded at OS boundary', screenshot: `screenshots/${name}`, ...extra });
    };
    if (phase === 'before') {
      await capture('browse', { observed: '只有日志状态、导出与清理，没有最近故障列表和详情查询' });
      await capture('reference', { observed: '没有从错误定位到诊断记录的入口' });
      await capture('missing', { observed: '没有日志引用查询，无法说明记录已清理或不在当前范围' });
      await capture('pagination', { observed: '没有故障列表与分页入口' });
      await capture('unavailable', { observed: '没有故障查询功能，无法展示查询读取失败状态' });
    } else {
      await app.evaluate(({ shell }) => { globalThis.__auditOpenedLogDirectories = []; shell.openPath = async directory => { globalThis.__auditOpenedLogDirectories.push(directory); return ''; }; });
      const rejected = await page.evaluate(async edition => { try { await (edition === 'user' ? window.workbench : window.admin).call('logs.openDirectory', { path: 'C:\\not-an-authorized-log-directory' }); return false; } catch { return true; } }, edition);
      if (!rejected) throw Error('logs.openDirectory accepted a renderer-selected path');
      const openedBefore = await app.evaluate(() => globalThis.__auditOpenedLogDirectories); if (openedBefore.length) throw Error('forged path opened a directory');
      await page.evaluate(edition => (edition === 'user' ? window.workbench : window.admin).call('logs.openDirectory'), edition);
      const opened = await app.evaluate(() => globalThis.__auditOpenedLogDirectories); if (opened.at(-1) !== path.join(directory, 'logs')) throw Error('normal log directory must be derived by main');
      await expect(panel.getByRole('heading', { name: '最近故障', exact: true })).toBeVisible();
      await expect(panel.getByRole('button', { name: '查看 文件传输失败 日志' }).first()).toBeVisible();
      await panel.getByLabel('故障日志浏览').scrollIntoViewIfNeeded();
      await expect(panel.getByText('已显示 20 条记录 · 已读取 1 页', { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(panel.getByRole('button', { name: '加载更早故障', exact: true })).toBeInViewport({ ratio: 1 });
      await capture('browse', { observed: '当前账号范围显示20条/1页，加载更早故障控件在画面内', viewportVerified: ['已显示 20 条记录 · 已读取 1 页', '加载更早故障'] });
      await panel.getByRole('button', { name: '加载更早故障', exact: true }).click();
      await expect(panel.getByLabel('最近故障列表').locator('li')).toHaveCount(24);
      await panel.getByRole('group', { name: '故障记录分页', exact: true }).scrollIntoViewIfNeeded();
      await expect(panel.getByText('已显示 24 条记录 · 已读取 2 页', { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(panel.getByRole('button', { name: '当前查询没有更多记录', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(panel.getByRole('button', { name: '当前查询没有更多记录', exact: true })).toBeDisabled();
      await capture('pagination', { observed: '已显示24条/2页和当前查询没有更多记录提示均在画面内', viewportVerified: ['已显示 24 条记录 · 已读取 2 页', '当前查询没有更多记录'] });
      await panel.getByRole('button', { name: '查看 文件传输失败 日志' }).first().click();
      await expect(panel.getByLabel('技术错误详情')).toContainText('ECONNREFUSED');
      await expect(panel.getByLabel('技术错误详情')).not.toContainText('FIXTURE_SECRET');
      await panel.getByLabel('技术错误详情').scrollIntoViewIfNeeded();
      await expect(panel.getByLabel('技术错误详情')).toBeInViewport({ ratio: 1 });
      await capture('reference', { observed: '日志详情显示脱敏技术原文、错误编号和操作编号', viewportVerified: ['技术错误详情'] });
      await panel.getByRole('button', { name: '关闭', exact: true }).click();
      await page.evaluate(edition => window.dispatchEvent(new CustomEvent('workbench:view-logs', { detail: { id: '00000000-0000-4000-8000-000000000000' } })), edition);
      // No test-side scroll here: the initial missing reference must locate itself.
      await expect(page.getByText('这条日志没有找到，可能已过期或不属于当前账号和中央节点。请先检查登录的账号与中央节点；仍找不到时，可以打开日志文件夹。没有日志不代表原操作失败。', { exact: true })).toBeInViewport({ ratio: 1 });
      await capture('missing', { observed: '日志缺失时说明可能原因、检查账号和中央节点、打开日志文件夹的实际入口，未将缺失日志当作原操作失败', viewportVerified: ['这条日志没有找到', '打开日志文件夹'] });
      const logDirectory = path.join(directory, 'logs'), parkedLogs = path.join(directory, 'logs-fixture-parked');
      await fs.rename(logDirectory, parkedLogs); await fs.writeFile(logDirectory, 'fixture: log directory unavailable');
      try {
        await page.getByRole('button', { name: '刷新记录', exact: true }).click();
        await expect(page.getByText('最新故障记录没读出来。请点“重试读取”再试。', { exact: true })).toBeInViewport({ ratio: 1 });
        await expect(page.getByText(/下面是.*读取的旧记录/)).toBeInViewport({ ratio: 1 });
        await page.getByRole('button', { name: '打开日志文件夹', exact: true }).click();
        const fallbackMessage = page.getByText('日志文件夹打不开，已打开它所在的数据文件夹。请让维护人员检查其中名为 logs 的文件或文件夹。', { exact: true });
        await expect(fallbackMessage).toBeInViewport({ ratio: 1 });
        await expect(page.getByText('最新故障记录没读出来。请点“重试读取”再试。', { exact: true })).toBeInViewport({ ratio: 1 });
        await expect(page.getByText(/下面是.*读取的旧记录/)).toBeInViewport({ ratio: 1 });
        await expect(page.getByRole('button', { name: '打开日志文件夹', exact: true })).toBeInViewport({ ratio: 1 });
        const fallbackOpened = await app.evaluate(() => globalThis.__auditOpenedLogDirectories); if (fallbackOpened.at(-1) !== directory) throw Error('broken logs entry must open only main-derived data directory');
        await capture('unavailable', { observed: '一处提示说明最新读取失败、下方旧记录时间；可实际重试读取或打开主进程确定的日志文件夹，目录异常时打开其所在数据文件夹', viewportVerified: ['最新故障记录没读出来', '读取的旧记录', '打开日志文件夹', '已打开它所在的数据文件夹'], openDirectoryVerified: { rejectsRendererPath: true, logDirectory: path.join(directory, 'logs'), fallback: directory } });
      } finally { await fs.rm(logDirectory, { force: true }); await fs.rename(parkedLogs, logDirectory); }
      const untrustedFile = path.join(directory, 'untrusted-source-fixture.html'); await fs.writeFile(untrustedFile, '<meta charset="UTF-8"><p>Untrusted fixture source</p>');
      const foreign = await app.evaluate(async ({ BrowserWindow }, { file, edition }) => {
        const window = BrowserWindow.getAllWindows()[0]; await window.loadFile(file);
        return window.webContents.executeJavaScript(`window[${JSON.stringify(edition === 'user' ? 'workbench' : 'admin')}].call('snapshot').then(() => ({ blocked: false }), error => ({ blocked: true, message: error.message }))`);
      }, { file: untrustedFile, edition });
      if (!foreign.blocked || foreign.message !== '不允许的调用来源') throw Error('untrusted file source bypassed IPC entry verification');
      for (const row of reports.filter(row => row.phase === phase && row.edition === edition)) row.entryPathVerified = { preservedLaunchPath: buildDirectory, canonicalBuildDirectory, foreignFileRejected: true };
    }
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(data, edition + '-capture-failed.png') }).catch(() => {}); console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 3000)); }
    console.error(await app.evaluate(({ app, BrowserWindow }) => ({ appPath: app.getAppPath(), windows: BrowserWindow.getAllWindows().map(window => ({ url: window.webContents.getURL(), preload: window.webContents.getLastWebPreferences().preload })) })).catch(() => ({})));
    throw error;
  } finally { await app.close(); }
}
const reportFile = path.join(output, 'logs-scenarios.json');
const previous = JSON.parse(await fs.readFile(reportFile, 'utf8').catch(() => '{"scenarios":[]}'));
const capturedIds = new Set(reports.map(row => row.id));
await fs.writeFile(reportFile, JSON.stringify({ schema: 1, scenarios: [...previous.scenarios.filter(row => row.phase !== phase || !capturedIds.has(row.id)), ...reports] }, null, 2));
console.log(`Logs ${phase} screenshots verified: ${reports.length}. ${reportFile}`);
