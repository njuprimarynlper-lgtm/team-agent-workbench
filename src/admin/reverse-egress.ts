import { Client, type ClientChannel } from 'ssh2';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import type { ReverseEgressSnapshot } from '../shared/egress';
import { forwardEgress } from '../core/ssh-egress';

export type ReverseEgressOptions = {
  host: string; port: number; username: string; password: string; fingerprint: string;
  remotePort: number; localHost: string; localPort: number;
};
class PermanentTunnelError extends Error {}

// GatewayPorts=yes can override the requested loopback bind. Check actual Linux
// listeners on every connection before accepting forwarded traffic or publishing
// the route. No SSH configuration, accounts or files are modified here.
const verifyProgram = `import pathlib,sys
port=int(sys.stdin.buffer.readline())
assert 1 <= port <= 65535
addresses=[]
for name in ["tcp", "tcp6"]:
    file=pathlib.Path("/proc/net")/name
    if not file.exists(): continue
    for line in file.read_text().splitlines()[1:]:
        fields=line.split()
        if fields[3]!="0A": continue
        address,number=fields[1].split(":")
        if int(number,16)==port: addresses.append(address)
print("LOOPBACK_ONLY" if addresses and all(a in ["0100007F", "00000000000000000000000001000000"] for a in addresses) else "UNSAFE_BIND",flush=True)
`;

