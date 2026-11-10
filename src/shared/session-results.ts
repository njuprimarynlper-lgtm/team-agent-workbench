import { z } from 'zod';
import { resultReferenceSchema, type ResultReference } from './content';
import type { AgentSession, SourceFile } from './types';
import type { ResultDirectory } from './result-directories';

export interface ResultLinkedAttachment { name: string; sha256: string; size: number; sourcePath: string }
export interface SessionResultLink { reference: ResultReference; attachments: ResultLinkedAttachment[] }
export interface SessionResultCandidate {
  reference: ResultReference; title: string; content: string; author: string; updatedAt: string;
  category?: string; folderId?: string; attachments: { name: string; sha256: string; size: number }[];
  linkedVersion?: number; needsLinkUpgrade?: boolean; unavailable?: string;
}
export interface SessionResultCandidates { items: SessionResultCandidate[]; directories: ResultDirectory[]; available: boolean; cached: boolean; warning?: string }
export interface AttachResultsResponse { added: { reference: ResultReference; source: SourceFile }[]; failed: { reference: ResultReference; error: string }[] }
export const attachResultsSchema = z.object({ id: z.string().uuid(), references: z.array(resultReferenceSchema).min(1).max(100) });
export const resultReferenceKey = (ref: ResultReference) => JSON.stringify([ref.scope, ref.projectId, ref.id]);
export const resultVersionKey = (ref: ResultReference) => JSON.stringify([ref.scope, ref.projectId, ref.id, ref.version]);

export function sourceResultReference(session: AgentSession, source: SourceFile): ResultReference | undefined {
  if (source.resultLink) return source.resultLink.reference;
  if (source.contentRef) return { scope: 'team', projectId: source.contentRef.projectId, id: source.contentRef.id, version: source.contentRef.revision };
  const match = source.sourcePath?.match(/^local-conclusion:(.+):v(\d+)$/);
  if (match && session.binding) return { scope: 'personal', projectId: session.binding.project.id, id: match[1], version: Number(match[2]) };
}
export function currentResultSource(session: AgentSession, ref: ResultReference) {
  return [...session.sources].reverse().find(source => !source.supersededBy && !source.resultUnavailable && sourceResultReference(session, source) && resultReferenceKey(sourceResultReference(session, source)!) === resultReferenceKey(ref));
}
export const supportsSessionResults = (session: AgentSession) => !session.closedAt && session.purpose === 'work' && !session.cursorNative && !session.codexRemote;
