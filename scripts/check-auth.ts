import os from 'node:os';
import path from 'node:path';
import { resolveProvider } from '../src/core/providers';
import { inspectAuth } from '../src/core/provider-auth';

async function main() {
  for (const provider of ['codex', 'cursor'] as const) {
    const configured = process.argv[2] ? path.resolve(process.argv[2], provider, provider === 'codex' ? 'bin/codex.exe' : 'cursor-agent.cmd') : '';
    const executable = await resolveProvider(provider, configured);
    const result = await inspectAuth(provider, executable, os.homedir());
    // Never print raw authentication responses, email addresses, tokens or login URLs.
    console.log(provider, 'native CLI authentication probe:', result.status, result.detail);
  }
}
void main().catch(() => { console.error('Native CLI authentication probe failed to start.'); process.exitCode = 1; });
