import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnCLI, stopCLI } from './rpc';
import type { AgentCapabilityCatalog, AgentCapabilityOption, Provider } from '../shared/types';

const clean = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 1000) : '';
const unique = (items: AgentCapabilityOption[]) => [...new Map(items.map(item => [item.id, item])).values()];

export function codexCapabilities(skillsResult: any, installedPlugins: any): AgentCapabilityCatalog {
  const entries = Array.isArray(skillsResult?.data) ? skillsResult.data : [];
  const skills = unique(entries.flatMap((entry: any) => Array.isArray(entry?.skills) ? entry.skills : []).filter((item: any) => clean(item?.name) && clean(item?.path)).map((item: any) => ({
    id: 'skill:' + clean(item.name), kind: 'skill' as const, name: clean(item.interface?.displayName) || clean(item.name),
    description: clean(item.interface?.shortDescription) || clean(item.shortDescription) || clean(item.description), invocation: clean(item.name), path: clean(item.path),
    source: item.pluginId ? '插件 · ' + clean(item.pluginId) : ({ user: '个人', repo: '当前项目', system: '内置', admin: '管理员' } as Record<string, string>)[item.scope] || clean(item.scope),
    enabled: item.enabled !== false, unavailableReason: item.enabled === false ? '已在 Codex 中停用' : undefined,
  })));
  const marketplaces = Array.isArray(installedPlugins?.marketplaces) ? installedPlugins.marketplaces : [];
  const plugins = unique(marketplaces.flatMap((marketplace: any) => (Array.isArray(marketplace?.plugins) ? marketplace.plugins : []).filter((item: any) => clean(item?.id) && item.installed !== false).map((item: any) => {
    const enabled = item.enabled !== false && item.interface?.enabled !== false && item.availability !== 'DISABLED_BY_ADMIN';
    return {
      id: 'plugin:' + clean(item.id), kind: 'plugin' as const, name: clean(item.interface?.displayName) || clean(item.name) || clean(item.id),
      description: clean(item.interface?.shortDescription) || clean(item.interface?.longDescription) || (Array.isArray(item.interface?.capabilities) ? item.interface.capabilities.map(clean).filter(Boolean).join('、') : '') || 'Codex 插件',
      invocation: clean(item.name) || clean(item.id).split('@')[0], path: 'plugin://' + clean(item.id),
      source: clean(marketplace.interface?.displayName) || clean(marketplace.name) || 'Codex 插件', enabled, unavailableReason: enabled ? undefined : '已停用或被团队策略禁用',
    };
  })));
  return { provider: 'codex', skills, plugins, checkedAt: new Date().toISOString() };
}

export function cursorCommandCapabilities(commands: any[]): AgentCapabilityOption[] {
  return unique((Array.isArray(commands) ? commands : []).filter(item => clean(item?.name) && item.name !== 'copy-request-id').map(item => ({
    id: 'skill:' + clean(item.name), kind: 'skill' as const, name: clean(item.name), description: clean(item.description) || 'Cursor Skill / 命令', invocation: clean(item.name), source: 'Cursor / 命令', enabled: true,
  })));
}

async function readMcp(file: string, source: string): Promise<AgentCapabilityOption[]> {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value?.mcpServers || typeof value.mcpServers !== 'object' || Array.isArray(value.mcpServers)) return [];
    return Object.entries(value.mcpServers).flatMap(([name, config]: [string, any]) => {
      const invocation = clean(name); if (!invocation) return [];
      const transport = clean(config?.type) || (config?.command ? 'stdio' : config?.url ? 'HTTP' : 'MCP');
      return [{ id: 'plugin:mcp:' + invocation, kind: 'plugin' as const, name: invocation, description: `${transport} 工具；Cursor CLI 会按自身配置加载`, invocation, source, enabled: config?.disabled !== true, unavailableReason: config?.disabled === true ? '已在配置中停用' : undefined }];
    });
  } catch (error: any) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return []; throw error; }
}

function ancestors(cwd: string) {
  const result: string[] = []; let current = path.resolve(cwd);
  for (;;) { result.unshift(current); const parent = path.dirname(current); if (parent === current) break; current = parent; }
  return result;
}

export async function cursorPluginCapabilities(cwd: string): Promise<AgentCapabilityOption[]> {
  const files = [path.join(os.homedir(), '.cursor', 'mcp.json'), ...ancestors(cwd).map(dir => path.join(dir, '.cursor', 'mcp.json'))];
  const lists = await Promise.all(files.map((file, index) => readMcp(file, index === 0 ? '个人 MCP' : '项目 MCP')));
  // Project definitions override personal definitions with the same server name.
  const merged = new Map<string, AgentCapabilityOption>(); for (const list of lists) for (const item of list) merged.set(item.id, item);
  return [...merged.values()];
}

export function emptyCapabilityCatalog(provider: Provider): AgentCapabilityCatalog { return { provider, skills: [], plugins: [], checkedAt: new Date().toISOString() }; }

async function claudeLocalSkills(cwd: string): Promise<AgentCapabilityOption[]> {
  const roots = [path.join(os.homedir(), '.claude'), ...ancestors(cwd).map(dir => path.join(dir, '.claude'))];
  const result = new Map<string, AgentCapabilityOption>();
  for (const root of roots) for (const kind of ['skills', 'commands'] as const) {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await fs.readdir(path.join(root, kind), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = kind === 'skills' && entry.isDirectory() ? path.join(root, kind, entry.name, 'SKILL.md') : kind === 'commands' && entry.isFile() && entry.name.endsWith('.md') ? path.join(root, kind, entry.name) : '';
      if (!file) continue;
      try {
        const content = await fs.readFile(file, 'utf8');
        const invocation = kind === 'commands' ? entry.name.slice(0, -3) : entry.name;
        const match = content.match(/^description:\s*(.+)$/m);
        result.set('skill:' + invocation, { id: 'skill:' + invocation, kind: 'skill', name: invocation, invocation, description: clean(match?.[1]) || 'Claude Code Skill', path: file, source: root === roots[0] ? '个人' : '当前项目', enabled: true });
      } catch {}
    }
  }
  return [...result.values()];
}

export async function claudeCapabilities(cwd: string, executable: string, env: NodeJS.ProcessEnv = {}): Promise<AgentCapabilityCatalog> {
  const catalog = emptyCapabilityCatalog('claude');
  catalog.skills = await claudeLocalSkills(cwd);
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawnCLI(executable, ['plugin', 'list', '--json'], cwd, env); let value = '', settled = false;
      const finish = (success: boolean) => { if (settled) return; settled = true; clearTimeout(timer); void stopCLI(child).then(() => success ? resolve(value) : reject(new Error('插件列表不可用'))); };
      const timer = setTimeout(() => finish(false), 10000);
      child.stdout.on('data', data => { value += String(data); if (value.length > 1024 * 1024) finish(false); });
      child.stderr.resume(); child.on('error', () => finish(false)); child.on('close', code => finish(code === 0));
    });
    const parsed = JSON.parse(output || '[]');
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.installed) ? parsed.installed : [];
    catalog.plugins = entries.flatMap((item: any) => {
      const name = clean(item?.name || item?.id);
      if (!name) return [];
      return [{ id: 'plugin:' + name, kind: 'plugin' as const, name, invocation: name, description: clean(item.description) || 'Claude Code 已安装插件', source: 'Claude Code', enabled: item.enabled !== false, unavailableReason: item.enabled === false ? '已停用' : undefined }];
    });
  } catch { catalog.pluginError = '已安装插件列表不可用；已配置的插件仍由 Claude Code 自行加载。'; }
  return catalog;
}
