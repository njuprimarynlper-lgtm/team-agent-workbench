import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

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
  assert.match(helper, /Invoke-StartupProcess -File \$npm/);
  assert.match(helper, /-Errors \$script:stderrLog -TimeoutSeconds/);
  assert.match(helper, /System\.Windows\.Forms\.MessageBox/);
  assert.match(helper, /Invoke-StartupProcess -File \$nodePath -Arguments @\('"scripts\\launch-desktop\.mjs"', \$Edition\)/);
  assert.doesNotMatch(helper, /Start-Process -FilePath \$electron/);
});
