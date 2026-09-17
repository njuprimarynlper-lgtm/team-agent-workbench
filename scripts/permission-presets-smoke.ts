// Check the installed Codex protocol with isolated, ephemeral conversations.
// No model turn, personal configuration change, or real account request.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { JsonRpc } from '../src/core/rpc';
import { resolveProvider } from '../src/core/providers';
import { codexPermissionParams, codexPermissions } from '../src/core/permissions';
import { permissionReportDescription } from '../src/shared/permission-presentation';

async function main() {
  const root = path.resolve('.test-data', 'native-permission-presets-' + Date.now());
  const home = path.join(root, 'codex-home'), cwd = path.join(root, 'workspace');
  await fs.mkdir(home, { recursive: true }); await fs.mkdir(cwd);
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider = "fixture"\nmodel = "fixture-model"\n[windows]\nsandbox = "unelevated"\n[model_providers.fixture]\nname = "No model calls"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n');
  const rpc = new JsonRpc(await resolveProvider('codex'), ['app-server'], cwd, false, { CODEX_HOME: home, CODEX_SQLITE_HOME: home });
  const results: object[] = [];
  try {
    await rpc.request('initialize', { clientInfo: { name: 'workbench_permission_presets', version: '0.7.0' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized');
    for (const mode of ['review', 'auto', 'full'] as const) {
      const params = codexPermissionParams({ purpose: 'work', permissionMode: mode });
      const response = await rpc.request('thread/start', { cwd, ephemeral: true, ...params });
      assert.equal(response.approvalPolicy, params.approvalPolicy);
      assert.equal(response.approvalsReviewer, params.approvalsReviewer);
      assert.equal(response.sandbox.type, mode === 'full' ? 'dangerFullAccess' : 'workspaceWrite');
      results.push({ mode, sandbox: response.sandbox.type, approval: response.approvalPolicy, reviewer: response.approvalsReviewer, description: permissionReportDescription(codexPermissions(response, 'runtime')) });
    }
    await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify(results, null, 2));
    console.log('Native Codex presets passed:', JSON.stringify(results));
  } finally { await rpc.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
