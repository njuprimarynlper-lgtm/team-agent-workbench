import type { SharedContent } from './content';

export type TeamHistoryReason = 'merged' | 'deleted';
export type TeamHistoryFilter = 'all' | TeamHistoryReason;
type HistoryRecord = Pick<SharedContent, 'deletedAt' | 'supersededBy'>;

export const teamHistoryLabels: Record<TeamHistoryReason, string> = { merged: '已合并', deleted: '已删除' };

export function teamHistoryReason(item: HistoryRecord): TeamHistoryReason | undefined {
  if (item.deletedAt) return 'deleted';
  if (item.supersededBy) return 'merged';
  return undefined;
}

export function matchesTeamHistory(item: HistoryRecord, filter: TeamHistoryFilter) {
  const reason = teamHistoryReason(item);
  return reason !== undefined && (filter === 'all' || filter === reason);
}
