import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { GuardNetworkError, guardNetworkError, guardTrustedCertificates } from './codex-guard-trust';

/** Node does not inherit the Windows proxy that the native Codex HTTP client uses. */
export async function guardNetworkEnvironment(overrides: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env, ...overrides };
  if (process.platform !== 'win32' || ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'].some(key => env[key])) return env;
  let settings: any;
  try {
    const result = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer,ProxyOverride,AutoConfigURL | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 5000 });
    settings = JSON.parse(result.stdout);
  } catch { throw new Error('请求保护无法确认 Windows 代理设置，未改为直连'); }
  return guardWindowsProxy(env, settings);
}

export function guardWindowsProxy(env: NodeJS.ProcessEnv, settings: { ProxyEnable?: number; ProxyServer?: string; ProxyOverride?: string; AutoConfigURL?: string }) {
  if (settings.AutoConfigURL) throw new Error('请求保护暂不支持自动代理脚本，请使用明确的 HTTP 代理；未改为直连');
  if (!settings.ProxyEnable) return env;
  const address = settings.ProxyServer || '';
  const mapping = Object.fromEntries(address.split(';').filter(item => item.includes('=')).map(item => item.split('=', 2)));
  const prefix = (value: string) => /^[a-z]+:\/\//i.test(value) ? value : 'http://' + value;
  if (!address) throw new Error('请求保护无法确认 Windows 代理地址，未改为直连');
  const httpProxy = mapping.http || (!address.includes('=') ? address : '');
  const httpsProxy = mapping.https || (!address.includes('=') ? address : '');
  if (mapping.socks && (!httpProxy || !httpsProxy)) throw new Error('请求保护暂不支持此系统代理类型，未改为直连');
  const noProxy = [env.no_proxy || env.NO_PROXY, settings.ProxyOverride?.replaceAll(';', ',')].filter(Boolean).join(',');
  return { ...env, HTTP_PROXY: httpProxy ? prefix(httpProxy) : '', http_proxy: httpProxy ? prefix(httpProxy) : '',
    HTTPS_PROXY: httpsProxy ? prefix(httpsProxy) : '', https_proxy: httpsProxy ? prefix(httpsProxy) : '', NO_PROXY: noProxy, no_proxy: noProxy };
}

// No fetch redirects, global proxy mutation, or direct fallback after proxy failure.
export function guardProxy(target: URL, env: NodeJS.ProcessEnv) {
  const excluded = (env.no_proxy || env.NO_PROXY || '').split(',').some(entry => {
    const value = entry.trim().toLowerCase();
    if (!value) return false;
    if (value === '*') return true;
    if (value === '<local>') return !target.hostname.includes('.') && !target.hostname.includes(':');
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(value);
    if (!match) return false;
    const [, rawHost, port] = match, host = rawHost.replace(/^\*?\./, '');
    const pattern = new RegExp('^' + host.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return (!port || port === (target.port || (target.protocol === 'https:' ? '443' : '80')))
      && (pattern.test(target.hostname) || !host.includes('*') && target.hostname.endsWith('.' + host));
  });
  if (excluded) return;
  const value = target.protocol === 'https:' ? env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY : env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY;
  if (!value) return;
  let proxy: URL;
  try { proxy = new URL(value); } catch { throw new Error('请求保护无法读取现有代理地址，未改为直连'); }
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('请求保护暂不支持此代理类型，请配置 HTTP 代理；未改为直连');
  return proxy;
}

export function guardHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = { ...headers };
  const connection = String(headers.connection || '').split(',').map(v => v.trim().toLowerCase());
  for (const key of [...connection, 'host', 'connection', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'content-length', 'expect', 'upgrade', 'keep-alive', 'te', 'trailer']) delete result[key];
  return result;
}

async function guardTunnel(target: URL, proxy: URL, ca: string[], signal: AbortSignal, timeout: number): Promise<Duplex> {
  const proxyAuth = proxy?.username ? 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') : undefined;
  return new Promise<Duplex>((resolve, reject) => {
    const authority = target.hostname + ':' + (target.port || '443');
    const connect = (proxy.protocol === 'https:' ? https : http).request(proxy, { method: 'CONNECT', path: authority, agent: false, signal, ca, rejectUnauthorized: true,
      headers: { host: authority, ...(proxyAuth ? { 'proxy-authorization': proxyAuth } : {}) } });
    const timer = setTimeout(() => connect.destroy(new GuardNetworkError('proxy_connect', 'ETIMEDOUT', true)), timeout);
    connect.once('error', error => { clearTimeout(timer); reject(guardNetworkError(error, 'proxy_connect', true)); });
    connect.once('connect', (res, socket, head) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) { socket.destroy(); reject(new GuardNetworkError('proxy_connect', res.statusCode === 403 ? 'PROXY_403' : res.statusCode === 407 ? 'PROXY_407' : 'PROXY_REJECTED', true)); return; }
      socket.setTimeout(0); if (head.length) socket.unshift(head); resolve(socket);
    });
    connect.end();
  });
}

