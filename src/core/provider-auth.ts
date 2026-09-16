import type { Provider, ProviderAuth } from '../shared/types';
import { JsonRpc, spawnCLI, stopCLI } from './rpc';
import { resolveProvider } from './providers';

export const authReady = (auth: ProviderAuth) => ['authenticated', 'configured', 'not-required'].includes(auth.status);
const state = (status: ProviderAuth['status'], detail: string): ProviderAuth => ({ status, detail });
// Network diagnostics take precedence: some CLIs describe a failed network request as invalid auth.
export function authFailure(error: unknown): ProviderAuth {
  const message = error instanceof Error ? error.message : String(error);
  if (/network|fetch failed|econn|enotfound|eai_again|dns|socket|proxy|certificate|tls|timed? ?out|timeout|超时|网络/i.test(message))
    return state('error', '无法完成登录检测，请检查网络、代理或证书后重试；这不表示账号未登录。');
  if (/not (?:logged|signed) in|not authenticated|unauthenticated|unauthorized|\b401\b|please (?:log|sign) in|authentication required|refresh_token_(?:expired|reused|invalidated)|token (?:has )?expired|invalid (?:access |refresh )?token|未登录|登录已过期/i.test(message))
    return state('unauthenticated', '尚未登录或登录已过期，请登录个人账号后重新检测。');
  return state('error', '无法确认登录状态，请检查 CLI 路径、版本和配置后重试。');
}
export function codexAuth(result: any): ProviderAuth {
  if (!result || typeof result.requiresOpenaiAuth !== 'boolean') return state('error', 'CLI 返回了无法识别的认证状态，请检查版本后重试。');
  if (result.account?.type) return state(result.account.type === 'chatgpt' ? 'authenticated' : 'configured', result.account.type === 'chatgpt' ? '已检测到个人 ChatGPT 登录；实际服务可用性以任务结果为准。' : '已检测到 CLI 配置的认证凭据；实际服务可用性以任务结果为准。');
  if (!result.requiresOpenaiAuth) return state('not-required', '当前 CLI 服务配置不要求 OpenAI 登录，将沿用该配置。');
  return state('unauthenticated', '尚未登录 Codex，请先登录个人账号。');
}
export function cursorAuth(output: string, code: number | null, environmentCredential = false): ProviderAuth {
  let result: any;
  try { result = JSON.parse(output); } catch { return state('error', '无法读取 Cursor 登录状态，请使用支持 status --format json 的 Cursor Agent CLI。'); }
  if (code !== 0 || result.status === 'error') return authFailure(result.message || 'Status check failed');
  if (result.status === 'authenticated' && result.isAuthenticated === true)
    return state('authenticated', /unable to fetch/i.test(result.message || '') ? 'CLI 已保存登录凭据，但当前无法读取在线账号信息；可检查网络后重新检测。' : '已检测到个人 Cursor 登录；实际服务可用性以任务结果为准。');
  if (['unauthenticated', 'partially-authenticated'].includes(result.status) && result.isAuthenticated === false) {
    if (environmentCredential) return state('configured', '已配置 Cursor 环境变量凭据，尚未在线验证；实际服务可用性以任务结果为准。');
    return state('unauthenticated', result.status === 'partially-authenticated' ? 'Cursor 登录凭据不完整，请重新登录个人账号。' : '尚未登录 Cursor，请先登录个人账号。');
  }
  return state('error', 'CLI 返回了无法识别的认证状态，请检查版本后重试。');
}

export async function inspectAuth(provider: Provider, executable: string, cwd: string, signal?: AbortSignal, timeout = 20000): Promise<ProviderAuth> {
  if (signal?.aborted) return state('error', '登录检测已取消。');
  if (provider === 'codex') {
    const rpc = new JsonRpc(executable, ['app-server'], cwd, false);
    const abort = () => { void rpc.close(); }; signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
    try {
      await rpc.request('initialize', { clientInfo: { name: 'team_agent_workbench_auth', version: '0.3.0' } }, timeout);
      rpc.notify('initialized');
      return codexAuth(await rpc.request('account/read', { refreshToken: true }, timeout));
    } catch (error) { return authFailure(timedOut ? 'timeout' : error); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await rpc.close(); }
  }
  return new Promise(resolve => {
    const child = spawnCLI(executable, ['status', '--format', 'json'], cwd);
    let output = '', settled = false;
    const finish = (auth: ProviderAuth, stop = false) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (stop) void stopCLI(child).then(() => resolve(auth)); else resolve(auth);
    };
    const abort = () => finish(state('error', '登录检测已取消。'), true);
    const timer = setTimeout(() => finish(authFailure('timeout'), true), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { output += data.toString(); if (output.length > 65536) finish(state('error', 'CLI 状态输出异常，请检查配置。'), true); });
    // Do not surface raw stderr, which may contain tokens or account data.
    child.stderr.resume();
    child.on('error', () => finish(state('error', '无法启动 CLI，请检查程序路径。')));
    child.on('close', code => finish(cursorAuth(output, code, Boolean(process.env.CURSOR_API_KEY || process.env.CURSOR_AUTH_TOKEN))));
  });
}

