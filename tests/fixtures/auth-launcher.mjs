import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export async function authLauncher(root, state = { status: 'none' }) {
  await fs.mkdir(root, { recursive: true });
  const script = path.join(root, 'auth-cli.mjs');
  await fs.copyFile(fileURLToPath(new URL('./auth-cli.mjs', import.meta.url)), script);
  const launcher = path.join(root, process.platform === 'win32' ? 'auth-cli.cmd' : 'auth-cli.sh');
  await fs.writeFile(launcher, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  const write = value => fs.writeFile(path.join(root, 'auth-state.json'), JSON.stringify(value));
  await write(state);
  return { launcher, write, calls: async () => (await fs.readFile(path.join(root, 'auth-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).event), environments: async () => (await fs.readFile(path.join(root, 'cli-env.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}
