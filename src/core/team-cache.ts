import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson } from './store';
import { accountIdentity } from '../shared/account-data';
import { teamAccessKey, teamAccessRevoked, teamCacheRequestSchema, type TeamCacheEntry, type TeamCacheRequest } from '../shared/team-cache';
import type { ConnectionProfile, Settings, WorkspaceAccess } from '../shared/types';

type Host = { store: { root: string; settings: Settings }; remote: { connected?: boolean; profile?: ConnectionProfile; workspaces: WorkspaceAccess[] } };
const writes = new Map<string, Promise<unknown>>();
const sequences = new Map<string, number>();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function location(host: Host, request: TeamCacheRequest, previousGroup?: string, validate = true) {
  const profile = host.remote.connected ? host.remote.profile : host.store.settings.workspaceSnapshot?.profile;
  if (!profile) return;
  const workspaces = host.remote.connected ? host.remote.workspaces : host.store.settings.workspaceSnapshot?.workspaces || [];
  const projectGroup = 'projectId' in request ? profile.projects.find(project => project.id === request.projectId)?.groupName || previousGroup : undefined;
  if (validate && 'projectId' in request && !profile.projects.some(project => project.id === request.projectId) && !workspaces.some(group => group.groupName === projectGroup && group.accessError)) return;
  if (validate && 'group' in request && !profile.projects.some(project => project.groupName === request.group) && !workspaces.some(group => group.groupName === request.group)) return;
  const owner = accountIdentity(profile), key = JSON.stringify(request);
  const permissionGroup = 'group' in request ? request.group : projectGroup;
  const permission = ['group.details', 'group.directory', 'assignment.list', 'assignment.members'].includes(request.action) ? JSON.stringify([permissionGroup, workspaces.find(group => group.groupName === permissionGroup)?.role]) : undefined;
  return { owner, key, group: projectGroup, permission, access: teamAccessKey(profile, workspaces), file: path.join(host.store.root, 'team-cache', hash(owner), hash(key) + '.json') };
}
async function serial(file: string, work: () => Promise<unknown>) {
  const next = (writes.get(file) || Promise.resolve()).catch(() => {}).then(work); writes.set(file, next);
  try { await next; } finally { if (writes.get(file) === next) writes.delete(file); }
}
export async function readTeamCache<T>(host: Host, raw: unknown): Promise<TeamCacheEntry<T> | undefined> {
  const request = teamCacheRequestSchema.parse(raw), target = location(host, request, undefined, false); if (!target) return;
  try {
    const entry = JSON.parse(await fs.readFile(target.file, 'utf8'));
    const current = location(host, request, entry.group);
    if (current?.file === target.file && entry.owner === target.owner && entry.key === target.key && entry.permission === current.permission && (request.action !== 'directions.list' || entry.access === current.access) && typeof entry.savedAt === 'string' && Object.hasOwn(entry, 'value')) return { value: entry.value, savedAt: entry.savedAt };
  } catch { /* A missing or damaged cache must never block a fresh remote read. */ }
}
export async function refreshTeamCache<T>(host: Host, raw: unknown, load: () => Promise<T>): Promise<T> {
  const request = teamCacheRequestSchema.parse(raw), target = location(host, request);
  const sequence = target ? (sequences.get(target.file) || 0) + 1 : 0;
  if (target) sequences.set(target.file, sequence);
  try {
    const value = await load();
    if (target && location(host, request)?.file === target.file) await serial(target.file, async () => {
      if (sequences.get(target.file) === sequence && location(host, request)?.file === target.file) await atomicJson(target.file, { ...target, file: undefined, savedAt: new Date().toISOString(), value });
    }).catch(() => {}); // Fresh data is still usable if the local disk cannot cache it.
    return value;
  } catch (error) {
    if (target && teamAccessRevoked(error)) await serial(target.file, async () => {
      if (sequences.get(target.file) === sequence) await fs.rm(target.file, { force: true });
    }).catch(() => {});
    throw error;
  }
}

// Run after a successful authoritative manifest refresh, never on a transport failure.
export async function pruneTeamCache(host: Host) {
  const profile = host.remote.profile; if (!profile) return;
  const owner = accountIdentity(profile), folder = path.join(host.store.root, 'team-cache', hash(owner));
  for (const name of await fs.readdir(folder).catch(() => [] as string[])) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = path.join(folder, name);
    await serial(file, async () => {
      try {
        const entry = JSON.parse(await fs.readFile(file, 'utf8')), request = teamCacheRequestSchema.parse(JSON.parse(entry.key));
        if (!host.remote.profile || accountIdentity(host.remote.profile) !== owner) return;
        const current = location(host, request, entry.group);
        if (current && current.owner !== owner) return;
        if (!current || entry.permission !== current.permission || request.action === 'directions.list' && entry.access !== current.access) { sequences.set(file, (sequences.get(file) || 0) + 1); await fs.rm(file, { force: true }); }
      } catch { /* Ignore incomplete/legacy caches; normal reads also ignore them. */ }
    });
  }
}