// Login URLs live only in memory. Never forward raw CLI login output into notices or session archives.
export function loginUrl(provider: Provider, output: string): string | undefined {
  for (const candidate of output.match(/https:\/\/[^\s<>"\x1b]+/g) || []) {
    try {
      const url = new URL(candidate);
      const allowed = provider === 'codex' ? ['auth.openai.com', 'auth0.openai.com'] : ['cursor.com', 'www.cursor.com', 'authenticator.cursor.sh'];
      if (allowed.includes(url.hostname) && !url.username && !url.password) return url.href;
    } catch {}
  }
}

export class ProviderAccounts {
  states: Record<Provider, ProviderAuth> = { codex: state('unknown', '尚未检测登录状态'), cursor: state('unknown', '尚未检测登录状态') };
  private jobs = new Map<Provider, { key: string; controller: AbortController; promise: Promise<ProviderAuth> }>();
  private logins = new Map<Provider, () => void>();
  private stopping = new Set<Promise<void>>();
  private closed = false;
  constructor(private configuredPath: (p: Provider) => string, private changed: () => void, private loggedIn: (p: Provider) => void = () => {}) {}
  private set(provider: Provider, auth: ProviderAuth) { this.states[provider] = auth; if (!this.closed) this.changed(); return auth; }
  async check(provider: Provider, cwd: string): Promise<ProviderAuth> {
    if (this.closed) return state('error', '工作台正在关闭');
    if (this.logins.has(provider)) return this.states[provider];
    const configured = this.configuredPath(provider), key = JSON.stringify([configured, cwd]);
    const previous = this.jobs.get(provider); if (previous?.key === key) return previous.promise;
    previous?.controller.abort();
    const controller = new AbortController();
    this.set(provider, { ...state('checking', '正在检测登录状态…'), cwd });
    const job = { key, controller, promise: Promise.resolve(this.states[provider]) };
    this.jobs.set(provider, job);
    job.promise = (async () => {
      let result: ProviderAuth;
      try { result = await inspectAuth(provider, await resolveProvider(provider, configured), cwd, controller.signal); }
      catch { result = state('error', '无法启动 CLI，请检查程序路径和安装状态。'); }
      if (controller.signal.aborted || this.configuredPath(provider) !== configured) return state('error', 'CLI 配置或工作目录已改变，请重新检测。');
      result = { ...result, cwd, checkedAt: new Date().toISOString() };
      if (this.jobs.get(provider) === job && !this.closed && this.configuredPath(provider) === configured) this.set(provider, result);
      return result;
    })().finally(() => { if (this.jobs.get(provider) === job) this.jobs.delete(provider); });
    return job.promise;
  }
  invalidate(provider: Provider) {
    this.jobs.get(provider)?.controller.abort(); this.jobs.delete(provider);
    this.logins.get(provider)?.();
    this.set(provider, state('unknown', 'CLI 配置已改变，请重新检测登录状态。'));
  }
  failed(provider: Provider, error: unknown, cwd: string) {
    const auth = authFailure(error);
    if (auth.status === 'unauthenticated') { this.jobs.get(provider)?.controller.abort(); this.jobs.delete(provider); this.set(provider, { ...auth, cwd, checkedAt: new Date().toISOString() }); }
  }
  async login(provider: Provider, cwd: string) {
    if (this.closed || this.logins.has(provider)) return;
    this.jobs.get(provider)?.controller.abort(); this.jobs.delete(provider);
    // Reserve synchronously so repeated clicks cannot start competing browser flows.
    let canceled = false;
    const reservation = () => { canceled = true; this.logins.delete(provider); if (!this.closed) this.set(provider, state('unknown', '登录已取消，可重新登录或检测。')); };
    this.logins.set(provider, reservation);
    this.set(provider, { ...state('logging-in', '请在 CLI 打开的浏览器中完成登录；完成后会自动重新检测。'), cwd });
    let executable: string;
    try { executable = await resolveProvider(provider, this.configuredPath(provider)); }
    catch { reservation(); this.set(provider, state('error', '无法启动 CLI，请检查程序路径。')); return; }
    if (canceled || this.closed) return;
    const child = spawnCLI(executable, ['login'], cwd); let output = '', settled = false;
    const finish = (kind: 'exit' | 'cancel' | 'timeout' | 'error', code?: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer); this.logins.delete(provider);
      if (kind !== 'exit') { const stopped = stopCLI(child); this.stopping.add(stopped); void stopped.finally(() => this.stopping.delete(stopped)); }
      if (this.closed) return;
      if (kind === 'exit' && code === 0) { this.loggedIn(provider); void this.check(provider, cwd); }
      else this.set(provider, { ...state(kind === 'cancel' ? 'unknown' : 'error', kind === 'cancel' ? '登录已取消，可重新登录或检测。' : kind === 'timeout' ? '登录等待超时，可重新登录或检测。' : '登录未完成，请检查浏览器授权和网络后重试。'), cwd });
    };
    const timer = setTimeout(() => finish('timeout'), 5 * 60 * 1000);
    this.logins.set(provider, () => finish('cancel'));
    const read = (data: Buffer) => {
      output = (output + data.toString()).slice(-16000);
      const url = loginUrl(provider, output);
      if (url && !settled) this.set(provider, { ...this.states[provider], loginUrl: url });
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', () => finish('error')); child.on('close', code => finish('exit', code));
  }
  cancel(provider: Provider) { this.logins.get(provider)?.(); }
  async close() {
    this.closed = true;
    const jobs = [...this.jobs.values()]; for (const job of jobs) job.controller.abort();
    for (const cancel of this.logins.values()) cancel();
    await Promise.all([...jobs.map(job => job.promise), ...this.stopping]);
  }
}
