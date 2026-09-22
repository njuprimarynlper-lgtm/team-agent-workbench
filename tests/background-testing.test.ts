import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnCLI, stopCLI } from '../src/core/rpc';
const { assertBackgroundProcess } = createRequire(import.meta.url)('../scripts/background-guard.cjs');
// @ts-expect-error Shared fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

test('background guard blocks shells, UI processes and unrelated process termination before launch', () => {
  for (const command of ['powershell.exe', 'pwsh.exe', 'cmd.exe', 'electron.exe', 'wscript.exe', 'cscript.exe', 'msedge.exe']) assert.throws(() => assertBackgroundProcess(command), /禁止/);
  assert.throws(() => assertBackgroundProcess('node.exe', [], { shell: true }), /禁止/);
  assert.throws(() => assertBackgroundProcess('node.exe', [], { detached: true }), /禁止/);
  assert.throws(() => assertBackgroundProcess('taskkill.exe', ['/IM', 'electron.exe', '/F']), /自己创建/);
  assert.throws(() => assertBackgroundProcess('taskkill.exe', ['/PID', '123', '/T', '/F'], {}, new Set([456])), /自己创建/);
  const safe = assertBackgroundProcess('node.exe', [], { windowsHide: false, stdio: 'pipe' });
  assert.equal(safe.windowsHide, true); assert.equal(safe.shell, false); assert.equal(safe.detached, false); assert.equal(safe.stdio, 'pipe');
  assert.equal(assertBackgroundProcess('taskkill.exe', ['/PID', '123', '/T', '/F'], {}, new Set([123])).windowsHide, true);
});

test('protocol fixtures start the Node executable directly without shell wrappers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-background-'));
  let child: ReturnType<typeof spawnCLI> | undefined;
  try {
    const fixture = await authLauncher(root, { status: 'ready' });
    assert.equal(path.extname(fixture.launcher), '.mjs');
    assert(!(await fs.readdir(root)).some(file => /\.(cmd|bat|ps1|sh)$/.test(file)));
    child = spawnCLI(fixture.launcher, ['--version'], root);
    assert.equal(child.spawnfile, process.execPath);
    assert.deepEqual(child.spawnargs.slice(1), [fixture.launcher, '--version']);
    let output = ''; child.stdout.on('data', data => { output += data.toString(); });
    const code = await new Promise((resolve, reject) => { child!.once('error', reject); child!.once('close', resolve); });
    assert.equal(code, 0); assert.match(output, /fixture-cli-1\.0/);
  } finally { if (child) await stopCLI(child); assert(root.startsWith(path.join(os.tmpdir(), 'wb-background-'))); await fs.rm(root, { recursive: true, force: true }); }
});