async function guardTls(target: URL, proxy: URL | undefined, ca: string[], signal: AbortSignal, timeout: number) {
  const tunnel = proxy ? await guardTunnel(target, proxy, ca, signal, timeout) : undefined;
  if (signal.aborted) { tunnel?.destroy(); throw new GuardNetworkError('target_tls', 'ABORT_ERR', !!proxy); }
  const host = target.hostname.replace(/^\[|\]$/g, '');
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const secure = tls.connect({ ...(tunnel ? { socket: tunnel as any } : { host, port: Number(target.port || 443) }),
      servername: isIP(host) ? undefined : host, ca, rejectUnauthorized: true, checkServerIdentity: (_name, cert) => tls.checkServerIdentity(host, cert) });
    const abort = () => secure.destroy(new GuardNetworkError('target_tls', 'ABORT_ERR', !!proxy));
    const timer = setTimeout(() => secure.destroy(new GuardNetworkError('target_tls', 'ETIMEDOUT', !!proxy)), timeout);
    signal.addEventListener('abort', abort, { once: true });
    secure.once('close', () => { clearTimeout(timer); signal.removeEventListener('abort', abort); tunnel?.destroy(); });
    secure.once('error', error => { clearTimeout(timer); reject(guardNetworkError(error, 'target_tls', !!proxy)); });
    secure.once('secureConnect', () => { clearTimeout(timer); resolve(secure); });
    if (signal.aborted) abort();
  });
}

/** TLS handshake only: no model request, authentication token or project content. */
export async function guardProbe(target: URL, env: NodeJS.ProcessEnv, certificateFile = '', signal = AbortSignal.timeout(30000)) {
  if (target.protocol !== 'https:') throw new Error('当前模型地址未使用 HTTPS，无需检测 TLS 证书');
  const proxy = guardProxy(target, env), ca = await guardTrustedCertificates(env, certificateFile);
  const socket = await guardTls(target, proxy, ca, signal, 15000); socket.destroy();
  return { viaProxy: !!proxy };
}

// No redirects, global trust/proxy changes, or fallback after proxy failure.
export async function guardRequest(target: URL, headers: http.OutgoingHttpHeaders, body: Buffer, env: NodeJS.ProcessEnv, signal: AbortSignal, method = 'POST', certificateFile = '', timeout = 15000, responseTimeout = 120000): Promise<http.IncomingMessage> {
  const proxy = guardProxy(target, env);
  const ca = target.protocol === 'https:' || proxy?.protocol === 'https:' ? await guardTrustedCertificates(env, certificateFile) : undefined;
  const proxyAuth = proxy?.username ? 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') : undefined;
  let secure: tls.TLSSocket | undefined;
  let agent: https.Agent | undefined;
  if (target.protocol === 'https:') {
    secure = await guardTls(target, proxy, ca!, signal, timeout);
    agent = new https.Agent({ keepAlive: false });
    agent.createConnection = () => secure!;
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) { secure?.destroy(); agent?.destroy(); reject(new GuardNetworkError('upstream', 'ABORT_ERR', !!proxy)); return; }
    const viaHttp = proxy && target.protocol === 'http:';
    const destination = viaHttp ? proxy! : target;
    const transport = destination.protocol === 'https:' ? https : http;
    const request = transport.request(destination, { method, signal, agent: agent || false, ca, rejectUnauthorized: true,
      path: viaHttp ? target.href : target.pathname + target.search,
      headers: { ...headers, host: target.host, 'content-length': body.length, ...(viaHttp && proxyAuth ? { 'proxy-authorization': proxyAuth } : {}) },
    }, response => {
      if (viaHttp && (response.statusCode === 403 || response.statusCode === 407)) {
        response.destroy(); reject(new GuardNetworkError('proxy_connect', response.statusCode === 403 ? 'PROXY_403' : 'PROXY_407', true)); return;
      }
      response.once('close', () => { agent?.destroy(); secure?.destroy(); }); resolve(response);
    });
    request.setTimeout(responseTimeout, () => request.destroy(new GuardNetworkError('upstream', 'ETIMEDOUT', !!proxy)));
    request.once('error', error => { secure?.destroy(); agent?.destroy(); reject(guardNetworkError(error, 'upstream', !!proxy)); });
    request.end(body);
  });
}
