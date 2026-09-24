// Offline Windows integration check: real CMD/PowerShell, simulated CLI accounts.
// Run with: node --import tsx scripts/check-windows-provider-paths.ts
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveProvider, inspectProvider } from '../src/core/providers';
import { inspectAuth } from '../src/core/provider-auth';

async function main() {
  if (process.platform !== 'win32') throw new Error('Run this check on Windows.');
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'provider-cli-check-'));
  const cwd = process.cwd(), previousEnv = { ...process.env }, exec = promisify(execFile);
  try {
    for (const directory of ['ascii', '中文 tools & npm']) {
      const bin = path.join(root, directory); await fs.mkdir(bin);
      await fs.writeFile(path.join(bin, 'fixture.mjs'), `
import readline from 'node:readline';
const send = value => console.log(JSON.stringify(value));
if (process.argv[2] === '--version') console.log('fixture-cli-1.0');
else if (process.argv[2] === 'status') send({ status: 'authenticated', isAuthenticated: true });
else if (process.argv[2] === 'auth') send({ loggedIn: true });
else readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id !== undefined) send({ id: request.id, result: request.method === 'account/read'
    ? { requiresOpenaiAuth: true, account: { type: 'chatgpt' } } : {} });
});
`);
      for (const key of Object.keys(process.env)) if (key.toLowerCase() === 'path') delete process.env[key];
      const originalPath = Object.keys(previousEnv).sort().find(key => key.toLowerCase() === 'path');
      process.env.Path = bin + path.delimiter + (originalPath ? previousEnv[originalPath] : '');
      process.chdir(bin);
      for (const [provider, name] of [['codex', 'codex'], ['cursor', 'agent'], ['claude', 'claude']] as const) {
        await fs.writeFile(path.join(bin, name), '#!/bin/sh\nexit 0\n');
        const shim = path.join(bin, name + '.cmd');
        await fs.writeFile(shim, '@echo off\r\n"' + process.execPath + '" "%~dp0fixture.mjs" %*\r\n');
        const terminal = await exec('cmd.exe', ['/d', '/c', name + ' --version'], { windowsHide: true, timeout: 10000 });
        assert.equal(terminal.stdout.trim(), 'fixture-cli-1.0');
        assert.equal(await resolveProvider(provider), shim);
        const info = await inspectProvider(provider, ''); assert.equal(info.available, true, info.detail);
        const auth = await inspectAuth(provider, info.path, bin, undefined, 10000);
        assert.equal(auth.status, 'authenticated', auth.detail);
        console.log(`${provider}: ${directory} — terminal, discovery, version and account check passed`);
      }
    }
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (key.toLowerCase() === 'path') delete process.env[key];
    for (const [key, value] of Object.entries(previousEnv)) if (key.toLowerCase() === 'path') process.env[key] = value;
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.ok(path.basename(root).startsWith('provider-cli-check-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
