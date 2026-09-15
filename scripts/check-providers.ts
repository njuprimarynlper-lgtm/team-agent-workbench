import { JsonRpc } from '../src/core/rpc';
import { resolveProvider, inspectProvider } from '../src/core/providers';
import os from 'node:os';
async function main() {
for (const provider of ['codex', 'cursor'] as const) {
  const info = await inspectProvider(provider, '');
  if (!info.available) throw new Error(info.detail);
  const rpc = new JsonRpc(await resolveProvider(provider), provider === 'codex' ? ['app-server'] : ['acp'], os.homedir(), provider === 'cursor');
  try {
    const result = await rpc.request('initialize', provider === 'codex' ? { clientInfo: { name: 'team_agent_workbench', version: '0.1.0' } } : { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'team-agent-workbench', version: '0.1.0' } }, 30000);
    console.log(provider, info.version, 'native protocol initialize OK; response fields:', Object.keys(result));
  } finally { rpc.close(); }
}

}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
