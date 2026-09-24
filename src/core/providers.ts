import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Provider, ProviderInfo } from '../shared/types';
import { spawnCLI } from './rpc';
import { cliFile, findWindowsCliOnPath } from './cli-path';
const exec = promisify(execFile);
export async function resolveProvider(provider: Provider, configured = ''): Promise<string> {
  if (configured.trim()) {
    const file = await cliFile(configured);
    if (!file) throw new Error('CLI 路径无效，请选择可运行的 CLI 文件（Windows 使用 .exe、.cmd 或 .ps1）。');
    return file;
  }
  // Prefer the CLI available in the user's terminal. Bundled copies are a fallback.
  const names = provider === 'codex' ? ['codex'] : provider === 'claude' ? ['claude'] : ['agent', 'cursor-agent'];
  for (const name of names) {
    if (process.platform === 'win32') {
      const file = await findWindowsCliOnPath(name);
      if (file) return file;
    } else {
      try {
        const matches = (await exec('which', [name], { timeout: 5000 })).stdout.trim().split(/\r?\n/).filter(Boolean);
        for (const found of matches) { const file = await cliFile(found); if (file) return file; }
      } catch {}
    }
  }
  const base = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const bundled = provider === 'claude' ? '' : base ? path.join(base, 'providers', provider, provider === 'codex' ? 'bin/codex.exe' : 'cursor-agent.cmd') : '';
  const dev = provider === 'claude' ? '' : provider === 'codex' ? path.join(process.cwd(), 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe') : path.join(process.cwd(), '.tools/cursor/dist-package/cursor-agent.cmd');
  for (const candidate of [bundled, dev]) { const file = await cliFile(candidate); if (file) return file; }
  if (provider === 'claude' && process.platform === 'win32') {
    const native = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const file = await cliFile(native); if (file) return file;
  }
  const home = os.homedir(), local = process.env.LOCALAPPDATA || '';
  const candidates = provider === 'cursor' ? [path.join(local, 'cursor-agent', 'agent.exe'), path.join(local, 'cursor-agent', 'cursor-agent.cmd'), path.join(home, '.local', 'bin', 'agent.exe'), path.join(home, '.local', 'bin', 'agent'), path.join(home, '.local', 'bin', 'cursor-agent'), path.join(process.cwd(), '.tools', 'cursor', 'cursor-agent.cmd')] : provider === 'claude' ? [path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'), path.join(home, '.local', 'bin', 'claude.exe'), path.join(home, '.local', 'bin', 'claude')] : [path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'), path.join(home, '.local', 'bin', 'codex.exe')];
  if (provider === 'cursor') candidates.push(path.join(process.cwd(), '.tools', 'cursor', 'dist-package', 'cursor-agent.cmd'));
  for (const candidate of candidates) { const file = await cliFile(candidate); if (file) return file; }
  throw new Error(provider === 'cursor' ? '未找到 Cursor Agent CLI。Cursor 编辑器的 cursor 命令不是 Agent CLI，请安装 agent 或在设置中选择其路径。' : provider === 'claude' ? '未找到 Claude Code CLI，请安装 claude 或在设置中选择其路径。' : '未找到 Codex CLI，请安装 Codex 或在设置中选择 codex.exe 或 codex.cmd。');
}
export async function inspectProvider(provider: Provider, configured: string): Promise<ProviderInfo> {
  try {
    const executable = await resolveProvider(provider, configured);
    const version = await new Promise<string>((resolve, reject) => {
      const child = spawnCLI(executable, ['--version'], os.homedir()); let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('CLI 版本检测超时')); }, 15000);
      child.stdout.on('data', data => { output += data.toString(); });
      child.stderr.on('data', data => { output += data.toString(); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(output.trim().slice(0, 300)) : reject(new Error(output.slice(0, 300) || 'CLI 无法启动')); });
    });
    return { provider, path: executable, available: true, version, detail: provider === 'codex' ? 'App Server · 使用个人 Codex 登录' : provider === 'claude' ? 'CLI · 使用本机 Claude Code 登录' : 'ACP · 使用个人 Cursor 登录' };
  } catch (e: any) { return { provider, path: configured, available: false, version: '', detail: e.message }; }
}
