import { teamAccessRevoked, type TeamCacheEntry, type TeamCacheRequest } from '../shared/team-cache';

type Api = { call: <T = any>(action: string, payload?: any) => Promise<T> };
export async function cachedTeamRead<T>(api: Api, request: TeamCacheRequest, apply: (value: T | undefined, cached: boolean) => void, fresh?: () => Promise<T>) {
  const cached = await api.call<TeamCacheEntry<T> | undefined>('team.cache.read', request).catch(() => undefined);
  if (cached) apply(cached.value, true);
  const { action, ...payload } = request;
  try {
    const value = await (fresh ? fresh() : api.call<T>(action, payload)); apply(value, false); return value;
  } catch (error) {
    if (teamAccessRevoked(error)) apply(undefined, false);
    throw error;
  }
}
