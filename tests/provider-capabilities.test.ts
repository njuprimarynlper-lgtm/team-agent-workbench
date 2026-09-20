import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexCapabilities, cursorCommandCapabilities, cursorPluginCapabilities } from '../src/core/provider-capabilities';

test('Codex capability catalog keeps native skill paths and installed plugin mention paths', () => {
  const catalog = codexCapabilities({ data: [{ skills: [{ name: 'review', description: 'Review code', enabled: true, path: 'C:\\skills\\review\\SKILL.md', scope: 'repo' }] }] }, { marketplaces: [{ name: 'curated', plugins: [{ id: 'drive@curated', name: 'drive', installed: true, enabled: true, availability: 'AVAILABLE', interface: { displayName: 'Drive', shortDescription: 'Files', enabled: true } }] }] });
  assert.deepEqual(catalog.skills.map(item => [item.id, item.invocation, item.path]), [['skill:review', 'review', 'C:\\skills\\review\\SKILL.md']]);
  assert.deepEqual(catalog.plugins.map(item => [item.id, item.invocation, item.path]), [['plugin:drive@curated', 'drive', 'plugin://drive@curated']]);
});

test('Cursor capability catalog follows slash commands and project MCP precedence', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-capabilities-'));
  await fs.mkdir(path.join(cwd, '.cursor'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { database: { type: 'http', url: 'https://example.invalid/mcp' }, disabled: { command: 'node', disabled: true } } }));
  const skills = cursorCommandCapabilities([{ name: 'copy-request-id', description: 'internal' }, { name: 'review', description: 'Review code' }]);
  const plugins = await cursorPluginCapabilities(cwd);
  assert.deepEqual(skills.map(item => item.id), ['skill:review']);
  assert.equal(plugins.find(item => item.id === 'plugin:mcp:database')?.enabled, true);
  assert.equal(plugins.find(item => item.id === 'plugin:mcp:disabled')?.enabled, false);
});
