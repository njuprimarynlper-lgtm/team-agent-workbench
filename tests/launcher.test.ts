import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');

test('existing user and admin launchers use the same hidden helper', async () => {
  for (const [name, edition] of [['start-user-dev.cmd', 'user'], ['start-admin-dev.cmd', 'admin']]) {
    const launcher = await fs.readFile(path.join(root, name), 'utf8');
    assert.match(launcher, /powershell\.exe[^\r\n]+-WindowStyle Hidden/i);
    assert.match(launcher, new RegExp(`start-dev-hidden\\.ps1" ${edition}`, 'i'));
    assert.match(launcher, /exit \/b 0/i);
    assert.doesNotMatch(launcher, /npm(?:\.cmd)?\s+run\s+build/i);
    assert.doesNotMatch(launcher, /\bpause\b/i);
  }

  const helper = await fs.readFile(path.join(root, 'scripts', 'start-dev-hidden.ps1'), 'utf8');
  assert.match(helper, /Start-Process -FilePath \$npm[\s\S]+?-WindowStyle Hidden[\s\S]+?-Wait/);
  assert.match(helper, /RedirectStandardError \$script:stderrLog/);
  assert.match(helper, /System\.Windows\.Forms\.MessageBox/);
  assert.doesNotMatch(helper, /Start-Process -FilePath \$electron[^\r\n]+-WindowStyle Hidden/);
});

const exec = promisify(execFile);
const windows = { skip: process.platform !== 'win32' };

async function launcherFixture(t: { after: (fn: () => Promise<void>) => void }) {
  // Exercise real PowerShell process startup, including spaces, Chinese and shell metacharacters.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench 启动 & ')));
  t.after(async () => {
    assert.equal(path.dirname(dir), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('workbench 启动 & '));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await fs.mkdir(path.join(dir, 'scripts'));
  await fs.mkdir(path.join(dir, 'bin'));
  await fs.copyFile(path.join(root, 'scripts/start-dev-hidden.ps1'), path.join(dir, 'scripts/start-dev-hidden.ps1'));
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
  const eventsPath = path.join(dir, 'events.jsonl');
  const runner = path.join(dir, 'npm-fixture.cjs');
  await fs.writeFile(runner, `
const fs = require('node:fs'), path = require('node:path');
const root = process.cwd(), step = process.argv[2];
const event = value => fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify(value) + '\\n');
event({ step, args: process.argv.slice(2), cwd: root });
if (process.env.LAUNCHER_FAIL_STEP === step) process.exit(17);
if (step === 'ci') {
  for (const name of ['electron/dist', 'esbuild', 'ssh2']) fs.mkdirSync(path.join(root, 'node_modules', name), { recursive: true });
  for (const name of ['esbuild', 'ssh2']) fs.writeFileSync(path.join(root, 'node_modules', name, 'package.json'), '{}');
  const electron = path.join(root, 'node_modules/electron/dist/electron.exe');
  if (!fs.existsSync(electron)) {
    try { fs.linkSync(process.execPath, electron); } catch { fs.copyFileSync(process.execPath, electron); }
  }
} else if (step === 'run') {
  for (const edition of ['user', 'admin']) {
    const out = path.join(root, 'dist', edition); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
    fs.writeFileSync(path.join(out, 'main.cjs'), 'require("node:fs").appendFileSync(' + JSON.stringify(path.join(root, 'events.jsonl')) + ', JSON.stringify({step:"launch", edition:' + JSON.stringify(edition) + ', cwd:process.cwd(), electronRunAsNode:process.env.ELECTRON_RUN_AS_NODE || ""})+"\\\\n")');
  }
}
`);
  await fs.writeFile(path.join(dir, 'bin/npm.cmd'), '@echo off\r\n"%LAUNCHER_TEST_NODE%" "%LAUNCHER_TEST_RUNNER%" %*\r\nexit /b %errorlevel%\r\n');
  const env: NodeJS.ProcessEnv = { ...process.env, LAUNCHER_TEST_NODE: process.execPath, LAUNCHER_TEST_RUNNER: runner, ELECTRON_RUN_AS_NODE: '1' };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.Path = path.join(dir, 'bin') + path.delimiter + (process.env.Path || process.env.PATH);
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const run = (edition: string, extra: NodeJS.ProcessEnv = {}) => exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'scripts/start-dev-hidden.ps1'), edition, '-NoDialogs'], { cwd: os.tmpdir(), env: { ...env, ...extra }, windowsHide: true, timeout: 30000 });
  const events = async (): Promise<Array<{ step: string; edition?: string; cwd: string; electronRunAsNode?: string; args?: string[] }>> => {
    const text = await fs.readFile(eventsPath, 'utf8').catch(() => '');
    return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [];
  };
  const launched = async (count: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await events()).filter(e => e.step === 'launch').length >= count) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('Application did not start');
  };
  return { dir, run, events, launched };
}

test('first launch installs locked dependencies; both editions start from paths with spaces', windows, async t => {
  const f = await launcherFixture(t);
  await f.run('user'); await f.launched(1);
  await f.run('admin'); await f.launched(2);
  const events = await f.events();
  assert.equal(events.filter(e => e.step === 'ci').length, 1);
  assert.equal(events.filter(e => e.step === 'run').length, 2);
  assert.deepEqual(events.filter(e => e.step === 'launch').map(e => e.edition), ['user', 'admin']);
  for (const e of events.filter(e => e.step === 'launch')) {
    assert.equal(e.cwd, f.dir); assert.equal(e.electronRunAsNode, '');
  }
  await fs.writeFile(path.join(f.dir, 'package-lock.json'), '{"updated":true}');
  await f.run('user'); await f.launched(3);
  assert.equal((await f.events()).filter(e => e.step === 'ci').length, 2, 'lockfile update must prepare dependencies again');
});

test('failed install is retried and failed build never launches an older app', windows, async t => {
  const f = await launcherFixture(t);
  await assert.rejects(f.run('user', { LAUNCHER_FAIL_STEP: 'ci' }), /依赖安装失败/);
  assert.equal((await f.events()).filter(e => e.step === 'launch').length, 0);
  await f.run('user'); await f.launched(1);
  await assert.rejects(f.run('user', { LAUNCHER_FAIL_STEP: 'run' }), /当前代码构建失败/);
  assert.equal((await f.events()).filter(e => e.step === 'launch').length, 1);
  await f.run('admin'); await f.launched(2);
  assert.equal((await f.events()).filter(e => e.step === 'ci').length, 2);
});

test('concurrent user and admin startup shares one dependency install', windows, async t => {
  const f = await launcherFixture(t);
  const results = await Promise.allSettled([f.run('user'), f.run('admin')]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  await f.launched(2);
  const events = await f.events();
  assert.equal(events.filter(e => e.step === 'ci').length, 1);
  assert.equal(events.filter(e => e.step === 'run').length, 2);
  assert.deepEqual(events.filter(e => e.step === 'launch').map(e => e.edition).sort(), ['admin', 'user']);
});

test('missing Node.js gives an actionable error before installation or build', windows, async t => {
  const f = await launcherFixture(t);
  await assert.rejects(f.run('user', { Path: path.join(f.dir, 'bin') }), /请先安装 64 位 Node.js/);
  assert.deepEqual(await f.events(), []);
});
