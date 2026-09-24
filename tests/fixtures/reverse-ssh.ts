import { Server, utils, type Connection } from 'ssh2';
import { createHash, generateKeyPairSync } from 'node:crypto';
import net from 'node:net';
import type { Duplex } from 'node:stream';

// Real SSH channels and TCP listeners, all confined to loopback. The fixed
// verification command is modelled here; production executes it on Linux.
export async function reverseSshFixture() {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const parsed = utils.parseKey(key); if (parsed instanceof Error) throw parsed;
  const fingerprint = 'SHA256:' + createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
  const clients = new Set<Connection>(), administrators = new Set<Connection>(), listeners = new Set<net.Server>(), sockets = new Set<Duplex>();
  const state = { rejectAuth: false, rejectForward: false, unsafeBind: false, pauseVerify: false, logins: 0, ports: [] as number[] };
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); const owned = new Set<net.Server>();
    client.on('close', () => { clients.delete(client); administrators.delete(client); for (const listener of owned) listener.close(); });
    client.on('authentication', context => {
      if (context.method !== 'password' || context.password !== 'test-password' || state.rejectAuth) return context.reject();
      if (context.username === 'root') administrators.add(client); context.accept();
    });
    client.on('ready', () => { state.logins++; });
    client.on('request', (accept, reject, name, info: any) => {
      if (name === 'tcpip-forward') {
        if (state.rejectForward || info.bindAddr !== '127.0.0.1') return reject?.();
        const listener = net.createServer(socket => {
          sockets.add(socket); socket.on('error', () => socket.destroy()); socket.once('close', () => sockets.delete(socket));
          const port = (listener.address() as net.AddressInfo).port;
          client.forwardOut('127.0.0.1', port, '127.0.0.1', socket.remotePort || 0, (error, channel) => {
            if (error) { socket.destroy(); return; }
            sockets.add(channel); channel.on('error', () => channel.destroy()); channel.once('close', () => { sockets.delete(channel); socket.destroy(); });
            socket.pipe(channel).pipe(socket);
          });
        });
        listener.once('error', () => reject?.()); listeners.add(listener); owned.add(listener);
        listener.once('close', () => { listeners.delete(listener); owned.delete(listener); });
        listener.listen(info.bindPort, '127.0.0.1', () => { const port = (listener.address() as net.AddressInfo).port; state.ports.push(port); accept?.(port); });
      } else if (name === 'cancel-tcpip-forward') {
        const listener = [...owned].find(item => (item.address() as net.AddressInfo)?.port === info.bindPort); listener?.close(); accept?.();
      } else reject?.();
    });
    client.on('session', accept => accept().on('exec', (accept, reject, info) => {
      if (!info.command.startsWith("python3 -u -c 'import sys,base64;")) { reject(); return; }
      const channel = accept(); let request = '';
      channel.on('data', (value: Buffer) => request += value.toString());
      channel.on('end', () => {
        if (state.pauseVerify) return;
        const [code, value] = request.trim().split('\n'), port = Number(value);
        const program = Buffer.from(code, 'base64').toString();
        if (!program.includes('/proc/net') || !state.ports.includes(port)) { channel.exit(1); channel.end(); return; }
        channel.write(state.unsafeBind ? 'UNSAFE_BIND\n' : 'LOOPBACK_ONLY\n'); channel.exit(0); channel.end();
      });
    }));
    client.on('tcpip', (accept, reject, info) => {
      if (info.destIP !== '127.0.0.1' || ![...listeners].some(item => (item.address() as net.AddressInfo)?.port === info.destPort)) return reject();
      const socket = net.connect(info.destPort, '127.0.0.1'); sockets.add(socket);
      socket.on('error', () => socket.destroy()); socket.once('close', () => sockets.delete(socket));
      socket.once('connect', () => { const channel = accept(); sockets.add(channel); channel.on('error', () => channel.destroy()); channel.once('close', () => { sockets.delete(channel); socket.destroy(); }); socket.pipe(channel).pipe(socket); });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    state, listeners,
    profile: { host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, username: 'root', fingerprint, root: '/srv/teamspace' },
    disconnect: () => { for (const client of clients) client.end(); for (const socket of sockets) socket.destroy(); },
    disconnectAdmin: () => { for (const client of administrators) client.end(); },
    close: async () => { for (const client of clients) client.end(); for (const socket of sockets) socket.destroy(); for (const listener of listeners) listener.close(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
