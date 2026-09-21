import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import type { AdminEgressConfig, EgressConnectionEvent, UserEgressSettings, UserEgressStatus } from '../shared/egress';

type DuplexSocket = net.Socket | tls.TLSSocket;
type RelaySecret = { accessCode: string; upstreamPassword?: string };
type RelayOptions = { pfx: Buffer; passphrase: string; fingerprint: string };
type ClientOptions = UserEgressSettings & { accessCode: string; username: string };

const cleanFingerprint = (value: string) => value.toUpperCase().replace(/^SHA256:/, '').replace(/:/g, '');
const safeDetail = (error: unknown) => {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as any).code) : '';
  return ({ ECONNREFUSED: '目标拒绝连接', ECONNRESET: '连接已重置', ETIMEDOUT: '连接超时', ENOTFOUND: '无法解析目标地址', EHOSTUNREACH: '无法到达目标' } as Record<string, string>)[code] || '连接失败';
};
const sameSecret = (actual: string, expected: string) => {
  const left = createHash('sha256').update(actual).digest(), right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
};
const hostMatches = (host: string, suffixes: string[]) => suffixes.some(suffix => host === suffix || host.endsWith('.' + suffix));
export function providerForHost(host: string): 'codex' | 'cursor' | undefined {
  host = host.toLowerCase().replace(/\.$/, '');
  if (hostMatches(host, ['openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com'])) return 'codex';
  if (hostMatches(host, ['cursor.com', 'cursor.sh', 'cursorapi.com', 'cursor-cdn.com', 'cursorvm.com'])) return 'cursor';
}

function readLine(socket: DuplexSocket, limit = 8192, timeout = 15000): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0), settled = false;
    const finish = (error?: Error, result?: { line: string; rest: Buffer }) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose);
      error ? reject(error) : resolve(result!);
    };
    const onError = (error: Error) => finish(error), onClose = () => finish(new Error('连接已关闭'));
    const onData = (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]); if (buffer.length > limit) return finish(new Error('握手数据过大'));
      const index = buffer.indexOf(10); if (index >= 0) finish(undefined, { line: buffer.subarray(0, index).toString('utf8').replace(/\r$/, ''), rest: buffer.subarray(index + 1) });
    };
    const timer = setTimeout(() => finish(new Error('连接握手超时')), timeout);
    socket.on('data', onData); socket.on('error', onError); socket.on('close', onClose);
  });
}

