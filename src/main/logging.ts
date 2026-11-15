import { app, BrowserWindow, dialog, powerMonitor } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import { configureLogs, accountLogScope, logVersion, redactLogText } from '../core/logging';
import { exportLogs } from '../core/log-export';
import { traceFiles } from '../core/trace-reader';
import fs from 'node:fs/promises';
import type { LogScope } from '../shared/logs';
import { randomUUID } from 'node:crypto';

const filterSchema = z.object({ kind: z.enum(['diagnostic', 'workflow', 'trace']), from: z.string().datetime().optional(), to: z.string().datetime().optional(), projectId: z.string().max(120).optional(), sessionId: z.string().uuid().optional(), description: z.string().max(2000).optional() }).strict();
export function installLogging(root: string, edition: 'user' | 'admin') {
  const logger = configureLogs(root);
  logger.record('diagnostic', 'app.started', {}, { code: edition });
  const diagnostic = (name: string, error: unknown) => { logger.record('diagnostic', name, {}, { level: 'error', detail: redactLogText(error), stack: error instanceof Error ? error.stack : undefined }); };
  process.on('uncaughtExceptionMonitor', error => logger.emergency(error));
  process.on('unhandledRejection', error => diagnostic('app.unhandled_rejection', error));
  app.on('child-process-gone', (_event, detail) => { if (detail.reason !== 'clean-exit') logger.record('diagnostic', 'app.child_exit', {}, { level: detail.reason === 'killed' ? 'info' : 'error', code: detail.type, outcome: detail.reason, count: detail.exitCode }); });
  app.on('browser-window-created', (_event, window) => {
    window.webContents.on('preload-error', (_event, _file, error) => diagnostic('renderer.preload_failed', error));
    window.webContents.on('render-process-gone', (_event, detail) => logger.record('diagnostic', 'renderer.exited', {}, { level: 'error', outcome: detail.reason, count: detail.exitCode }));
    window.webContents.on('did-fail-load', (_event, code, description) => logger.record('diagnostic', 'renderer.load_failed', {}, { level: 'error', code: String(code), detail: description }));
    let visible = false;
    window.on('focus', () => { if (!visible) { visible = true; logger.record('workflow', 'window.active', {}, { outcome: 'entered' }); } });
    window.on('blur', () => { if (visible) { visible = false; logger.record('workflow', 'window.active', {}, { outcome: 'left' }); } });
  });
  app.whenReady().then(() => {
    const startupSource = process.env.WORKBENCH_STARTUP_LOG_DIR || path.join(root, 'logs', 'startup');
    const importStartup = () => void logger.ingestStartup(startupSource, edition).catch(() => {});
    const startupTimer = setInterval(importStartup, 60000); startupTimer.unref();
    const initialStartup = setTimeout(importStartup, 6000); initialStartup.unref();
    app.once('will-quit', () => { clearInterval(startupTimer); clearTimeout(initialStartup); });
    let idle: boolean | undefined;
    const presence = setInterval(() => { const next = powerMonitor.getSystemIdleTime() >= 120; if (next !== idle) { idle = next; logger.record('workflow', 'user.presence', { origin: 'user' }, { outcome: next ? 'idle' : 'active' }); } }, 30000); presence.unref();
    app.once('will-quit', () => clearInterval(presence));
    powerMonitor.on('suspend', () => logger.record('workflow', 'system.suspend'));
    powerMonitor.on('resume', () => logger.record('workflow', 'system.resume'));
    logger.on('storage-error', () => { /* Status panel exposes the error without recursive logging or chat notices. */ });
    void logger.files().then(() => logger.status([])).catch(() => {});
  });
  return logger;
}

