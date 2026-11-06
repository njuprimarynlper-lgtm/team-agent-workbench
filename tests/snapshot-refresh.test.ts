import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotRefresh } from '../src/renderer/snapshot-refresh';

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
