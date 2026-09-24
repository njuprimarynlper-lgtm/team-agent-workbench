import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import path from 'node:path';

test('production relay worker reports its own process resources periodically and stops without GUI or credentials in snapshots', async () => {
  const entry = path.resolve('src/admin/egress-worker.ts');
  const options = { execArgv: ['--require', path.resolve('scripts/background-guard.cjs'), '--import', 'tsx'], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] as ['ignore', 'ignore', 'ignore', 'ipc'] };
  const child = fork(path.resolve('tests/fixtures/relay-worker.cjs'), [entry], options);
  const messages: any[] = []; child.on('message', message => messages.push(message));
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 5000; while (!predicate()) { if (Date.now() > deadline) throw new Error('worker timeout'); await new Promise(resolve => setTimeout(resolve, 20)); } };
  try {
    child.send({ id: 1, action: 'start', payload: { config: { enabled: false }, secret: { accessCode: 'PRIVATE_ACCESS', upstreamPassword: 'PRIVATE_PASSWORD' }, certificate: { pfx: [], passphrase: 'PRIVATE_CERT', fingerprint: 'fixture' } } });
    await wait(() => messages.some(message => message.type === 'response' && message.id === 1));
    assert.equal(messages.find(message => message.type === 'response' && message.id === 1).error, undefined);
    await wait(() => messages.filter(message => message.type === 'snapshot' && message.value.monitor.process).length >= 2);
    const snapshot = messages.filter(message => message.type === 'snapshot').at(-1).value;
    assert.equal(snapshot.monitor.process.pid, child.pid); assert.notEqual(snapshot.monitor.process.pid, process.pid);
    assert(snapshot.monitor.process.memoryBytes > 0); assert(snapshot.monitor.process.cpuPercent >= 0 && snapshot.monitor.process.cpuPercent <= 100);
    assert(snapshot.monitor.history.length >= 2); assert.equal(snapshot.monitor.bytesUp, 0); assert(!JSON.stringify(messages).includes('PRIVATE'));
    child.send({ id: 2, action: 'stop' }); await wait(() => messages.some(message => message.type === 'response' && message.id === 2));
  } finally {
    const closed = new Promise<void>(resolve => child.once('exit', () => resolve())); child.disconnect(); await closed;
  }
});
