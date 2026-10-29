import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

export async function guardRequest(target: URL, headers: http.OutgoingHttpHeaders, body: Buffer, env: NodeJS.ProcessEnv, signal: AbortSignal, method = 'POST'): Promise<http.IncomingMessage> {
  const proxy = guardProxy(target, env);
  const proxyAuth = proxy?.username ? 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') : undefined;
  let tunnel: Duplex | undefined;
  let agent: https.Agent | undefined;
  if (proxy && target.protocol === 'https:') {
    tunnel = await new Promise<Duplex>((resolve, reject) => {
      const authority = target.host.includes(':') ? target.host : target.host + ':443';
      const connect = (proxy.protocol === 'https:' ? https : http).request(proxy, { method: 'CONNECT', path: authority, agent: false, signal, rejectUnauthorized: true,
        headers: { host: authority, ...(proxyAuth ? { 'proxy-authorization': proxyAuth } : {}) } });
      connect.setTimeout(15000, () => connect.destroy(new Error('代理连接超时')));
      connect.on('error', () => reject(new Error('请求保护连接代理失败，未改为直连')));
      connect.once('connect', (res, socket, head) => {
        if (res.statusCode !== 200) { socket.destroy(); reject(new Error('请求保护的代理连接被拒绝，未改为直连')); return; }
        socket.setTimeout(0); if (head.length) socket.unshift(head); resolve(socket);
      });
      connect.end();
    });
    agent = new https.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => {
      const secure = tls.connect({ socket: tunnel as any, servername: target.hostname, rejectUnauthorized: true });
      const abort = () => secure.destroy(new Error('请求已取消'));
      signal.addEventListener('abort', abort, { once: true });
      secure.once('close', () => signal.removeEventListener('abort', abort));
      const failed = (error: Error) => callback?.(error, secure);
      secure.once('error', failed);
      secure.setTimeout(15000, () => secure.destroy(new Error('代理 TLS 握手超时')));
      secure.once('secureConnect', () => { secure.setTimeout(0); secure.off('error', failed); callback?.(null, secure); });
      if (signal.aborted) abort();
      return undefined as any;
    };
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) { tunnel?.destroy(); agent?.destroy(); reject(new Error('请求已取消')); return; }
    const viaHttp = proxy && target.protocol === 'http:';
    const destination = viaHttp ? proxy! : target;
    const transport = destination.protocol === 'https:' ? https : http;
    const request = transport.request(destination, { method, signal, agent: agent || false, rejectUnauthorized: true,
      path: viaHttp ? target.href : target.pathname + target.search,
      headers: { ...headers, host: target.host, 'content-length': body.length, ...(viaHttp && proxyAuth ? { 'proxy-authorization': proxyAuth } : {}) },
    }, response => {
      response.once('close', () => { agent?.destroy(); tunnel?.destroy(); }); resolve(response);
    });
    request.setTimeout(120000, () => request.destroy(new Error('请求保护等待上游超时')));
    request.once('error', () => { tunnel?.destroy(); agent?.destroy(); reject(new Error('请求保护访问模型服务失败，未切换网络通路')); });
    request.end(body);
  });
}
