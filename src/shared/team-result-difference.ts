import type { SharedContent } from './content';
import type { ConclusionSource, ProjectConclusion } from './types';

export type TeamResultDifference = 'missing' | 'updated' | 'edited';
export const teamResultDifferenceLabels: Record<TeamResultDifference, string> = { missing: '尚未存入个人库', updated: '团队版本有变化', edited: '个人内容不同' };
export const normalizedResultBody = (content: string) => content.replace(/\r\n?/g, '\n').trim();

function sharedOrigin(source: ConclusionSource, item: SharedContent) {
  if (source.kind === 'remote' && source.id === item.id) return source;
  if (source.kind === 'session' && source.publication?.path === item.path) return source.publication;
}

// Callers pass only the current account's project results, including history.
// Deletion and activity processing are independent from owning a personal copy.
export function teamResultDifference(item: SharedContent, personal: ProjectConclusion[]): TeamResultDifference | undefined {
  const related = personal.filter(value => !value.deletedAt && value.sources.some(source => sharedOrigin(source, item)));
  if (!related.length) return 'missing';
  const body = normalizedResultBody(item.description || item.title);
  const current = related.filter(value => value.sources.some(source => { const origin = sharedOrigin(source, item); return origin && origin.revision === item.revision && (!origin.sha256 || origin.sha256 === item.sha256); }));
  if (current.some(value => normalizedResultBody(value.content) === body)) return undefined;
  return current.length ? 'edited' : 'updated';
}
