import fsp from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { AgentSession } from '../shared/types';

export async function traceFiles(directory: string) {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; });
  const names = entries.filter(entry => entry.isFile() && !entry.isSymbolicLink() && /^(events\.jsonl|events-\d{8}\.jsonl(?:\.gz)?)$/.test(entry.name)).map(entry => entry.name);
  // A crash after publishing a compressed segment and before removing its
  // uncompressed source must never duplicate evidence or renumber events.
  return names.filter(name => !names.includes(name + '.gz')).sort((a, b) => a === 'events.jsonl' ? 1 : b === 'events.jsonl' ? -1 : a.localeCompare(b)).map(name => path.join(directory, name));
}
export async function traceSignature(directory: string) {
  const files = await traceFiles(directory);
  return (await Promise.all(files.map(async file => { const stat = await fsp.stat(file); return `${path.basename(file)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }))).join('|');
}
export async function* traceChunks(directory: string, snapshot?: string[]): AsyncGenerator<Buffer> {
  for (const file of snapshot || await traceFiles(directory)) {
    // Open each immutable segment once. Rotation renames an active descriptor,
    // so exporters see the frozen end of that descriptor, not appended records.
    const handle = await fsp.open(file, 'r'); const stat = await handle.stat();
    if (!stat.size) { await handle.close(); continue; }
    const input = handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: true });
    const source = file.endsWith('.gz') ? input.pipe(createGunzip()) : input;
    try { for await (const chunk of source) yield Buffer.from(chunk); }
    finally { source.destroy(); input.destroy(); }
  }
}
export function traceStream(directory: string, snapshot?: string[]) { return Readable.from(traceChunks(directory, snapshot)); }
export async function traceDigest(directory: string, snapshot?: string[]) { const hash = createHash('sha256'); for await (const chunk of traceChunks(directory, snapshot)) hash.update(chunk); return hash.digest('hex'); }
export async function traceHistoryDigest(session: Pick<AgentSession, 'nativeId' | 'messages'>, directory: string, snapshot?: string[]) {
  // Preserve the exact legacy hash of JSON.stringify([nativeId,messages,events])
  // without loading the complete events string. Compression cannot re-upload an
  // unchanged trajectory. Decode UTF-8 across chunk boundaries before escaping.
  const hash = createHash('sha256'), decoder = new StringDecoder('utf8');
  hash.update(JSON.stringify([session.nativeId, session.messages]).slice(0, -1) + ',"');
  for await (const chunk of traceChunks(directory, snapshot)) hash.update(JSON.stringify(decoder.write(chunk)).slice(1, -1));
  hash.update(JSON.stringify(decoder.end()).slice(1, -1)); hash.update('"]'); return hash.digest('hex');
}
export async function* traceLines(directory: string, snapshot?: string[]) {
  const stream = traceStream(directory, snapshot), lines = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of lines) yield line; }
  finally { lines.close(); stream.destroy(); }
}
