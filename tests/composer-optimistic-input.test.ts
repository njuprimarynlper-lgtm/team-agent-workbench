import test from 'node:test';
import assert from 'node:assert/strict';
import { submitOptimisticInput } from '../src/renderer/composer-input';
import type { SessionInput, WorkbenchAPI } from '../src/shared/types';

function fixture() {
  let draft: SessionInput = { text: '提交的任务', sourceIds: ['source'], answers: {}, capabilities: [{ id: 'skill', name: '复核', kind: 'skill' }] };
  const requests: { name: string; data: any }[] = [];
  let resolve!: (value: boolean) => void, reject!: (error: Error) => void;
  const api = { call: (name: string, data: any) => { requests.push({ name, data }); return new Promise<boolean>((yes, no) => { resolve = yes; reject = no; }); } } as WorkbenchAPI;
  const latest = () => draft, write = (value: SessionInput) => { draft = value; };
  return { latest, write, requests, send: (enqueue = false, sent = draft) => submitOptimisticInput(api, 'session', sent, latest, write, enqueue), resolve: (value: boolean) => resolve(value), reject: () => reject(new Error('网络失败')) };
}
test('send clears immediately, freezes submitted attachments, and preserves the next draft on acceptance', async () => {
  const f = fixture(), original = f.latest(), pending = f.send();
  assert.equal(f.latest().text, ''); assert.deepEqual(f.latest().sourceIds, []);
  original.sourceIds.push('late'); original.capabilities![0].name = 'changed';
  f.write({ ...f.latest(), text: '下一轮' }); f.resolve(true); await pending;
  assert.equal(f.latest().text, '下一轮'); assert.deepEqual(f.requests[0].data.sourceIds, ['source']);
  assert.equal(f.requests[0].data.capabilities[0].name, '复核'); assert.equal(f.requests[0].name, 'session.send');
});
test('rejected and false acknowledgements restore an untouched draft including its references', async () => {
  for (const rejects of [true, false]) {
    const f = fixture(), original = structuredClone(f.latest()), pending = f.send();
    if (rejects) { f.reject(); await assert.rejects(pending, /网络/); } else { f.resolve(false); assert.equal(await pending, false); }
    assert.deepEqual(f.latest(), original);
  }
});
test('failure never replaces later typing, attachment changes, or an intentionally cleared new draft', async () => {
  for (const draft of [{ text: '新的内容', sourceIds: [] }, { text: '', sourceIds: ['new'] }, { text: '', sourceIds: [] }]) {
    const f = fixture(), pending = f.send();
    f.write({ ...f.latest(), text: '输入后再修改' }); f.write({ ...f.latest(), ...draft });
    f.reject(); await assert.rejects(pending, /网络/);
    assert.equal(f.latest().text, draft.text); assert.deepEqual(f.latest().sourceIds, draft.sourceIds);
  }
});
test('a delayed preparation result sends its captured draft without clearing newer text', async () => {
  const f = fixture(), captured = structuredClone(f.latest()); f.write({ ...f.latest(), text: '后续编辑' });
  const pending = f.send(false, captured); assert.equal(f.latest().text, '后续编辑');
  f.resolve(true); await pending; assert.equal(f.requests[0].data.text, '提交的任务');
});
test('queue acceptance uses the same optimistic draft protection without direct sending', async () => {
  const f = fixture(), pending = f.send(true); assert.equal(f.requests[0].name, 'session.enqueue');
  assert.equal(f.latest().text, ''); f.resolve(true); assert.equal(await pending, true);
});
