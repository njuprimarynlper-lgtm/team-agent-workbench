import { z } from 'zod';
import type { Provider } from '../shared/types';
import type { Store } from './store';

const patchSchema = z.object({
  codexRequestGuard: z.boolean().optional(),
  codexCaCertificate: z.string().trim().max(32768).optional(),
  providerPaths: z.object({ codex: z.string().optional(), cursor: z.string().optional(), claude: z.string().optional() }).strict().optional(),
}).strict();
const pending = new WeakMap<Store, Promise<unknown>>();

// Local preferences never require CLI discovery, login checks or a connection.
// Serialize partial updates so saving paths cannot overwrite a concurrent toggle.
export async function saveAgentSettings(store: Store, raw: unknown, invalidate: (provider: Provider) => void) {
  const patch = patchSchema.parse(raw);
  const task = (pending.get(store) || Promise.resolve()).catch(() => {}).then(async () => {
    const previous = store.settings;
    const next = { ...previous, providerPaths: { ...previous.providerPaths } };
    if (patch.codexRequestGuard !== undefined) next.codexRequestGuard = patch.codexRequestGuard;
    if (patch.codexCaCertificate !== undefined) next.codexCaCertificate = patch.codexCaCertificate;
    for (const provider of ['codex', 'cursor', 'claude'] as const) if (patch.providerPaths?.[provider] !== undefined) next.providerPaths[provider] = patch.providerPaths[provider];
    store.settings = next;
    try { await store.saveSettings(); }
    catch (error) {
      // Preserve unrelated settings changed while the write was in flight.
      if (store.settings === next) {
        if (patch.codexRequestGuard !== undefined && next.codexRequestGuard === patch.codexRequestGuard) next.codexRequestGuard = previous.codexRequestGuard;
        if (patch.codexCaCertificate !== undefined && next.codexCaCertificate === patch.codexCaCertificate) next.codexCaCertificate = previous.codexCaCertificate;
        for (const provider of ['codex', 'cursor', 'claude'] as const) if (patch.providerPaths?.[provider] !== undefined && next.providerPaths[provider] === patch.providerPaths[provider]) next.providerPaths[provider] = previous.providerPaths[provider];
      }
      throw error;
    }
    for (const provider of ['codex', 'cursor', 'claude'] as const) if (previous.providerPaths[provider] !== next.providerPaths[provider]) invalidate(provider);
    return true;
  });
  pending.set(store, task);
  try { return await task; }
  finally { if (pending.get(store) === task) pending.delete(store); }
}
