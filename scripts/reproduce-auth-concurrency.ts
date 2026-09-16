import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ProviderAccounts } from '../src/core/provider-auth';
// @ts-expect-error Shared JavaScript fixture.
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';
async function main() {
  const root = path.resolve('.test-data/auth-concurrency-' + Date.now());
  const fixture = await authLauncher(root, { status: 'ready' });
  const a = path.join(root, 'A'), b = path.join(root, 'B'); await fs.mkdir(a); await fs.mkdir(b);
  const accounts = new ProviderAccounts(() => fixture.launcher, () => {});
  try {
    const results = await Promise.all([accounts.check('codex', a), accounts.check('codex', b)]);
    assert.equal(results[0].status, 'error'); assert.equal(results[1].status, 'authenticated');
    console.log('KNOWN ISSUE #4 reproduced (not a fixed-feature test):', results.map((r, i) => ({ session: i ? 'B' : 'A', status: r.status, detail: r.detail })));
  } finally { await accounts.close(); }

}
void main();
