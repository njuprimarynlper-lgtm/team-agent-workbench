import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

test('development launchers build in a hidden helper and leave no terminal window open', async () => {
  for (const edition of ['user', 'admin']) {
    const launcher = await fs.readFile(path.join(root, `start-${edition}-dev.cmd`), 'utf8');
    assert.match(launcher, /powershell\.exe[^\r\n]+-WindowStyle Hidden/i);
    assert.match(launcher, new RegExp(`start-dev-hidden\\.ps1" ${edition}`, 'i'));
    assert.match(launcher, /exit \/b 0/i);
    assert.doesNotMatch(launcher, /npm(?:\.cmd)?\s+run\s+build/i);
    assert.doesNotMatch(launcher, /\bpause\b/i);
  }

  const helper = await fs.readFile(path.join(root, 'scripts', 'start-dev-hidden.ps1'), 'utf8');
  assert.match(helper, /Start-Process -FilePath \$npm[\s\S]+?-WindowStyle Hidden[\s\S]+?-Wait/);
  assert.match(helper, /RedirectStandardError \$stderrLog/);
  assert.match(helper, /System\.Windows\.Forms\.MessageBox/);
  assert.match(helper, /Start-Process -FilePath \$electron -ArgumentList @\(\$entry\)/);
  assert.doesNotMatch(helper, /Start-Process -FilePath \$electron[^\r\n]+-WindowStyle Hidden/);
});
