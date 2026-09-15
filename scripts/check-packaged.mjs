import { _electron as electron } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = process.cwd(), data = path.join(root, '.test-data', 'packaged-' + Date.now());
await fs.mkdir(data, { recursive: true });
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: data + '-user', WORKBENCH_ADMIN_DATA_DIR: data + '-admin' }; delete env.ELECTRON_RUN_AS_NODE;
const apps = [];
try {
  for (const edition of ['admin', 'user']) {
    const executablePath = path.join(root, 'release', edition, 'win-unpacked', edition === 'admin' ? 'Team Agent Admin.exe' : 'Team Agent User.exe');
    const app = await electron.launch({ executablePath, args: [], env, timeout: 60000 }); apps.push(app);
    const page = await app.firstWindow(); await page.getByRole('button', { name: '取消', exact: true }).waitFor();
    const dataPath = await app.evaluate(({ app }) => app.getPath('userData')); assert.equal(dataPath, data + '-' + edition);
    if (edition === 'user') {
      const state = await page.evaluate(() => window.workbench.call('snapshot'));
      assert.equal(state.providers.length, 2); assert(state.providers.every(p => p.available && p.path.includes('resources')));
      await assert.rejects(page.evaluate(() => window.workbench.call('operation', { op: 'user_create' })));
    } else {
      assert.equal(await page.evaluate(() => typeof window.workbench), 'undefined');
      await assert.rejects(page.evaluate(() => window.admin.call('operation', { op: 'user_create', username: 'alice', name: 'test', password: '12345678' })));
    }
    console.log(edition, 'packaged executable starts, first-use connection dialog and edition isolation verified');
  }
  assert.notEqual(apps[0].process().pid, apps[1].process().pid);
  console.log('Both packaged executables running concurrently.');
} finally { for (const app of apps.reverse()) await app.close(); }
