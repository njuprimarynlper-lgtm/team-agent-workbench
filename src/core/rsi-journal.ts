import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { RsiEvidence, RsiProject } from '../shared/rsi';

export const rsiJournalDir = (root: string) => path.join(root, 'rsi-v2.changes');
export const rsiJournalFile = (root: string, sequence: number) => path.join(rsiJournalDir(root), String(sequence).padStart(12, '0') + '.json');
export class RsiJournalError extends Error {}

export interface RsiChangeV1 {
  version: 1;
  sequence: number;
  projects: { key: string; metadata: Omit<RsiProject, 'evidence'>; evidence?: { append: RsiEvidence[] } | { replace: RsiEvidence[] } }[];
  preferences: Record<string, { text: string; at: string }>;
}

type Metadata = Omit<RsiProject, 'evidence'>;
type FieldChange = { set: unknown } | { remove: true } | { object: Record<string, FieldChange> } | { array: { before: number; length: number; updates: { index: number; change: FieldChange }[]; append: unknown[] } };
export interface RsiChangeV2 {
  version: 2;
  sequence: number;
  projects: { key: string; create?: Metadata; fields?: Record<string, FieldChange>; evidence?: { append: RsiEvidence[] } | { replace: RsiEvidence[] } }[];
  preferences?: Record<string, { text: string; at: string }>;
}

function valueChange(left: unknown, right: unknown): FieldChange {
  if (Array.isArray(left) && Array.isArray(right)) {
    const updates: { index: number; change: FieldChange }[] = [];
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      if (!isDeepStrictEqual(left[index], right[index])) updates.push({ index, change: valueChange(left[index], right[index]) });
    }
    return { array: { before: left.length, length: right.length, updates, append: right.slice(left.length) } };
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') return { object: metadataChanges(left as Metadata, right as Metadata) };
  return { set: right };
}

export function metadataChanges(before: Metadata, after: Metadata): Record<string, FieldChange> {
  const changes: Record<string, FieldChange> = {};
  const previous = before as Record<string, unknown>, current = after as Record<string, unknown>;
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    const left = previous[key], right = current[key];
    if (isDeepStrictEqual(left, right)) continue;
    if (!(key in current) || right === undefined) { changes[key] = { remove: true }; continue; }
    changes[key] = valueChange(left, right);
  }
  return changes;
}

function applyFields(prior: Metadata, fields: Record<string, FieldChange>): Metadata {
  const result = { ...prior } as Record<string, unknown>;
  for (const [key, change] of Object.entries(fields)) {
    if (!change || typeof change !== 'object') throw new RsiJournalError('AI推荐增量字段格式无效，原文件已保留');
    if ('remove' in change && change.remove === true) { delete result[key]; continue; }
    result[key] = applyChange(result[key], change);
  }
  return result as Metadata;
}

function applyChange(prior: unknown, change: FieldChange): unknown {
  if (!change || typeof change !== 'object') throw new RsiJournalError('AI推荐增量字段格式无效，原文件已保留');
  if ('set' in change) return change.set;
  if ('object' in change) {
    if (!prior || typeof prior !== 'object' || Array.isArray(prior) || !change.object || typeof change.object !== 'object') throw new RsiJournalError('AI推荐增量对象格式无效，原文件已保留');
    return applyFields(prior as Metadata, change.object);
  }
  if (!('array' in change) || !change.array || !Array.isArray(prior)) throw new RsiJournalError('AI推荐增量数组格式无效，原文件已保留');
  const { before, length, updates, append } = change.array;
  const source = prior;
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(length) || before < 0 || length < 0 || source.length !== before || !Array.isArray(updates) || !Array.isArray(append) || append.length !== Math.max(0, length - before)) throw new RsiJournalError('AI推荐增量数组长度无效，原文件已保留');
  const target = source.slice(0, length);
  for (const update of updates) {
    if (!Number.isSafeInteger(update?.index) || update.index < 0 || update.index >= Math.min(before, length)) throw new RsiJournalError('AI推荐增量数组索引无效，原文件已保留');
    target[update.index] = applyChange(target[update.index], update.change);
  }
  for (const item of append) target.push(item);
  return target;
}

export async function pruneRsiJournal(root: string, sequence: number) {
  const dir = rsiJournalDir(root);
  const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const name of names) if (/^\d{12}\.json$/.test(name) && Number(name.slice(0, 12)) <= sequence) await fs.unlink(path.join(dir, name));
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
    const change = await fs.readFile(path.join(rsiJournalDir(root), name), 'utf8').then(value => JSON.parse(value) as RsiChangeV1 | RsiChangeV2).catch(error => { throw new RsiJournalError('AI推荐增量无法读取，原文件已保留：' + name, { cause: error }); });
    if (![1, 2].includes(change.version) || change.sequence !== next || !Array.isArray(change.projects) || change.version === 1 && !change.preferences || change.preferences && (typeof change.preferences !== 'object' || Array.isArray(change.preferences))) throw new RsiJournalError('AI推荐增量格式无效，原文件已保留：' + name);
    for (const entry of change.projects) {
      if (!entry || !entry.key || entry.evidence && (typeof entry.evidence !== 'object' || !('append' in entry.evidence || 'replace' in entry.evidence))) throw new RsiJournalError('AI推荐增量项目格式无效，原文件已保留：' + name);
      const prior = value.projects[entry.key] as RsiProject | undefined;
      const metadata = change.version === 1 ? (entry as RsiChangeV1['projects'][number]).metadata : (() => {
        const delta = entry as RsiChangeV2['projects'][number];
        if (delta.create) return delta.create;
        if (!prior || !delta.fields) throw new RsiJournalError('AI推荐增量缺少项目基线，原文件已保留：' + name);
        const { evidence: _evidence, ...previous } = prior;
        return applyFields(previous, delta.fields);
      })();
      if (metadata?.scope?.key !== entry.key) throw new RsiJournalError('AI推荐增量项目身份无效，原文件已保留：' + name);
      const evidence = entry.evidence && 'replace' in entry.evidence ? entry.evidence.replace : prior?.evidence || [];
      if (!Array.isArray(evidence) || entry.evidence && 'append' in entry.evidence && !Array.isArray(entry.evidence.append)) throw new RsiJournalError('AI推荐增量证据格式无效，原文件已保留：' + name);
      if (entry.evidence && 'append' in entry.evidence) for (const item of entry.evidence.append) evidence.push(item);
      value.projects[entry.key] = { ...metadata, evidence };
    }
    if (change.preferences) value.preferences = change.preferences;
    sequence = next;
  }
  value.changeSeq = sequence;
  return { value, sequence, journal: files.some(name => /^\d{12}\.json$/.test(name)) };
}
