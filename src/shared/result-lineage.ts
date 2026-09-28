import type { ResultReference } from './content';

const key = (ref: ResultReference) => `${ref.scope}:${ref.projectId}:${ref.id}:${ref.version}`;

/** Traverse only frozen direct references. Missing or inaccessible sources remain visible as leaves. */
export function resultLineage(direct: ResultReference[], resolve: (ref: ResultReference) => { derivedFrom?: ResultReference[] } | undefined) {
  const visited = new Set<string>(), active = new Set<string>(), ordered: ResultReference[] = [];
  const visit = (ref: ResultReference) => {
    const identity = key(ref);
    if (active.has(identity)) throw new Error('成果来源存在循环引用');
    if (visited.has(identity)) return;
    active.add(identity);
    for (const parent of resolve(ref)?.derivedFrom || []) visit(parent);
    active.delete(identity); visited.add(identity); ordered.push(ref);
  };
  for (const ref of direct) visit(ref);
  return ordered;
}

export function newerTeamSources(direct: ResultReference[], resolve: (ref: ResultReference) => { derivedFrom?: ResultReference[] } | undefined, currentRevisions: Record<string, number>) {
  return resultLineage(direct, resolve).filter(ref => ref.scope === 'team' && (currentRevisions[ref.id] || 0) > ref.version);
}