function connectSocket(host: string, port: number, secure = false): Promise<DuplexSocket> {
  return new Promise((resolve, reject) => {
    const socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    const event = secure ? 'secureConnect' : 'connect';
    const timer = setTimeout(() => socket.destroy(new Error('连接超时')), 15000);
    socket.once(event, () => { clearTimeout(timer); socket.off('error', reject); resolve(socket); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function connectHttpProxy(config: AdminEgressConfig, secret: RelaySecret, targetHost: string, targetPort: number) {
  const socket = await connectSocket(config.upstreamHost, config.upstreamPort);
  const credentials = config.upstreamUsername ? Buffer.from(config.upstreamUsername + ':' + (secret.upstreamPassword || '')).toString('base64') : '';
  socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${credentials ? `Proxy-Authorization: Basic ${credentials}\r\n` : ''}Proxy-Connection: Keep-Alive\r\n\r\n`);
  const response = await new Promise<{ rest: Buffer }>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new Error('上游代理连接超时')); }, 15000);
    const cleanup = () => { clearTimeout(timer); socket.off('data', data); socket.off('error', reject); socket.off('close', closed); };
    const closed = () => { cleanup(); reject(new Error('上游代理已关闭连接')); };
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 32768) { cleanup(); reject(new Error('上游代理响应过大')); return; }
      const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      const status = buffer.subarray(0, end).toString('latin1').split('\r\n')[0] || '';
      cleanup(); /^HTTP\/\d(?:\.\d)? 2\d\d\b/.test(status) ? resolve({ rest: buffer.subarray(end + 4) }) : reject(new Error('上游代理拒绝连接'));
    };
    socket.on('data', data); socket.once('error', reject); socket.once('close', closed);
  });
  return { socket, rest: response.rest };
}

async function connectSocks5(config: AdminEgressConfig, secret: RelaySecret, targetHost: string, targetPort: number) {
  const socket = await connectSocket(config.upstreamHost, config.upstreamPort), username = Buffer.from(config.upstreamUsername), password = Buffer.from(secret.upstreamPassword || '');
  socket.write(config.upstreamUsername ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
  let reply = await onceBytes(socket, 2); if (reply[0] !== 5 || reply[1] === 255) throw new Error('SOCKS5 认证方式不受支持');
  if (reply[1] === 2) {
    if (username.length > 255 || password.length > 255) throw new Error('SOCKS5 账号或密码过长');
    socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]));
    reply = await onceBytes(socket, 2); if (reply[1] !== 0) throw new Error('SOCKS5 账号认证失败');
  }
  const target = Buffer.from(targetHost, 'utf8'); if (target.length > 255) throw new Error('目标主机名过长');
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, target.length]), target, Buffer.from([targetPort >> 8, targetPort & 255])]));
  reply = await onceBytes(socket, 4); if (reply[1] !== 0) throw new Error('SOCKS5 代理拒绝连接');
  const length = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : (await onceBytes(socket, 1))[0];
  await onceBytes(socket, length + 2); return { socket, rest: Buffer.alloc(0) };
}

function onceBytes(socket: DuplexSocket, size: number, timeout = 15000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new Error('代理握手超时')); }, timeout);
    const cleanup = () => { clearTimeout(timer); socket.off('data', data); socket.off('error', error); socket.off('close', closed); };
    const error = (e: Error) => { cleanup(); reject(e); }, closed = () => error(new Error('代理连接已关闭'));
    const data = (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); if (buffer.length >= size) { socket.pause(); cleanup(); if (buffer.length > size) socket.unshift(buffer.subarray(size)); resolve(buffer.subarray(0, size)); } };
    socket.on('data', data); socket.once('error', error); socket.once('close', closed); socket.resume();
  });
}

async function connectTarget(config: AdminEgressConfig, secret: RelaySecret, host: string, port: number) {
  if (config.upstreamMode === 'http') return connectHttpProxy(config, secret, host, port);
  if (config.upstreamMode === 'socks5') return connectSocks5(config, secret, host, port);
  return { socket: await connectSocket(host, port), rest: Buffer.alloc(0) };
}

export class EgressRelay extends EventEmitter {
  private server?: tls.Server;
  private connections = new Set<DuplexSocket>();
  private events: EgressConnectionEvent[] = [];
  private error?: string;
  constructor(private config: AdminEgressConfig, private secret: RelaySecret, private certificate: RelayOptions) { super(); }
  update(config: AdminEgressConfig, secret: RelaySecret) { this.config = config; this.secret = secret; }
  snapshot() { return { running: !!this.server?.listening, activeConnections: this.connections.size, lastError: this.error, events: structuredClone(this.events.slice(0, 100)), fingerprint: this.certificate.fingerprint }; }
  private changed() { this.emit('changed'); }
  private record(event: EgressConnectionEvent) { this.events.unshift(event); this.events = this.events.slice(0, 100); this.changed(); }
  async start() {
    await this.stop(); if (!this.config.enabled) { this.changed(); return; }
    const server = tls.createServer({ pfx: this.certificate.pfx, passphrase: this.certificate.passphrase, minVersion: 'TLSv1.2' }, socket => void this.accept(socket));
    server.on('error', error => { this.error = safeDetail(error); this.changed(); }); this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.config.listenPort, this.config.listenHost, () => { server.off('error', reject); this.error = undefined; resolve(); }); });
    this.changed();
  }
  async restart(config: AdminEgressConfig, secret: RelaySecret) { this.update(config, secret); await this.start(); }
  async stop() {
    for (const socket of this.connections) socket.destroy(); this.connections.clear();
    const server = this.server; this.server = undefined; if (server) await new Promise<void>(resolve => server.close(() => resolve())); this.changed();
  }
  async probe(provider: 'codex' | 'cursor') {
    if (!this.config.enabled || !this.server?.listening) throw new Error('网络出口尚未启动');
    if (!this.config[provider]) throw new Error(provider === 'codex' ? 'Codex 出口未启用' : 'Cursor 出口未启用');
    const result = await connectTarget(this.config, this.secret, provider === 'codex' ? 'chatgpt.com' : 'api2.cursor.sh', 443); result.socket.destroy();
    return true;
  }
  private async accept(socket: tls.TLSSocket) {
    this.connections.add(socket); this.changed(); socket.setKeepAlive(true, 15000); socket.setTimeout(30 * 60 * 1000, () => socket.destroy());
    const id = randomUUID(), base = { id, at: new Date().toISOString(), username: '', provider: 'control' as const, target: '', bytesUp: 0, bytesDown: 0 };
    let event: EgressConnectionEvent = { ...base, status: 'error' };
    try {
      const { line, rest } = await readLine(socket); const request = JSON.parse(line);
      if (request?.version !== 1 || typeof request.accessCode !== 'string' || !sameSecret(request.accessCode, this.secret.accessCode)) throw new Error('出口接入码无效');
      event.username = typeof request.username === 'string' ? request.username.slice(0, 64) : '';
      if (request.kind === 'ping') { socket.end(JSON.stringify({ ok: true }) + '\n'); event = { ...event, status: 'closed' }; return; }
      const host = typeof request.host === 'string' ? request.host.toLowerCase().replace(/\.$/, '') : '', port = Number(request.port), provider = providerForHost(host);
      event.target = `${host}:${port}`; event.provider = provider || 'control';
      if (!provider || !this.config[provider] || port !== 443) throw new Error('目标不在 Codex/Cursor 出口白名单内');
      const target = await connectTarget(this.config, this.secret, host, port); event.status = 'connected'; this.record(event);
      socket.write(JSON.stringify({ ok: true }) + '\n'); if (target.rest.length) socket.write(target.rest); if (rest.length) target.socket.write(rest);
      socket.on('data', chunk => { event.bytesUp += chunk.length; }); target.socket.on('data', chunk => { event.bytesDown += chunk.length; });
      socket.pipe(target.socket).pipe(socket);
      await new Promise<void>((resolve, reject) => { target.socket.once('close', resolve); target.socket.once('error', reject); socket.once('error', reject); });
      event.status = 'closed';
    } catch (error) {
      event.status = event.status === 'connected' ? 'error' : 'rejected'; event.detail = error instanceof SyntaxError ? '握手格式无效' : error instanceof Error ? error.message.slice(0, 160) : '连接失败';
      if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: event.detail }) + '\n');
    } finally {
      this.connections.delete(socket); if (!this.events.some(item => item.id === id)) this.record(event); else { const prior = this.events.find(item => item.id === id); if (prior) Object.assign(prior, event); this.changed(); }
      if (!socket.destroyed) socket.destroy();
    }
  }
}

export class EgressClientProxy extends EventEmitter {
  private revision = 0;
  private probeId = 0;
  private server?: http.Server;
  private connections = new Set<Duplex>();
  private localPort = 0;
  private statusValue: UserEgressStatus = { enabled: false, configured: false, running: false, detail: '使用本机网络直连', hasAccessCode: false };
  constructor(private config?: ClientOptions) { super(); this.refreshStatus(); }
  status() { return structuredClone(this.statusValue); }
  environment(): NodeJS.ProcessEnv {
    if (!this.config?.enabled || !this.localPort) return {};
    const proxy = `http://127.0.0.1:${this.localPort}`, noProxy = ['localhost', '127.0.0.1', '::1', process.env.NO_PROXY || process.env.no_proxy || ''].filter(Boolean).join(',');
    return { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: noProxy, no_proxy: noProxy, NODE_USE_ENV_PROXY: '1' };
  }
  async configure(config?: ClientOptions) {
    this.revision++; this.config = config; this.refreshStatus({ available: undefined, checkedAt: undefined });
    if (config?.enabled) await this.start(); else await this.stop(); this.refreshStatus();
  }
  private refreshStatus(patch: Partial<UserEgressStatus> = {}) {
    const enabled = !!this.config?.enabled, configured = !!(this.config?.host && this.config.port && this.config.certificateFingerprint && this.config.accessCode);
    const available = Object.hasOwn(patch, 'available') ? patch.available : this.statusValue.available;
    this.statusValue = { enabled, configured, running: !!this.server?.listening, available, checkedAt: this.statusValue.checkedAt, endpoint: configured ? `${this.config!.host}:${this.config!.port}` : undefined, detail: enabled ? (this.server?.listening ? available ? '管理端网络出口可用' : '已配置管理端网络出口，等待连接检测' : '管理端网络出口未启动') : '使用本机网络直连', hasAccessCode: !!this.config?.accessCode, ...patch };
    this.emit('changed');
  }
  async start() {
    if (this.server?.listening) return;
    const server = http.createServer((_request, response) => { response.writeHead(405); response.end(); });
    server.on('connect', (request, client, head) => void this.connectRequest(request, client, head));
    server.on('error', error => this.refreshStatus({ available: false, checkedAt: new Date().toISOString(), detail: safeDetail(error) })); this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); this.localPort = (server.address() as net.AddressInfo).port; resolve(); }); });
    this.refreshStatus();
  }
  async stop() {
    this.revision++;
    const server = this.server; this.server = undefined; this.localPort = 0;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (server) await new Promise<void>(resolve => server.close(() => resolve())); this.refreshStatus({ available: undefined, checkedAt: undefined });
  }
  async probe() {
    if (!this.config?.enabled) { this.refreshStatus(); return true; }
    const revision = this.revision, probe = ++this.probeId;
    try {
      const socket = await this.connectRelay({ kind: 'ping' }); socket.end();
      if (revision !== this.revision || probe !== this.probeId) throw new Error('出口配置或检测已改变，请查看最新状态');
      this.refreshStatus({ available: true, checkedAt: new Date().toISOString(), detail: '管理端网络出口可用' }); return true;
    } catch (error) {
      if (revision === this.revision && probe === this.probeId) this.refreshStatus({ available: false, checkedAt: new Date().toISOString(), detail: safeDetail(error) });
      throw error;
    }
  }
  private track<T extends Duplex>(socket: T): T {
    if (!this.connections.has(socket)) {
      this.connections.add(socket);
      // Keep a listener for the complete lifetime, including gaps between handshake and piping.
      socket.on('error', () => socket.destroy());
      socket.once('close', () => this.connections.delete(socket));
    }
    return socket;
  }
  private connectRelay(request: Record<string, unknown>, signal?: AbortSignal): Promise<tls.TLSSocket> {
    const config = this.config; if (!config?.enabled || !config.accessCode) return Promise.reject(new Error('管理端网络出口尚未配置'));
    if (signal?.aborted) return Promise.reject(new Error('连接已取消'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = this.track(tls.connect({ host: config.host, port: config.port, rejectUnauthorized: false, servername: undefined }));
      const cancel = () => finish(new Error('连接已取消'));
      const finish = (error?: Error, value?: tls.TLSSocket) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); error ? (socket.destroy(), reject(error)) : resolve(value!); };
      const timer = setTimeout(() => finish(new Error('连接管理端超时')), 15000);
      signal?.addEventListener('abort', cancel, { once: true });
      socket.once('close', () => finish(new Error('管理端连接已关闭')));
      socket.once('error', error => finish(new Error(safeDetail(error))));
      socket.once('secureConnect', async () => {
        const certificate = socket.getPeerCertificate();
        if (!certificate?.fingerprint256 || cleanFingerprint(certificate.fingerprint256) !== cleanFingerprint(config.certificateFingerprint)) return finish(new Error('管理端出口身份不匹配，请重新粘贴接入码'));
        socket.write(JSON.stringify({ version: 1, accessCode: config.accessCode, username: config.username, ...request }) + '\n');
        try {
          const response = await readLine(socket); const result = JSON.parse(response.line); if (!result?.ok) return finish(new Error(typeof result?.error === 'string' ? result.error : '管理端拒绝连接'));
          if (response.rest.length) socket.unshift(response.rest); finish(undefined, socket);
        } catch (error: any) { finish(error); }
      });
    });
  }
  private async connectRequest(request: http.IncomingMessage, client: Duplex, head: Buffer) {
    const controller = new AbortController();
    let relay: tls.TLSSocket | undefined, closed = false, established = false;
    const cleanup = () => {
      if (closed) return;
      closed = true; controller.abort(); client.destroy(); relay?.destroy();
    };
    const failed = (error: Error) => {
      if (!closed) this.refreshStatus({ available: false, checkedAt: new Date().toISOString(), detail: safeDetail(error) });
      cleanup();
    };
    this.track(client);
    client.once('error', failed); client.once('close', cleanup);
    try {
      const value = request.url || ''; const split = value.lastIndexOf(':'); if (split <= 0) throw new Error('目标地址无效');
      const host = value.slice(0, split).replace(/^\[|\]$/g, ''), port = Number(value.slice(split + 1));
      relay = this.track(await this.connectRelay({ kind: 'connect', host, port }, controller.signal));
      if (closed || client.destroyed) { relay.destroy(); return; }
      relay.once('error', failed); relay.once('close', cleanup);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); established = true;
      if (head.length) relay.write(head); client.pipe(relay).pipe(client);
      this.refreshStatus({ available: true, checkedAt: new Date().toISOString(), detail: '管理端网络出口可用' });
    } catch (error) {
      if (closed || client.destroyed) { cleanup(); return; }
      this.refreshStatus({ available: false, checkedAt: new Date().toISOString(), detail: error instanceof Error ? error.message : '管理端网络出口不可用' });
      if (established) cleanup();
      else client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n', cleanup);
    }
  }
}
