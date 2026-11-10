import fs from 'node:fs/promises';
import path from 'node:path';
import { withoutQuestionFillTurns } from '../shared/session-context-text';
import type { Message } from '../shared/types';
import { transcriptPageSize, type TranscriptPage } from '../shared/transcript-page';

export const frozenTranscriptName = 'inherited-pages.json';
const isPaged = (file: string) => path.basename(file) === frozenTranscriptName;
const pageFile = (file: string, index: number) => file + '.' + index + '.json';

async function pageSizes(file: string): Promise<number[]> {
  const sizes = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(sizes) || !sizes.every(n => Number.isInteger(n) && n > 0 && n <= transcriptPageSize)) throw Error('创建时的消息索引无效');
  return sizes;
}

const indexing = new Map<string, Promise<Message[]>>();
function indexLegacy(file: string, cacheDir: string) {
  const pending = indexing.get(file);
  if (pending) return pending;
  const job = (async () => {
    const rows = withoutQuestionFillTurns<Message>(JSON.parse(await fs.readFile(file, 'utf8')));
    // Build the optional index beside the immutable old snapshot. Publish all pages together.
    let temp: string | undefined;
    try {
      temp = await fs.mkdtemp(cacheDir + '-');
      await freezeTranscript(path.join(temp, frozenTranscriptName), undefined, rows);
      await fs.rename(temp, cacheDir);
      temp = undefined;
    } catch { /* The legacy snapshot remains readable on read-only storage. */ }
    finally { if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {}); }
    return rows;
  })().finally(() => indexing.delete(file));
  indexing.set(file, job);
  return job;
}

export async function readFrozenPage(file: string | undefined, before: number, limit: number): Promise<TranscriptPage> {
  if (!file) return { messages: [], before: 0 };
  if (!isPaged(file)) {
    const cacheDir = file + '.pages';
    try { return await readFrozenPage(path.join(cacheDir, frozenTranscriptName), before, limit); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const history = await indexLegacy(file, cacheDir);
    const end = Math.min(before, history.length), start = Math.max(0, end - limit);
    return { messages: history.slice(start, end), before: start };
  }
  const sizes = await pageSizes(file);
  const end = Math.min(before, sizes.reduce((a, b) => a + b, 0)), start = Math.max(0, end - limit);
  const messages: Message[] = [];
  let offset = 0;
  for (let i = 0; i < sizes.length && offset < end; i++) {
    if (offset + sizes[i] > start) {
      const page: Message[] = JSON.parse(await fs.readFile(pageFile(file, i), 'utf8'));
      if (page.length !== sizes[i]) throw Error('创建时的消息页不完整，请重试');
      messages.push(...page.slice(Math.max(0, start - offset), end - offset));
    }
    offset += sizes[i];
  }
  return { messages, before: start };
}

export async function freezeTranscript(file: string, inherited: string | undefined, own: Message[]) {
  const sizes: number[] = [];
  const append = async (messages: Message[]) => {
    for (let i = 0; i < messages.length; i += transcriptPageSize) {
      const page = messages.slice(i, i + transcriptPageSize);
      await fs.writeFile(pageFile(file, sizes.length), JSON.stringify(page), { flag: 'wx' });
      sizes.push(page.length);
    }
  };
  // Each descendant owns its snapshot even if its ancestor is later promoted or deleted.
  if (inherited && isPaged(inherited)) {
    for (const size of await pageSizes(inherited)) {
      await fs.copyFile(pageFile(inherited, sizes.length), pageFile(file, sizes.length));
      sizes.push(size);
    }
  } else if (inherited) await append((await readFrozenPage(inherited, Infinity, Infinity)).messages);
  await append(own);
  await fs.writeFile(file, JSON.stringify(sizes), { flag: 'wx' });
  return sizes.reduce((a, b) => a + b, 0);
}
