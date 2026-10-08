import type { AgentCapabilityCatalog, AgentCapabilityKind, Provider } from '../shared/types';
import { emptyCapabilityCatalog } from './provider-capabilities';

/** A runtime owns this cache, so different accounts, directories and routes never share it. */
export class CapabilityCache {
  private cached = new Map<AgentCapabilityKind, { value: AgentCapabilityCatalog; expires: number }>();
  private pending = new Map<AgentCapabilityKind, Promise<AgentCapabilityCatalog>>();
  constructor(private provider: Provider, private ttl = 60000) {}
  invalidate(kind?: AgentCapabilityKind) {
    if (kind) { this.cached.delete(kind); this.pending.delete(kind); }
    else { this.cached.clear(); this.pending.clear(); }
  }
  private read(kind: AgentCapabilityKind, force: boolean, load: (kind: AgentCapabilityKind) => Promise<AgentCapabilityCatalog>) {
    const pending = this.pending.get(kind); if (pending) return pending.then(value => structuredClone(value));
    const cached = this.cached.get(kind);
    if (!force && cached && cached.expires > Date.now()) return Promise.resolve(structuredClone(cached.value));
    const job = Promise.resolve().then(() => load(kind)).then(value => {
      if (this.pending.get(kind) === job) this.cached.set(kind, { value: structuredClone(value), expires: Date.now() + (value[kind === 'skill' ? 'skillError' : 'pluginError'] ? 1000 : this.ttl) });
      return value;
    }).finally(() => { if (this.pending.get(kind) === job) this.pending.delete(kind); });
    this.pending.set(kind, job); return job.then(value => structuredClone(value));
  }
  async get(force: boolean, kind: AgentCapabilityKind | undefined, load: (kind: AgentCapabilityKind) => Promise<AgentCapabilityCatalog>) {
    if (kind) return this.read(kind, force, load);
    const [skills, plugins] = await Promise.all([this.read('skill', force, load), this.read('plugin', force, load)]);
    return { ...emptyCapabilityCatalog(this.provider), skills: skills.skills, plugins: plugins.plugins, skillError: skills.skillError, pluginError: plugins.pluginError };
  }
}