export async function handleLogAction(action: string, raw: unknown, owner: BrowserWindow, root: string, scopeRoot: string, validateSession: (id: string) => boolean, context: { projectId?: string; provider?: string; route?: string; traceIncomplete?: boolean; providers?: { provider: string; version: string; path: string; available: boolean }[] } = {}) {
  const logger = configureLogs(root), scope = accountLogScope(scopeRoot);
  if (action === 'logs.rendererError') {
    const input = z.object({ type: z.enum(['error', 'unhandledrejection']), message: z.string().max(2000), stack: z.string().max(8000).optional() }).strict().parse(raw);
    logger.record('diagnostic', 'renderer.' + input.type, scope, { level: 'error', detail: input.message, stack: input.stack }); return true;
  }
  if (action === 'logs.interaction') {
    const input = z.object({ view: z.enum(['updates', 'assignments', 'sessions', 'files', 'results', 'drafts', 'transfers', 'directions', 'scheduled', 'recommendations', 'questions', 'rsi', 'subsessions', 'sidechats']), projectId: z.string().max(120).optional() }).strict().parse(raw);
    logger.record('workflow', 'view.opened', { ...scope, projectId: input.projectId, origin: 'user' }, { code: input.view }); return true;
  }
  if (action === 'logs.status') return logger.status([scopeRoot]);
  if (action === 'logs.cleanup') {
    if (logger.exporting || logger.exportPending) throw Error('正在导出日志，请完成导出后再清理');
    const input = z.object({ kind: z.enum(['ordinary', 'trace']), sessionId: z.string().uuid().optional() }).parse(raw);
    if (input.kind === 'ordinary') {
      const confirmation = await dialog.showMessageBox(owner, { type: 'question', message: '清理故障排查和工作流日志？', detail: '会话、完整执行轨迹、成果和附件保留。', buttons: ['取消', '清理'], defaultId: 0, cancelId: 0 }); if (confirmation.response !== 1) return { canceled: true };
      await logger.cleanup(); return { ok: true };
    }
    if (!input.sessionId || !validateSession(input.sessionId)) throw Error('会话不存在、正在执行或不属于当前账号');
    const confirmation = await dialog.showMessageBox(owner, { type: 'warning', message: '删除所选会话的完整执行轨迹？', detail: '对话和成果保留；AI 推荐与后续轨迹上传将缺少这些底层执行细节。此操作无法撤销。', buttons: ['取消', '删除轨迹'], defaultId: 0, cancelId: 0 }); if (confirmation.response !== 1) return { canceled: true };
    if (!validateSession(input.sessionId)) throw Error('会话状态已变化，未删除执行轨迹');
    const directory = path.join(scopeRoot, 'sessions', input.sessionId), snapshot = await logger.traceSnapshot(directory);
    if (!validateSession(input.sessionId)) throw Error('会话已开始执行，未删除执行轨迹');
    for (const file of snapshot) await fs.rm(file); return { ok: true };
  }
  if (action === 'logs.export') {
    const input = filterSchema.parse(raw);
    if (input.from && input.to && input.from > input.to) throw Error('开始时间不能晚于结束时间');
    if (input.kind === 'trace') {
      if (!input.sessionId || !validateSession(input.sessionId)) throw Error('请选择当前账号内已停止执行的会话');
      const confirmation = await dialog.showMessageBox(owner, { type: 'warning', message: '完整轨迹包含对话和工具执行内容', detail: '仅在确认可以分享这些资料时导出。普通诊断包无需包含完整轨迹。', buttons: ['取消', '导出完整轨迹'], defaultId: 0, cancelId: 0 }); if (confirmation.response !== 1) return { canceled: true };
    }
    if (logger.exporting || logger.exportPending) throw Error('正在导出日志');
    logger.exportPending = true;
    try {
      const selected = await dialog.showSaveDialog(owner, { title: '导出日志', defaultPath: `TeamAgent-${input.kind}-v${logVersion}-${Date.now()}.zip`, filters: [{ name: '日志包', extensions: ['zip'] }] });
      if (selected.canceled || !selected.filePath) return { canceled: true };
      return await exportLogs(logger, selected.filePath, input, { replace: true, account: scope.account, traceDirectory: input.sessionId ? path.join(scopeRoot, 'sessions', input.sessionId) : undefined, environment: { electron: process.versions.electron, chrome: process.versions.chrome }, configuration: context });
    } finally { logger.exportPending = false; }
  }
  throw Error('未知日志操作');
}

const ignored = /^(snapshot|logs\.|layout\.|session\.(input|page|messages|file|native\.refresh)|sidechat\.draft|(?:sidechat|subsession)\.history|scheduledTask\.(list|location|runs|history)|content\.(list|preview)|providers\.|catalog|choose\.|workspace\.select)/;
const readOnly = /^(rsi\.(settings|view|inbox)|question\.(members|sync)|activity\.project|directions\.list|content\.(history|sync|updates)|project\.(brief|directory\.impact)|session\.(resultCandidates|source\.preview|projectContext|history|mcp|capabilities)|journal\.project|egress\.(snapshot|status))$/;
export function logOperation(root: string, scopeRoot: string, action: string, scope: LogScope, origin: 'user' | 'background' = 'user') {
  const logger = configureLogs(root), started = performance.now(), operationId = randomUUID();
  const observed = !ignored.test(action) && !readOnly.test(action);
  if (observed) logger.record('workflow', action, accountLogScope(scopeRoot, { ...scope, operationId, origin }), { outcome: 'requested' });
  return Object.assign((error?: unknown) => {
    const fields = { outcome: error ? 'failed' : 'succeeded', durationMs: performance.now() - started };
    if (observed) logger.record('workflow', action, accountLogScope(scopeRoot, { ...scope, operationId, origin }), fields);
    if (error) logger.record('diagnostic', action, accountLogScope(scopeRoot, { ...scope, operationId, origin }), { ...fields, level: 'error', detail: redactLogText(error), stack: error instanceof Error ? error.stack : undefined });
  }, { operationId });
}
