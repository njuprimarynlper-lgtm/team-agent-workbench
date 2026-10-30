import type { Provider, ProviderAuth, ProviderCatalog, SessionNetworkRoute } from '../shared/types';
import type { UserEgressStatus } from '../shared/egress';

export interface ProviderConnectionCheck { auth: ProviderAuth; catalog?: ProviderCatalog; issues: string[] }
type Call = <T = unknown>(action: string, payload?: unknown) => Promise<T>;
type ConnectionConfiguration = { enabled: boolean; viaSharedServer?: boolean; inviteCode?: string };

// Saving a route is independent of online login/model discovery. In particular,
// a broken old route must not prevent choosing a working replacement. Sending a
// turn still performs its normal auth/connection preflight on the chosen route.
export async function applySessionConnection(call: Call, id: string, networkRoute: SessionNetworkRoute, configuration?: ConnectionConfiguration, isCurrent = () => true) {
  const current = () => { if (!isCurrent()) throw new Error('检测范围已改变，请查看当前会话的最新状态'); };
  current();
  if (configuration) await call('egress.configure', configuration);
  current();
  await call('session.network', { id, networkRoute });
  current();
}

export async function checkProviderConnection(call: Call, provider: Provider, cwd: string, configuration?: ConnectionConfiguration, isCurrent = () => true, networkRoute?: SessionNetworkRoute): Promise<ProviderConnectionCheck> {
  const current = () => { if (!isCurrent()) throw new Error('检测范围已改变，请查看当前会话的最新状态'); };
  // A rejected configuration must not be reported as a successful switch.
  if (configuration) await call('egress.configure', configuration);
  current();
  const issues: string[] = [];
  let reachable = true;
  try { const network = await call<UserEgressStatus>('egress.test', { provider, ...(networkRoute ? { networkRoute } : {}) }); reachable = !network.enabled || network.available === true; if (!reachable) issues.push('网络出口检测失败：' + network.detail); }
  catch (error: any) { reachable = false; issues.push('网络出口检测失败：' + error.message); }
  current();
  await call('providers.detect');
  current();
  let auth = await call<ProviderAuth>('provider.auth', { provider, cwd, ...(networkRoute ? { networkRoute } : {}) });
  if (!reachable && provider === 'cursor') auth = { ...auth, connectionIssue: issues[0] };
  current();
  let catalog: ProviderCatalog | undefined;
  if (reachable && !auth.connectionIssue && ['authenticated', 'configured', 'not-required'].includes(auth.status)) {
    try { catalog = await call<ProviderCatalog>('provider.catalog', { provider, cwd, ...(networkRoute ? { networkRoute } : {}) }); if (catalog.modelError) issues.push('模型读取失败：' + catalog.modelError); }
    catch (error: any) { issues.push('模型与额度读取失败：' + error.message); }
  }
  current();
  return { auth, catalog, issues };
}
