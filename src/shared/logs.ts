export type LogCategory = 'diagnostic' | 'workflow';
export type LogScope = { account?: string; projectId?: string; sessionId?: string; turnId?: string; operationId?: string; entityId?: string; relatedIds?: string[]; origin?: 'user' | 'ai' | 'background'; provider?: string; route?: string };
export type LogRecord = LogScope & { schema: 1; id: string; at: string; version: string; instance: string; category: LogCategory; name: string; outcome?: string; level?: 'info' | 'warning' | 'error'; durationMs?: number; code?: string; detail?: string; stack?: string; count?: number; lastAt?: string; suppressed?: number };
export type LogUsage = { bytes: number; limit: number; days: number; oldest?: string; newest?: string; files: number };
export type LogStatus = { diagnostic: LogUsage; workflow: LogUsage; traces: { bytes: number; sessions: number }; queued: number; queueBytes: number; suppressed: number; lastWrite?: string; error?: string; traceError?: string; exporting: boolean };
export type LogFilter = { from?: string; to?: string; projectId?: string; sessionId?: string };
export type LogExportInput = LogFilter & { kind: LogCategory | 'trace'; description?: string };
export const logLimits = { diagnostic: { days: 14, bytes: 30 * 1024 * 1024, rotate: 4 * 1024 * 1024 }, workflow: { days: 90, bytes: 20 * 1024 * 1024, rotate: 2 * 1024 * 1024 } };
