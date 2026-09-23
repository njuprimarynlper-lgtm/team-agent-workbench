import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function publishRuntimeAssets(output, files) {
  const hash = createHash('sha256');
  for (const [name, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update('\0').update(content).update('\0');
  const directory = 'assets/' + hash.digest('hex');
  await mkdir(path.join(output, directory), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(output, directory, name);
    try { await writeFile(target, content, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST' || !Buffer.from(content).equals(await readFile(target))) throw error;
    }
  }
  return directory;
}
