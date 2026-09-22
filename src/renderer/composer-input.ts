import type { SessionInput, WorkbenchAPI } from '../shared/types';

// The acknowledgement belongs to the original session and the exact submitted draft.
export async function submitComposerInput(api: WorkbenchAPI, id: string, sent: SessionInput, expectedTurnId: string | undefined,
  latest: () => SessionInput, clear: (id: string) => void) {
  const accepted = await api.call(expectedTurnId ? 'session.steer' : 'session.send', { id, expectedTurnId, text: sent.text, sourceIds: sent.sourceIds, capabilities: sent.capabilities || [] });
  const current = latest();
  if (accepted && current.text === sent.text && JSON.stringify(current.sourceIds) === JSON.stringify(sent.sourceIds) && JSON.stringify(current.capabilities || []) === JSON.stringify(sent.capabilities || [])) clear(id);
  return accepted;
}
