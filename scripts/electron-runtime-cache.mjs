// Keep the extracted Electron runtime outside node_modules so npm ci cannot erase it.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const executable = process.platform === 'win32' ? 'electron.exe' : 'electron';
const defaultCache = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'TeamAgentWorkbench', 'electron-runtime');
const read = async file => fs.readFile(file, 'utf8').then(value => value.trim(), () => '');
const exists = async file => fs.stat(file).then(value => value.isFile() && value.size > 0, () => false);
async function renameWithRetry(source, target) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(source, target); return; }
    catch (error) {
      if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}

export async function electronRuntimeCache(root, action, cacheBase = process.env.WORKBENCH_ELECTRON_CACHE || defaultCache) {
  if (!['save', 'restore'].includes(action)) throw new Error('Unknown Electron cache action');
  const packageRoot = path.join(root, 'node_modules', 'electron');
  const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const version = pkg.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid Electron package version');
  const cacheRoot = path.resolve(cacheBase);
  const cache = path.join(cacheRoot, `v${version}-${process.platform}-${process.arch}`);
  const dist = path.resolve(packageRoot, 'dist');
  if (path.dirname(dist) !== path.resolve(packageRoot) || path.dirname(cache) !== cacheRoot) throw new Error('Unexpected Electron runtime path');
  const complete = async location =>
    (await read(path.join(location, 'dist', 'version'))).replace(/^v/, '') === version &&
    (await read(path.join(location, 'path.txt'))) === executable &&
    await exists(path.join(location, 'dist', executable));
  const ready = await complete(packageRoot);
  const cached = await complete(cache);
  if (action === 'restore') {
    if (ready) return { status: 'present', version };
    if (!cached) return { status: 'miss', version };
    const temp = path.join(packageRoot, '.dist-restore-' + randomUUID());
    if (path.dirname(temp) !== path.resolve(packageRoot)) throw new Error('Unexpected Electron restore path');
    try {
      await fs.cp(path.join(cache, 'dist'), temp, { recursive: true });
      await fs.rm(dist, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
      await renameWithRetry(temp, dist);
      await fs.copyFile(path.join(cache, 'path.txt'), path.join(packageRoot, 'path.txt'));
      if (!await complete(packageRoot)) throw new Error('Cached Electron runtime is incomplete');
      return { status: 'restored', version };
    } finally { await fs.rm(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); }
  }
  if (!ready) return { status: 'missing', version };
  if (cached) return { status: 'cached', version };
  await fs.mkdir(cacheRoot, { recursive: true });
  const temp = path.join(cacheRoot, `.electron-cache-${randomUUID()}`);
  if (path.dirname(temp) !== cacheRoot) throw new Error('Unexpected Electron cache staging path');
  try {
    await fs.mkdir(temp);
    await fs.cp(path.join(packageRoot, 'dist'), path.join(temp, 'dist'), { recursive: true });
    await fs.copyFile(path.join(packageRoot, 'path.txt'), path.join(temp, 'path.txt'));
    if (!await complete(temp)) throw new Error('Electron runtime changed during caching');
    // cache is always a single versioned child of our dedicated cache directory.
    await fs.rm(cache, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    await renameWithRetry(temp, cache);
    return { status: 'saved', version };
  } finally { await fs.rm(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  electronRuntimeCache(process.cwd(), process.argv[2]).then(result => console.log(JSON.stringify(result)), error => {
    console.error(error.message); process.exitCode = 1;
  });
}
