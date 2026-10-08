import type { SharedContent } from '../shared/content';
import type { FileAvailability } from '../shared/content-files-state';

// Observations never replace deletion records. Transport errors are propagated.
export async function inspectContentFiles(items: SharedContent[], inspect: (path: string) => Promise<FileAvailability>) {
  const pending = new Map<string, Promise<FileAvailability>>();
  const read = (path: string) => {
    let result = pending.get(path);
    if (!result) { result = inspect(path); pending.set(path, result); }
    return result;
  };
  const output: SharedContent[] = [];
  for (let start = 0; start < items.length; start += 8) {
    output.push(...await Promise.all(items.slice(start, start + 8).map(async item => {
      const body = await read(item.path);
      const attachments: Record<string, FileAvailability> = {};
      for (const file of item.attachments || []) attachments[file.sha256] = await read(file.path);
      return { ...item, files: { body, attachments } };
    })));
  }
  return output;
}
