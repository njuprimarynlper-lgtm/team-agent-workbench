import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDigest, completedRound } from '../scripts/pilot-evidence';
test('competition source evidence tolerates only Git text line endings, never changed content or binary bytes', () => {
  assert.equal(sourceDigest(Buffer.from('一\r\n二\r\n'), 'task.txt'), sourceDigest(Buffer.from('一\n二\n'), 'task.txt'));
  assert.notEqual(sourceDigest(Buffer.from('一 \n'), 'task.txt'), sourceDigest(Buffer.from('一\n'), 'task.txt'));
  assert.notEqual(sourceDigest(Buffer.from('a\r\nb'), 'linear.pt'), sourceDigest(Buffer.from('a\nb'), 'linear.pt'));
});
test('competition resume requires a completed native turn matching the last round, not just a report file', () => {
  const messages = [{ role: 'user', text: '这是你的第 1/2 轮' }];
  const done = { event: { method: 'turn/completed', params: { turn: { status: 'completed', error: null } } } };
  assert(completedRound(messages, [done], 1)); assert(!completedRound(messages, [done], 2));
  assert(!completedRound(messages, [done, { event: { direction: 'user', text: 'new request' } }], 1));
  assert(!completedRound(messages, [{ event: { method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'capacity' } } } } }], 1));
});