export class ReverseEgressTunnel extends EventEmitter {
  private options?: ReverseEgressOptions;
  private client?: Client;
  private cancelAttempt?: () => void;
  private retry?: NodeJS.Timeout;
  private generation = 0;
  private failures = 0;
  private sockets = new Set<Duplex>();
  private value: ReverseEgressSnapshot = { enabled: false, state: 'disabled', detail: '未启用反向隧道', activeConnections: 0, reconnects: 0, bytesUp: 0, bytesDown: 0 };
  constructor(private retryDelay = (attempt: number) => Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5))) { super(); }
  snapshot() { return structuredClone(this.value); }
  openChannel(signal: AbortSignal) {
    if (this.value.state !== 'connected' || !this.client || !this.value.remotePort) throw new Error('反向隧道尚未连接');
    return forwardEgress(this.client, '127.0.0.1', this.value.remotePort, signal);
  }
  private update(patch: Partial<ReverseEgressSnapshot>) { Object.assign(this.value, patch); this.emit('changed'); }
  async start(options: ReverseEgressOptions) {
    this.stop();
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(options.fingerprint)) throw new Error('共享服务器身份未验证，请重新登录');
    this.options = { ...options }; this.failures = 0;
    this.update({ enabled: true, state: 'connecting', detail: '正在建立反向隧道', server: `${options.host}:${options.port}`, remotePort: options.remotePort || undefined, reconnects: 0, bytesUp: 0, bytesDown: 0 });
    await this.connect(this.generation);
    return this.snapshot();
  }
  stop() {
    this.generation++; clearTimeout(this.retry); this.retry = undefined;
    this.options = undefined; this.cancelAttempt?.(); this.cancelAttempt = undefined;
    const client = this.client; this.client = undefined; client?.destroy();
    for (const socket of this.sockets) socket.destroy(); this.sockets.clear();
    this.update({ enabled: false, state: 'disabled', detail: '反向隧道已关闭', activeConnections: 0 });
  }
  private async connect(generation: number) {
    const options = this.options;
    if (!options || generation !== this.generation) return;
    const client = new Client(); this.client = client;
    let ready = false, failed = false, assignedPort = options.remotePort, fatal: Error | undefined;
    const current = () => generation === this.generation && this.client === client;
    const handleFailure = (error: Error) => {
      error = fatal || error;
      if (failed || !current()) return;
      failed = true; ready = false; client.destroy();
      for (const socket of this.sockets) socket.destroy(); this.sockets.clear();
      const permanent = error instanceof PermanentTunnelError || (error as any).level === 'client-authentication';
      this.update({ state: permanent ? 'error' : 'reconnecting', activeConnections: 0,
        detail: permanent ? error instanceof PermanentTunnelError ? error.message : '服务器登录已失效，请重新登录管理端' : '反向隧道连接中断，正在自动重连' });
      if (!permanent) {
        this.failures++; this.retry = setTimeout(() => {
          this.retry = undefined;
          if (!current()) return;
          this.update({ reconnects: this.value.reconnects + 1 });
          void this.connect(generation).catch(() => {});
        }, this.retryDelay(this.failures)).unref();
      }
    };
    client.on('tcp connection', (info, accept, reject) => {
      if (!current() || !ready || info.destIP !== '127.0.0.1' || info.destPort !== assignedPort || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(info.srcIP)) { reject(); return; }
      const stream = accept(); this.forward(stream, options, current);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (error instanceof PermanentTunnelError) fatal = error;
          if (settled) return; settled = true; clearTimeout(timer); if (current()) this.cancelAttempt = undefined;
          error ? reject(error) : resolve();
        };
        const cancel = () => finish(new Error('反向隧道已取消')); this.cancelAttempt = cancel;
        const timer = setTimeout(() => finish(new Error('建立反向隧道超时')), 35000);
        client.on('error', error => { finish(error); handleFailure(error); });
        client.once('close', () => { const error = new Error('共享服务器连接已关闭'); finish(error); handleFailure(error); });
        client.once('ready', () => client.forwardIn('127.0.0.1', assignedPort, async (error, port) => {
          if (!current()) { client.destroy(); return; }
          if (error) { finish(new Error('服务器拒绝反向隧道，请检查内部端口占用和 SSH 转发权限')); return; }
          assignedPort = port || assignedPort;
          try {
            await this.verifyLoopback(client, assignedPort);
            if (!current() || settled) { client.destroy(); return; }
            options.remotePort = assignedPort; ready = true; this.failures = 0;
            this.update({ state: 'connected', detail: '反向隧道已连接', remotePort: assignedPort });
            finish();
          } catch (reason) { finish(reason instanceof Error ? reason : new Error('无法核对隧道监听范围')); }
        }));
        client.connect({ host: options.host, port: options.port, username: options.username, password: options.password,
          readyTimeout: 15000, keepaliveInterval: 10000, keepaliveCountMax: 3,
          hostVerifier: (key: Buffer) => {
            const matches = options.fingerprint === 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
            if (!matches) finish(new PermanentTunnelError('共享服务器身份发生变化，请核对后重新登录'));
            return matches;
          } });
      });
    } catch (error) { handleFailure(error as Error); throw error; }
  }
  private verifyLoopback(client: Client, port: number) {
    return new Promise<void>((resolve, reject) => {
      let channel: ClientChannel | undefined, settled = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); client.off('close', closed); channel?.destroy(); error ? reject(error) : resolve(); };
      const closed = () => finish(new Error('验证期间服务器连接已关闭'));
      const timer = setTimeout(() => finish(new Error('验证隧道监听范围超时')), 10000); client.once('close', closed);
      client.exec("python3 -u -c 'import sys,base64;exec(base64.b64decode(sys.stdin.buffer.readline()))'", (error, stream) => {
        if (error) { finish(error); return; } channel = stream;
        if (settled) { stream.destroy(); return; }
        let output = ''; stream.on('data', (value: Buffer) => { output += value.toString(); if (output.length > 128) finish(new PermanentTunnelError('无法核对服务器监听范围')); }); stream.stderr.resume();
        stream.once('error', finish); stream.once('close', (code: number) => finish(code === 0 && output.trim() === 'LOOPBACK_ONLY' ? undefined : new PermanentTunnelError('服务器没有将隧道限制在回环地址，请检查 SSH GatewayPorts 设置')));
        stream.end(Buffer.from(verifyProgram).toString('base64') + '\n' + port + '\n');
      });
    });
  }
  private forward(stream: ClientChannel, options: ReverseEgressOptions, current: () => boolean) {
    stream.pause();
    const local = net.connect({ host: options.localHost, port: options.localPort });
    this.sockets.add(stream); this.sockets.add(local); this.update({ activeConnections: this.value.activeConnections + 1 });
    let closed = false, drain: NodeJS.Timeout | undefined;
    const close = () => {
      if (closed) return; closed = true; clearTimeout(drain); stream.destroy(); local.destroy(); this.sockets.delete(stream); this.sockets.delete(local);
      if (current()) this.update({ activeConnections: Math.max(0, this.value.activeConnections - 1) });
    };
    stream.on('error', close); stream.once('close', close); local.on('error', close);
    local.once('close', () => {
      if (closed) return;
      if (!local.readableEnded || local.errored) { close(); return; }
      // A clean local EOF may leave encrypted bytes in the SSH window queue.
      // Flush them before sending CHANNEL_CLOSE instead of destroying the stream.
      if (stream.writableFinished) stream.close(); else stream.once('finish', () => stream.close());
      drain = setTimeout(close, 5000).unref();
    });
    local.setTimeout(10000, close); local.once('connect', () => { local.setTimeout(0); if (!current()) { close(); return; } stream.pipe(local).pipe(stream); });
    stream.on('data', (data: Buffer) => { if (current()) this.value.bytesUp += data.length; }); local.on('data', data => { if (current()) this.value.bytesDown += data.length; });
  }
}
