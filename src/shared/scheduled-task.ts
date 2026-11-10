import { z } from 'zod';
import type { AgentSession, SourceFile } from './types';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '请选择有效时间');
const timezone = z.string().min(1).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; } }, '时区无效');
export const scheduledScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.iso.datetime(), timezone }),
  z.object({ kind: z.literal('hourly'), intervalHours: z.number().int().min(1).max(8760), anchor: z.iso.datetime(), timezone }),
  z.object({ kind: z.literal('daily'), time, timezone }),
  z.object({ kind: z.literal('weekdays'), time, timezone }),
  z.object({ kind: z.literal('weekly'), time, days: z.array(z.number().int().min(0).max(6)).min(1).max(7), timezone }),
]);
export type ScheduledSchedule = z.infer<typeof scheduledScheduleSchema>;
export const scheduledTaskInputSchema = z.object({
  projectId: z.string().min(1).refine(id => id !== '__personal__', '请先选择项目'), name: z.string().trim().min(1).max(120), prompt: z.string().trim().min(1).max(64000),
  supplement: z.string().max(64000).default(''), schedule: scheduledScheduleSchema,
  includeBrief: z.boolean().default(true), model: z.string().max(200).default(''), reasoningEffort: z.string().max(30).optional(),
  permissionMode: z.enum(['inherit', 'review', 'auto', 'full']).default('inherit'), networkRoute: z.enum(['direct', 'management']).default('direct'),
  sourceIds: z.array(z.string().uuid()).max(100).default([]),
});
export type ScheduledTaskInput = z.infer<typeof scheduledTaskInputSchema>;
export interface ScheduledTask extends ScheduledTaskInput {
  id: string; projectName: string; createdAt: string; updatedAt: string; paused: boolean; deletedAt?: string;
  cwd: string; followsDirectory: boolean; nextRunAt?: string; sources: SourceFile[];
  activeRun?: { id: string; status: ScheduledRunStatus };
}
export type ScheduledRunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export interface ScheduledRun {
  id: string; taskId: string; taskName: string; projectId: string; projectName: string; sessionId: string;
  scheduledAt: string; createdAt: string; startedAt?: string; finishedAt?: string; manual: boolean;
  status: ScheduledRunStatus; summary?: string; error?: string; messageCount?: number; continued?: boolean;
  context?: { briefRevision?: number; sources: { id: string; sha256: string; name: string }[] };
}
export interface ScheduledRunSession { run: ScheduledRun; session: AgentSession; earlierCount: number }
export const activeScheduledRun = (run: ScheduledRun) => ['queued', 'running', 'waiting'].includes(run.status);
export const scheduledStatus: Record<ScheduledRunStatus, string> = { queued: '排队中', running: '执行中', waiting: '等待处理', completed: '已完成', failed: '执行失败', stopped: '已停止', interrupted: '已中断' };

const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(at: number, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); formatters.set(zone, formatter); }
  const p = Object.fromEntries(formatter.formatToParts(at).map(item => [item.type, item.value]));
  return [Number(p.year), Number(p.month), Number(p.day), Number(p.hour), Number(p.minute)];
}
function wallTime(date: number[], hour: number, minute: number, zone: string, after: number) {
  const target = Date.UTC(date[0], date[1] - 1, date[2], hour, minute);
  let guess = target;
  for (let i = 0; i < 3; i++) { const p = localParts(guess, zone); guess += target - Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4]); }
  // Test both sides of a DST overlap; nonexistent wall times are skipped.
  const matches: number[] = [];
  for (const delta of [-120, -90, -60, -30, 0, 30, 60, 90, 120]) {
    const value = guess + delta * 60000, p = localParts(value, zone);
    if (value > after && p[0] === date[0] && p[1] === date[1] && p[2] === date[2] && p[3] === hour && p[4] === minute) matches.push(value);
  }
  return matches.length ? Math.min(...matches) : undefined;
}
export function scheduledLocalInput(at: string, zone: string) {
  const p = localParts(Date.parse(at), zone).map(value => String(value).padStart(2, '0'));
  return `${p[0]}-${p[1]}-${p[2]}T${p[3]}:${p[4]}`;
}
export function scheduledInstant(value: string, zone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return;
  const p = value.split(/[-T:]/).map(Number), result = wallTime(p.slice(0, 3), p[3], p[4], zone, -Infinity);
  return result === undefined ? undefined : new Date(result).toISOString();
}
export function nextScheduledTime(schedule: ScheduledSchedule, after: number): string | undefined {
  if (schedule.kind === 'once') return Date.parse(schedule.at) > after ? schedule.at : undefined;
  if (schedule.kind === 'hourly') {
    const anchor = Date.parse(schedule.anchor), interval = schedule.intervalHours * 3600000;
    return new Date(anchor + Math.max(1, Math.floor((after - anchor) / interval) + 1) * interval).toISOString();
  }
  const p = localParts(after, schedule.timezone), [hour, minute] = schedule.time.split(':').map(Number);
  for (let offset = 0; offset < 15; offset++) {
    const day = new Date(Date.UTC(p[0], p[1] - 1, p[2] + offset));
    if (schedule.kind === 'weekdays' && [0, 6].includes(day.getUTCDay()) || schedule.kind === 'weekly' && !schedule.days.includes(day.getUTCDay())) continue;
    const value = wallTime([day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()], hour, minute, schedule.timezone, after);
    if (value !== undefined) return new Date(value).toISOString();
  }
  return undefined;
}
