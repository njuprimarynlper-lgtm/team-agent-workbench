import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotRefresh, createStateEventRefresh } from '../src/renderer/snapshot-refresh';

test('overlapping state events use one in-flight read and one follow-up read', async () => {
  const pending: ((value: number) => void)[] = [], values: number[] = [], errors: unknown[] = [];
  const refresh = createSnapshotRefresh(() => new Promise<number>(resolve => pending.push(resolve)), value => values.push(value), error => errors.push(error));
  const first = refresh();
  const later = Array.from({ length: 50 }, () => refresh());
  assert.equal(pending.length, 1);
  pending.shift()!(1);
  await first;
  assert.equal(pending.length, 1);
  pending.shift()!(2);
  await Promise.all(later);
  assert.deepEqual(values, [1, 2]);
  assert.deepEqual(errors, []);
});

test('a failed read releases its waiter and later updates still refresh', async () => {
  let calls = 0;
  const values: number[] = [], errors: unknown[] = [];
  const refresh = createSnapshotRefresh(async () => { if (++calls === 1) throw Error('read failed'); return calls; }, value => values.push(value), error => errors.push(error));
  await refresh();
  await refresh();
  assert.deepEqual(values, [2]);
  assert.equal((errors[0] as Error).message, 'read failed');
});

test('streaming state events request at most one snapshot per interval and can be cancelled', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let reads = 0;
  const events = createStateEventRefresh(async () => { reads++; }, 250);
  for (let index = 0; index < 20; index++) events.request();
  t.mock.timers.tick(0);
  assert.equal(reads, 1);
  for (let index = 0; index < 20; index++) events.request();
  t.mock.timers.tick(249);
  assert.equal(reads, 1);
  t.mock.timers.tick(1);
  assert.equal(reads, 2);
  events.request(); events.cancel();
  t.mock.timers.tick(250);
  assert.equal(reads, 2);
});
