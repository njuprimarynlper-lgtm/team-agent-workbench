import fs from 'node:fs/promises';
import path from 'node:path';
import type { RsiEvidence, RsiProject } from '../shared/rsi';

export const rsiJournalDir = (root: string) => path.join(root, 'rsi-v2.changes');
export const rsiJournalFile = (root: string, sequence: number) => path.join(rsiJournalDir(root), String(sequence).padStart(12, '0') + '.json');
export class RsiJournalError extends Error {}

export interface RsiChange {
  version: 1;
  sequence: number;
  projects: { key: string; metadata: Omit<RsiProject, 'evidence'>; evidence?: { append: RsiEvidence[] } | { replace: RsiEvidence[] } }[];
  preferences: Record<string, { text: string; at: string }>;
}

/** Read a legacy/full checkpoint and replay only committed atomic changes. */
export async function loadRsiDocument(root: string): Promise<{ value: any; sequence: number; journal: boolean }> {
  const files = await fs.readdir(rsiJournalDir(root)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const value = await fs.readFile(path.join(root, 'rsi-v2.json'), 'utf8').then(JSON.parse).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' && files.some(name => /^\d{12}\.json$/.test(name))) throw new Error('AI推荐增量基线缺失，原文件已保留：' + root);
    throw error;
  });
  let sequence = value.changeSeq || 0;
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RsiJournalError('AI推荐增量基线版本无效，原文件已保留');
  for (const name of files.filter(name => /^\d{12}\.json$/.test(name)).sort()) {
    const next = Number(name.slice(0, 12));
    if (next <= sequence) continue;
    if (next !== sequence + 1) throw new RsiJournalError('AI推荐增量序号不连续，原文件已保留：' + name);
    const change = await fs.readFile(path.join(rsiJournalDir(root), name), 'utf8').then(value => JSON.parse(value) as RsiChange).catch(error => { throw new RsiJournalError('AI推荐增量无法读取，原文件已保留：' + name, { cause: error }); });
    if (change.version !== 1 || change.sequence !== next || !Array.isArray(change.projects) || !change.preferences || typeof change.preferences !== 'object') throw new RsiJournalError('AI推荐增量格式无效，原文件已保留：' + name);
    for (const entry of change.projects) {
      if (!entry || !entry.key || entry.metadata?.scope?.key !== entry.key || entry.evidence && (typeof entry.evidence !== 'object' || !('append' in entry.evidence || 'replace' in entry.evidence))) throw new RsiJournalError('AI推荐增量项目格式无效，原文件已保留：' + name);
      const prior = value.projects[entry.key] as RsiProject | undefined;
      const evidence = entry.evidence && 'replace' in entry.evidence ? entry.evidence.replace : prior?.evidence || [];
      if (!Array.isArray(evidence) || entry.evidence && 'append' in entry.evidence && !Array.isArray(entry.evidence.append)) throw new RsiJournalError('AI推荐增量证据格式无效，原文件已保留：' + name);
      if (entry.evidence && 'append' in entry.evidence) for (const item of entry.evidence.append) evidence.push(item);
      value.projects[entry.key] = { ...entry.metadata, evidence };
    }
    value.preferences = change.preferences;
    sequence = next;
  }
  value.changeSeq = sequence;
  return { value, sequence, journal: files.some(name => /^\d{12}\.json$/.test(name)) };
}
