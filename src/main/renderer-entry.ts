import path from 'node:path';
import { realpathSync } from 'node:fs';
/** Chromium expands Windows 8.3 paths. Load and trust the same canonical file. */
export function rendererEntry(directory: string, assets: string) {
  const file = path.join(directory, assets, 'index.html');
  try { return realpathSync.native(file); }
  catch { return file; } // A missing build is reported by the normal load failure path.
}
