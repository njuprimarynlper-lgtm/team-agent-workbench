import type { SessionInput, WorkbenchAPI } from '../shared/types';

// Clear the submitted draft immediately. A failure restores it only if the
// user has not edited this session's newly empty composer in the meantime.
export async function submitOptimisticInput(api: WorkbenchAPI, id: string, sent: SessionInput,
  latest: () => SessionInput, write: (input: SessionInput) => void, enqueue = false) {
  const snapshot = structuredClone(sent);
  const current = latest();
  const same = current.text === sent.text && JSON.stringify(current.sourceIds) === JSON.stringify(sent.sourceIds) && JSON.stringify(current.capabilities || []) === JSON.stringify(sent.capabilities || []);
  if (same) write({ ...sent, text: '', sourceIds: [], capabilities: [], nextTurnOnly: false });
  const cleared = same ? latest() : undefined;
  const restore = () => { if (cleared && latest() === cleared) write(snapshot); };
  try {
    const accepted = await api.call(enqueue ? 'session.enqueue' : 'session.send', { id, text: snapshot.text, sourceIds: snapshot.sourceIds, capabilities: snapshot.capabilities || [] });
    if (!accepted) restore();
    return accepted;
  } catch (error) { restore(); throw error; }
}
