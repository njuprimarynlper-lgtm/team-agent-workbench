import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freezeTranscript, frozenTranscriptName, readFrozenPage } from '../src/core/frozen-transcript';
import type { Message } from '../src/shared/types';

test('nested branches page across legacy, ancestor and parent records independently of the source files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-fork-pages-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rows = (name: string, count: number): Message[] => Array.from({ length: count }, (_, i) => ({ id: name + i, role: 'assistant', text: name + i, createdAt: '' }));
  const parent = rows('parent', 201), child = rows('child', 65), grandchild = rows('grandchild', 81);
  const legacy = path.join(root, 'inherited-conversation.json');
  await fs.writeFile(legacy, JSON.stringify(parent));
  const [last, previous] = await Promise.all([readFrozenPage(legacy, 201, 160), readFrozenPage(legacy, 41, 160)]);
  assert.deepEqual(last.messages, parent.slice(41)); assert.deepEqual(previous.messages, parent.slice(0, 41));
  await fs.access(path.join(legacy + '.pages', frozenTranscriptName));
  const dir = path.join(root, 'child'), next = path.join(root, 'grandchild');
  await Promise.all([fs.mkdir(dir), fs.mkdir(next)]);
  const first = path.join(dir, frozenTranscriptName), second = path.join(next, frozenTranscriptName);
  assert.equal(await freezeTranscript(first, legacy, child), 266);
  assert.equal(await freezeTranscript(second, first, grandchild), 347);
  await fs.rm(dir, { recursive: true });
  await fs.unlink(legacy);
  const expected = [...parent, ...child, ...grandchild];
  let before = expected.length;
  for (const size of [160, 160, 27]) {
    const page = await readFrozenPage(second, before, 160);
    assert.equal(page.messages.length, size);
    assert.deepEqual(page.messages, expected.slice(before - size, before));
    before = page.before;
  }
  assert.equal(before, 0);
});
