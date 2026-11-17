// Isolated real PowerShell export failure and production native recovery UI.
// This reads only fixture data. It never starts Electron or reads account files.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = process.cwd();
const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8) || 'after';
assert(['before', 'after'].includes(phase));
const source = phase === 'before' ? path.join(root, '.test-data/error-audit/baseline') : root;
const output = path.join(root, '.test-data/error-audit/launcher-export-' + phase);
await fs.mkdir(output, { recursive: true });
const scriptFile = path.join(output, 'fixture.ps1'), rawFile = path.join(output, 'raw-error.txt');
const log = path.join(output, 'user-20261116-000000-000-99999999-export.log');
const occupied = path.join(output, 'occupied.zip');
await fs.writeFile(occupied, 'fixture-existing-file', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
const launcher = await fs.readFile(path.join(source, 'scripts/start-dev-hidden.ps1'), 'utf8');
const legacy = /\[System\.Windows\.Forms\.MessageBox\]::Show\(\$_\.Exception\.Message, '诊断包导出失败'\)/.exec(launcher)?.[0];
if (phase === 'before') assert(legacy, 'The immutable source must supply the actual legacy MessageBox expression');
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const payload = `\uFEFF$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$env:WORKBENCH_DATA_DIR=${literal(path.join(output, 'isolated-data'))}
. ${literal(path.join(source, 'scripts/startup-logs.ps1'))}
try { Export-StartupDiagnostics 'user' ${literal(occupied)} '' }
catch {
  [IO.File]::WriteAllText(${literal(rawFile)}, $_.Exception.Message, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText(${literal(log)}, $_.Exception.ToString(), [Text.UTF8Encoding]::new($false))
}
`;
await fs.writeFile(scriptFile, payload, 'utf8');
const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], { windowsHide: true });
const raw = await fs.readFile(rawFile, 'utf8');
assert(raw.trim(), 'The actual exporter must fail before the UI is prepared');
// Render the old two-argument MessageBox expression, or call the actual new
// production class. Neither branch implements its own product UI.
const legacyCs = legacy?.replace('[System.Windows.Forms.MessageBox]::Show', 'MessageBox.Show').replace('$_.Exception.Message', 'File.ReadAllText(args[0])').replaceAll("'", '"');
const fixtureCs = path.join(output, 'Fixture.cs'), executable = path.join(output, 'LauncherExportFixture.exe');
const resultFile = path.join(output, 'result.json');
const resultLiteral = value => JSON.stringify(JSON.stringify(value));
await fs.writeFile(fixtureCs, 'using System;using System.IO;using System.Windows.Forms;class Fixture{[STAThread]static void Main(string[] args){' + (phase === 'before'
  ? `${legacyCs};File.WriteAllText(args[1],${resultLiteral({ closed: true })});`
  : `bool retry=WorkbenchStartupFailureDialog.ShowExportFailure();File.WriteAllText(args[1],retry?${resultLiteral({ retry: true })}:${resultLiteral({ retry: false })});`) + '}}');
execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/out:' + executable, fixtureCs, ...(phase === 'after' ? [path.join(source, 'scripts/startup-error-dialog.cs')] : [])], { windowsHide: true });
const metadata = {
  id: 'native-launcher-export', phase, sourceRoot: source, script: scriptFile, executable,
  source: ['scripts/start-dev-hidden.ps1', 'scripts/startup-failure.ps1', 'scripts/startup-error-dialog.cs'],
  callerSites: ['startup progress export button', 'startup failure dialog export choice'],
  condition: 'existing output file causes the actual Export-StartupDiagnostics FileMode.CreateNew to fail',
  captureStatus: 'prepared-not-observed',
  rawFailure: raw, rawFile, diagnosticLog: log,
  uiHost: 'compiled C# WinForms GUI executable; PowerShell only produces the isolated real IO failure without UI',
  screenshot: 'docs/error-audit/screenshots/native-launcher-export-' + phase + '.png',
  sourceSha256: Object.fromEntries(await Promise.all(['scripts/start-dev-hidden.ps1', ...(phase === 'after' ? ['scripts/startup-failure.ps1', 'scripts/startup-error-dialog.cs'] : [])].map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(source, file))).digest('hex')]))),
};
await fs.writeFile(path.join(output, 'fixture.json'), JSON.stringify(metadata, null, 2));
console.log(JSON.stringify({ ...metadata, run: `"${executable}" "${rawFile}" "${resultFile}"` }, null, 2));
if (!process.argv.includes('--prepare-only')) {
  const child = spawn(executable, [rawFile, resultFile], { windowsHide: false, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('Fixture exited ' + code))); });
  metadata.captureStatus = 'production-dialog-interacted';
  metadata.result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
  await fs.writeFile(path.join(output, 'fixture.json'), JSON.stringify(metadata, null, 2));
}
