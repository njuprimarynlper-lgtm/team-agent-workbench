import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import { randomUUID } from 'node:crypto';
import type { LogExportInput, LogRecord } from '../shared/logs';
import { LogService, logVersion, redactLogText } from './logging';
import { traceStream } from './trace-reader';

export async function exportLogs(logger: LogService, destination: string, input: LogExportInput, options: { account?: string; traceDirectory?: string; environment?: object; configuration?: object; replace?: boolean } = {}) {
  if (logger.exporting) throw Error('正在导出日志，请等待当前导出完成');
  if (input.kind === 'trace' && !options.traceDirectory) throw Error('请选择当前账号的会话');
  logger.exporting = true;
  const coverage = { malformed: 0, missingFiles: 0, emitted: 0, suppressed: 0, globallySuppressedSinceLaunch: 0, notice: '普通日志受保留时间、空间上限及限流影响；缺少事件不能据此判断用户没有操作。无操作时段不等于低效。globallySuppressedSinceLaunch 是本客户端所有账号从本次启动起的抑制数，不等于所选范围的缺失数。' };
  const totals = new Map<string, { projectId?: string; operation: string; code?: string; origin?: string; count: number; requested: number; succeeded: number; failed: number; canceled: number; durationMs: number; timedCount: number }>();
  let output: fs.WriteStream | undefined;
  let created = false;
  const writePath = options.replace ? destination + '.' + randomUUID() + '.pending' : destination;
  try {
    await logger.flush();
    coverage.globallySuppressedSinceLaunch = (await logger.status([])).suppressed;
    const traceSnapshot = input.kind === 'trace' ? await logger.traceSnapshot(options.traceDirectory!) : undefined;
    const files = input.kind === 'trace' ? [] : (await logger.files()).filter(file => file.category === input.kind);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const handle = await fsp.open(writePath, 'wx', 0o600); created = true; output = handle.createWriteStream();
    const done = pipeline(archive, output); done.catch(() => {});
    async function* selected() {
      for (const file of files) {
        let handle, compressed = file.file.endsWith('.gz');
        try { handle = await fsp.open(file.file, 'r'); }
        catch { try { if (compressed) throw Error(); handle = await fsp.open(file.file + '.gz', 'r'); compressed = true; } catch { coverage.missingFiles++; continue; } }
        const stat = await handle.stat(); if (!stat.size) { await handle.close(); continue; }
        const raw = handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: true }), source = compressed ? raw.pipe(createGunzip()) : raw;
        const lines = createInterface({ input: source, crlfDelay: Infinity });
        try { for await (const line of lines) {
          let row: LogRecord; try { row = JSON.parse(line); } catch { coverage.malformed++; continue; }
          if (row.schema !== 1 || row.category !== input.kind) continue;
          if (options.account && row.account && row.account !== options.account) continue;
          if (input.projectId && row.projectId !== input.projectId || input.sessionId && row.sessionId !== input.sessionId) continue;
          if (input.from && row.at < input.from || input.to && row.at > input.to) continue;
          // Rebuild the export whitelist rather than copying unknown on-disk fields.
          const safe: LogRecord = { schema: 1, id: row.id, at: row.at, version: row.version, instance: row.instance, category: row.category, name: row.name, account: row.account, projectId: row.projectId, sessionId: row.sessionId, turnId: row.turnId, operationId: row.operationId, origin: row.origin, provider: row.provider, route: row.route, outcome: row.outcome, level: row.level, durationMs: row.durationMs, code: row.code, count: row.count, lastAt: row.lastAt, suppressed: row.suppressed,
            entityId: row.entityId, relatedIds: row.relatedIds,
            ...(input.kind === 'diagnostic' ? { detail: row.detail ? redactLogText(row.detail) : undefined, stack: row.stack ? redactLogText(row.stack, 8000) : undefined } : {}) };
          coverage.emitted++; coverage.suppressed += row.suppressed || 0;
          const key = JSON.stringify([row.projectId, row.name, row.code, row.origin]), total = totals.get(key) || { projectId: row.projectId, operation: row.name, code: row.code, origin: row.origin, count: 0, requested: 0, succeeded: 0, failed: 0, canceled: 0, durationMs: 0, timedCount: 0 };
          if (['requested', 'started'].includes(row.outcome || '')) total.requested++; else total.count++;
          if (['succeeded', 'completed', 'accepted'].includes(row.outcome || '')) total.succeeded++;
          if (['failed', 'error'].includes(row.outcome || '')) total.failed++;
          if (['canceled', 'stopped'].includes(row.outcome || '')) total.canceled++;
          if (Number.isFinite(row.durationMs)) { total.durationMs += row.durationMs!; total.timedCount++; } totals.set(key, total);
          yield JSON.stringify(safe) + '\n';
        } } finally { lines.close(); source.destroy(); raw.destroy(); }
      }
    }
    if (input.kind === 'trace') archive.append(traceStream(options.traceDirectory!, traceSnapshot), { name: 'events.jsonl' });
    else archive.append(Readable.from(selected()), { name: input.kind + '.jsonl' });
    // Queue the manifest after the streamed rows so its counters are final.
    const tail = new Readable({ read() {} });
    archive.append(tail, { name: 'report.json' });
    let finishedRows = false;
    archive.on('entry', entry => { if (entry.name.endsWith('.jsonl') && !finishedRows) { finishedRows = true; tail.push(JSON.stringify({ schemaVersion: 1, version: logVersion, exportedAt: new Date().toISOString(), kind: input.kind, filter: { ...input, description: undefined }, description: input.description ? redactLogText(input.description, 2000) : undefined, environment: { platform: process.platform, arch: process.arch, release: os.release(), node: process.versions.node, ...options.environment }, configuration: options.configuration, coverage, summary: [...totals.values()], traceContainsConversation: input.kind === 'trace' }, null, 2)); tail.push(null); } });
    archive.append('schema=1；时间为 ISO 8601；operationId 关联操作阶段；origin=user/ai/background。durationMs 为该事件注明的阶段耗时，不能跨阶段重复相加，也不能推断为用户劳动时间。普通包不含对话、工具正文、附件或认证信息。\n', { name: '字段说明.txt' });
    await archive.finalize(); await done;
    if (options.replace) await fsp.rename(writePath, destination);
    return { path: destination, records: coverage.emitted };
  } catch (error) {
    output?.destroy(); if (created) await fsp.rm(writePath, { force: true }).catch(() => {}); throw error;
  } finally { logger.exporting = false; }
}
