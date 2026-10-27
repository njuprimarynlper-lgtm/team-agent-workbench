import type { ProjectConclusion } from '../shared/types';
import type { SharedContent } from '../shared/content';

export function conclusionPublicationOrigin(item: ProjectConclusion) {
  if (item.publication) return item.publication;
  const origins = item.sources.filter(source => source.kind === 'session' && source.publication).map(source => source.publication!);
  if (item.sources.length === 1 && origins.length === 1) return origins[0];
  const source = item.sources.length === 1 ? item.sources[0] : undefined;
  if (source?.kind === 'remote' && source.path && source.sha256 && source.revision) return { contentId: source.id, revision: source.revision, path: source.path, sha256: source.sha256 };
  return undefined;
}

// Only a recorded publication identifies an editable remote result. Similar text,
// disclosed sources and arbitrary derivedFrom entries never grant update rights.
export function resolveConclusionPublication(item: ProjectConclusion, username: string, current: SharedContent[], history: SharedContent[] = []) {
  const origin = conclusionPublicationOrigin(item);
  if (!origin) return undefined;
  const recorded = origin.contentId
    ? [...current, ...history].find(entry => entry.id === origin.contentId && entry.revision === origin.revision)
    : [...current, ...history].find(entry => entry.path === origin.path && entry.sha256 === origin.sha256);
  const id = origin.contentId || recorded?.id;
  const entry = id ? current.find(value => value.id === id) : undefined;
  if ((entry || recorded)?.author !== username && (entry || recorded)) return { status: 'reference' as const, entry, recorded };
  if (!entry) return { status: 'missing' as const, id, revision: origin.revision || recorded?.revision };
  if (entry.state !== 'submitted') return { status: 'reference' as const, entry, recorded };
  const revision = origin.revision || recorded?.revision;
  if (!revision || !recorded || recorded.sha256 !== origin.sha256) throw new Error('无法核验原成果的发布版本，请先查看团队版本；本次未覆盖');
  return { status: 'linked' as const, id: entry.id, revision, entry };
}
