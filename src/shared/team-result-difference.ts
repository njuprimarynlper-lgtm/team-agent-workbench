import { titleSubject, type SharedContent } from './content';
import type { ConclusionSource, ProjectConclusion } from './types';

export type TeamResultDifference = 'missing' | 'updated' | 'edited';
export const teamResultDifferenceLabels: Record<TeamResultDifference, string> = { missing: '尚未存入个人库', updated: '团队版本有变化', edited: '个人内容不同' };
export const normalizedResultBody = (content: string) => content.replace(/\r\n?/g, '\n').trim();

function sharedOrigin(source: ConclusionSource, item: SharedContent) {
  if (source.kind === 'remote' && source.id === item.id) return source;
  if (source.kind === 'session' && source.publication?.path === item.path) return source.publication;
}

const currentPersonal = (personal: ProjectConclusion[]) => personal.filter(value => !value.deletedAt && !value.archived);
const unsourced = (value: ProjectConclusion) => !value.sources.some(source => source.kind === 'remote' || source.kind === 'session' && source.publication);

// Compare with the personal results currently shown in the library.
// Archived history and deleted copies do not count as already saved.
export function teamResultDifference(item: SharedContent, personal: ProjectConclusion[]): TeamResultDifference | undefined {
  const live = currentPersonal(personal);
  const related = live.filter(value => value.sources.some(source => sharedOrigin(source, item)));
  const body = normalizedResultBody(item.description || item.title);
  const sameTitle = live.filter(value => unsourced(value) && titleSubject(value.title) === titleSubject(item.title));
  if (!related.length && !sameTitle.length) return 'missing';
  const current = related.filter(value => value.sources.some(source => { const origin = sharedOrigin(source, item); return origin && origin.revision === item.revision && (!origin.sha256 || origin.sha256 === item.sha256); }));
  if (current.some(value => normalizedResultBody(value.content) === body) || sameTitle.some(value => normalizedResultBody(value.content) === body)) return undefined;
  return current.length || sameTitle.length ? 'edited' : 'updated';
}
