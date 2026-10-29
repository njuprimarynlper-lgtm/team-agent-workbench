import { JsonRpc } from './rpc';
import { createCodexRequestGuard } from './codex-request-guard';
import { GuardNetworkError } from './codex-guard-trust';
import { guardNetworkMessage, type GuardConnectionCheck } from '../shared/guard-network';

export async function checkCodexGuardConnection(executable: string, cwd: string, env: NodeJS.ProcessEnv, certificateFile = ''): Promise<GuardConnectionCheck> {
  const rpc = new JsonRpc(executable, ['app-server'], cwd, false, env);
  rpc.on('message', message => { if (message.id !== undefined) rpc.reject(message.id, 'Connection check does not authorize tools'); });
  let route: Awaited<ReturnType<typeof createCodexRequestGuard>> | undefined;
  const timer = setTimeout(() => { void rpc.close(); void route?.guard.close(); }, 40000);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'workbench_guard_connection_check', version: '1' } }); rpc.notify('initialized');
    route = await createCodexRequestGuard(rpc, cwd, env, () => certificateFile);
    const result = await route.guard.probe();
    return { ok: true, ...result, message: '网络连接和证书验证通过。未调用模型。' };
  } catch (error) {
    if (error instanceof GuardNetworkError) return { ok: false, problem: error.problem, message: guardNetworkMessage(error.problem) };
    return { ok: false, message: '无法完成连接检测，请确认 Codex CLI、工作目录和代理配置可用。' };
  } finally { clearTimeout(timer); await route?.guard.close(); await rpc.close(); }
}
