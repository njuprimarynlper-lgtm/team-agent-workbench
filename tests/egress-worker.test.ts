import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';

test('production relay worker reports its own process resources periodically and stops without GUI or credentials in snapshots', async () => {
  const entry = path.resolve('src/admin/egress-worker.ts');
  const options = { execArgv: ['--require', path.resolve('scripts/background-guard.cjs'), '--import', 'tsx'], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] as ['ignore', 'ignore', 'ignore', 'ipc'] };
  const requests: string[] = [], sockets = new Set<net.Socket>();
  const upstream = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); socket.once('data', value => { requests.push(value.toString().split('\r\n')[0]); socket.end('HTTP/1.1 200 Connection Established\r\n\r\n'); }); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const child = fork(path.resolve('tests/fixtures/relay-worker.cjs'), [entry], options);
  const messages: any[] = []; child.on('message', message => messages.push(message));
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 5000; while (!predicate()) { if (Date.now() > deadline) throw new Error('worker timeout'); await new Promise(resolve => setTimeout(resolve, 20)); } };
  try {
    child.send({ id: 1, action: 'start', payload: { config: { enabled: false, codex: true, cursor: false, claude: false, upstreamMode: 'http', upstreamHost: '127.0.0.1', upstreamPort: (upstream.address() as net.AddressInfo).port, upstreamUsername: '' }, secret: { accessCode: 'PRIVATE_ACCESS', upstreamPassword: 'PRIVATE_PASSWORD' }, certificate: { pfx: [], passphrase: 'PRIVATE_CERT', fingerprint: 'fixture' } } });
    await wait(() => messages.some(message => message.type === 'response' && message.id === 1));
    assert.equal(messages.find(message => message.type === 'response' && message.id === 1).error, undefined);
    await wait(() => messages.filter(message => message.type === 'snapshot' && message.value.monitor.process).length >= 2);
    const snapshot = messages.filter(message => message.type === 'snapshot').at(-1).value;
    assert.equal(snapshot.monitor.process.pid, child.pid); assert.notEqual(snapshot.monitor.process.pid, process.pid);
    assert(snapshot.monitor.process.memoryBytes > 0); assert(snapshot.monitor.process.cpuPercent >= 0 && snapshot.monitor.process.cpuPercent <= 100);
    assert(snapshot.monitor.history.length >= 2); assert.equal(snapshot.monitor.bytesUp, 0); assert(!JSON.stringify(messages).includes('PRIVATE'));
    child.send({ id: 2, action: 'probe', payload: { provider: 'cursor' } }); await wait(() => messages.some(message => message.type === 'response' && message.id === 2));
    assert.equal(messages.find(message => message.type === 'response' && message.id === 2).error, undefined);
    assert.deepEqual(requests, ['CONNECT api2.cursor.sh:443 HTTP/1.1']);
    assert.equal(messages.filter(message => message.type === 'snapshot').at(-1).value.running, false);
    child.send({ id: 3, action: 'stop' }); await wait(() => messages.some(message => message.type === 'response' && message.id === 3));
  } finally {
    const closed = new Promise<void>(resolve => child.once('exit', () => resolve())); child.disconnect(); await closed;
    for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
