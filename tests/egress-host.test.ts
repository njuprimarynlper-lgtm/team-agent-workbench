import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EgressHost, type RelayProcess } from '../src/admin/egress-host';
import type { AdminEgressConfig } from '../src/shared/egress';

class Worker extends EventEmitter implements RelayProcess {
  pid = 9876; killed = false; commands: any[] = [];
  postMessage(value: any) {
    this.commands.push(value);
    queueMicrotask(() => {
      if (value.action === 'start') this.emit('message', { type: 'snapshot', value: { running: true, activeConnections: 0, events: [], fingerprint: 'fixture' } });
      this.emit('message', { type: 'response', id: value.id, value: true });
    });
  }
  kill() { this.killed = true; this.emit('exit', 0); return true; }
}
test('isolated relay uses IPC for secrets, serializes changes, drops old workers and releases resources on disable', async () => {
  const workers: Worker[] = [], config = { enabled: true } as AdminEgressConfig;
  const host = new EgressHost('/immutable-assets/egress-worker.cjs', config, { accessCode: 'PRIVATE' }, { pfx: Buffer.alloc(0), passphrase: 'PRIVATE', fingerprint: 'fixture' }, entry => { assert.equal(entry, '/immutable-assets/egress-worker.cjs'); const worker = new Worker(); workers.push(worker); return worker; });
  await host.start(); assert.equal(host.snapshot().running, true); assert.equal(workers[0].commands[0].payload.secret.accessCode, 'PRIVATE');
  await host.start(); assert.equal(workers.length, 1, 'repeated startup must not create competing proxy processes');
  assert(!JSON.stringify(host.snapshot()).includes('PRIVATE'));
  await host.probe('codex');
  await host.restart(config, { accessCode: 'NEW' }); assert.equal(workers[0].killed, true); assert.equal(workers.length, 2);
  workers[0].emit('message', { type: 'snapshot', value: { running: false, lastError: 'stale' } }); assert.equal(host.snapshot().running, true);
  await host.restart({ ...config, enabled: false }, { accessCode: 'NEW' }); assert.equal(workers.length, 2); assert.equal(workers[1].killed, true); assert.equal(host.snapshot().running, false);
  await assert.rejects(host.probe('codex'), /未启动/); await host.stop();
});
test('unexpected worker exit clears stale live metrics and rejects in-flight operations', async () => {
  const worker = new Worker();
  const host = new EgressHost('worker', { enabled: true } as AdminEgressConfig, { accessCode: 'fixture' }, { pfx: Buffer.alloc(0), passphrase: '', fingerprint: '' }, () => worker);
  await host.start(); worker.postMessage = () => {};
  const pending = assert.rejects(host.probe('codex'), /已退出/); worker.emit('exit', 1); await pending;
  assert.equal(host.snapshot().running, false); assert.equal(host.snapshot().monitor, undefined); assert.match(host.snapshot().lastError!, /意外退出/);
});
