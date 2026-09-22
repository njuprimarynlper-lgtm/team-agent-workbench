import type { AgentSession, Draft, PreparationCheckpoint, PreparationSnapshot } from './types';

// Progress belongs to the source Session, not to a deletable task or its results.
export function preparationCheckpoint(session: AgentSession, drafts: Draft[] = []): PreparationCheckpoint | undefined {
  let checkpoint = session.preparationCheckpoint;
  for (const draft of drafts) {
    if (draft.sessionId !== session.id || draft.generation !== 'ready' || draft.mergeSources?.length || !draft.snapshot || draft.restored) continue;
    const snapshot = draft.snapshot, previous = checkpoint?.snapshot;
    if (!previous || snapshot.capturedAt > previous.capturedAt || snapshot.capturedAt === previous.capturedAt && (snapshot.totalMessageCount ?? snapshot.messageCount) > (previous.totalMessageCount ?? previous.messageCount)) checkpoint = { draftId: draft.id, snapshot };
  }
  return checkpoint;
}

export function rememberPreparationProgress(session: AgentSession, drafts: Draft[]) {
  const checkpoint = preparationCheckpoint(session, drafts);
  if (checkpoint) session.preparationCheckpoint = structuredClone(checkpoint);
}

export function preparationDelta(session: Pick<AgentSession, 'messages'>, snapshot?: PreparationSnapshot) {
  if (!snapshot) return { start: 0, count: 0, reason: '没有已完成的整理进度，请先全量整理。' };
  if (!snapshot.lastMessageId) {
    if ((snapshot.totalMessageCount ?? snapshot.messageCount) === 0) return { start: 0, count: session.messages.length, reason: session.messages.length ? '' : '上次整理后没有新增消息。' };
    return { start: 0, count: 0, reason: '上次整理缺少可定位的消息快照，请改用全量整理。' };
  }
  const index = session.messages.findIndex(message => message.id === snapshot.lastMessageId);
  if (index < 0) return { start: 0, count: 0, reason: '无法在当前会话中定位上次整理位置，请改用全量整理。' };
  // A streamed reply can grow without getting a new message ID. Include that
  // boundary message again instead of dropping its remainder. Legacy snapshots
  // lack a length, so replay the boundary conservatively once.
  const changed = snapshot.lastMessageLength === undefined || session.messages[index].text.length !== snapshot.lastMessageLength;
  const start = index + (changed ? 0 : 1), count = session.messages.length - start;
  return { start, count, reason: count ? '' : '上次整理后没有新增消息。' };
}
