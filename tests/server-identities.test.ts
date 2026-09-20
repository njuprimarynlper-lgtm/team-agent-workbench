import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ServerIdentityStore } from '../src/core/server-identities';

test('server identity trust is shared by machine endpoint, not member account or window', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-server-identities-'));
  const file = path.join(root, 'server-identities.json'), endpoint = 'example.test:22';
  const firstFingerprint = 'SHA256:YWxpY2U', changedFingerprint = 'SHA256:Ym9i';
  try {
    const first = new ServerIdentityStore(file); await first.init({ [endpoint]: firstFingerprint });
    const second = new ServerIdentityStore(file); await second.init({ [endpoint]: changedFingerprint });
    assert.equal(second.get(endpoint), firstFingerprint);
    await second.remember(endpoint, firstFingerprint);
    await assert.rejects(second.remember(endpoint, changedFingerprint), /服务器身份发生变化/);
    await second.forget(endpoint); assert.equal(second.get(endpoint), '');
    const reopened = new ServerIdentityStore(file); await reopened.init({ [endpoint]: firstFingerprint });
    assert.equal(reopened.get(endpoint), '', 'an explicit machine-level reset must not re-import per-window legacy trust');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
