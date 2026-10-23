import type { AgentSession, MessageContext } from '../shared/types';
import { isConclusionSource } from '../shared/conclusion-context';
import { acceptedSessionContext, uniqueSources } from '../shared/session-context';
import { managedHandoffNotice, recoverSessionContext, sourceHeader, sourceText, workRecordInstructions } from '../shared/session-context-text';
export { workRecordInstructions } from '../shared/session-context-text';

export function migrateSessionContext(s: AgentSession) {
  let hasResponse = false;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.role === 'assistant' || m.role === 'tool') { hasResponse = true; continue; }
    if (m.role !== 'user') continue;
    const legacy = recoverSessionContext(s, m.text);
    // The raw prompt is retained in text for trajectory export.
    if (legacy.userText !== m.text && m.userText === undefined) m.userText = legacy.userText;
    if (!m.context && s.nativeId && (legacy.workRecord || legacy.sources.length)) m.context = {
      nativeId: s.nativeId, accepted: hasResponse, workRecord: legacy.workRecord,
      sourceHashes: Object.fromEntries(legacy.sources.map(f => [f.id, f.sha256])),
    };
  }
}

export function sessionContext(s: AgentSession, userText: string, sourceIds: string[], journal?: import('../shared/project-journal').JournalContext) {
  const { sourceHashes: known, workRecord: hasWorkRecord } = acceptedSessionContext(s);
  // Remote native forks already own the inherited history. Only their generated
  // visible-delta snapshot is sent inline; local attachment paths stay local.
  const remoteFork = s.codexRemote && s.fork?.nativeFork && s.fork.remoteContext ? s.fork : undefined;
  const nativeSources = new Set(remoteFork ? [remoteFork.sourceId, ...remoteFork.inheritedSourceIds] : []);
  const selected = [...new Set([...sourceIds, ...(s.projectBrief ? [s.projectBrief.sourceId] : []), ...(s.assignment?.sourceIds || []), ...(s.fork ? [s.fork.sourceId, ...s.fork.inheritedSourceIds] : []), ...s.sources.filter(isConclusionSource).map(source => source.id)])].filter(id => !nativeSources.has(id)).map(id => {
    const source = s.sources.find(f => f.id === id);
    if (!source) throw new Error('引用不属于当前会话');
    return source;
  });
  const directoryChanged = s.directoryChange && !s.messages.some(m => m.context?.accepted && m.context.nativeId === s.nativeId && m.context.directoryRevision === s.directoryChange!.id);
  const sources = uniqueSources(selected).filter(f => directoryChanged || known[f.id] !== f.sha256);
  const managed = s.messages.some(m => m.context?.accepted && m.context.nativeId === s.nativeId && m.text.includes(managedHandoffNotice));
  const workRecord = s.purpose === 'work' && !s.cursorNative && (!hasWorkRecord || !managed || !!directoryChanged);
  const remoteContext = remoteFork && known[remoteFork.sourceId] !== remoteFork.snapshotHash ? remoteFork.remoteContext : undefined;
  const directoryNotice = directoryChanged ? '\n\n[工作目录变更]\n' + JSON.stringify({ previousDirectory: s.directoryChange!.from, workingDirectory: s.cwd, retainedCopies: s.directoryChange!.conflicts }) + '\n以上路径是工作台目录配置数据。后续新建、下载及相对路径均使用当前工作目录；旧路径仅供追溯，勿继续写入旧目录。若有保留副本，先核对其中的项目文件。' : '';
  const text = userText + (workRecord ? workRecordInstructions(s) : '') + directoryNotice + (remoteContext ? '\n\n' + remoteContext : '') + (sources.length ? sourceHeader + sources.map(sourceText).join('\n\n') : '') + (journal?.text || '');
  const context: Omit<MessageContext, 'nativeId' | 'accepted'> = { ...(s.directoryChange ? { directoryRevision: s.directoryChange.id } : {}), workRecord, sourceHashes: { ...Object.fromEntries(sources.map(f => [f.id, f.sha256])), ...(remoteContext ? { [remoteFork!.sourceId]: remoteFork!.snapshotHash } : {}) }, ...(journal ? { projectJournal: journal.receipt } : {}) };
  return { text, sources, context };
}
