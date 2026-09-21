import type { ContentMetadata, ContributionCategory, GitRevision } from './content';
import type { ProjectBrief } from './project-brief';
import type { UserEgressSettings, UserEgressStatus } from './egress';
export type Provider = 'codex' | 'cursor';
export type PermissionMode = 'inherit' | 'review' | 'auto' | 'full';
export interface PermissionReport { provider: Provider; checkedAt: string; source: 'config' | 'runtime'; sandbox: string; approval: string; reviewer?: string; warnings: string[]; allowedModes?: PermissionMode[]; execution?: 'passed' | 'blocked' | 'unknown'; executionDetail?: string; cursorConfig?: { files: string[]; allow: string[]; deny: string[] }; }
export interface PermissionIssue { kind: 'sandbox' | 'policy' | 'filesystem'; message: string; at: string; }
export interface Project { briefRevision?: number; id: string; name: string; remoteRoot: string; uploadPath: string; historyPath: string; managed?: boolean; groupName?: string; groupLabel?: string }
export interface ConnectionProfile { mode?: 'sftp' | 'local'; localRoot?: string; id: string; name: string; host: string; port: number; username: string; fingerprint: string; manifestPath: string; projects: Project[]; workPath?: string }
export interface WorkspaceSnapshot { profile: ConnectionProfile; workspaces: WorkspaceAccess[] }
export interface ProjectBriefState { brief?: ProjectBrief; revision: number; updatedAt?: string }
export interface ContentSeenState { revision: number; title?: string; path?: string; author?: string; updatedBy?: string; updatedAt?: string; kind?: 'contribution' | 'file' | 'trajectory'; category?: ContributionCategory; sourceSessionTitle?: string; sources?: string[] }
export interface Settings { egress?: UserEgressSettings; workspaceSnapshot?: WorkspaceSnapshot; projectDirectories?: Record<string, string>; autoUploadMinutes?: number; sidebarProjectHeight?: number; trustedServerIdentities?: Record<string, string>; contentSeen?: Record<string, Record<string, number | ContentSeenState>>; contentUpdates?: ContentUpdate[]; dismissedContentUpdateIds?: string[]; contentAliases?: Record<string, string>; connections: ConnectionProfile[]; providerPaths: Record<Provider, string>; lastWorkspace: string; localWorkspace?: string; verifiedLocalWorkspace?: string }
export type AgentCapabilityKind = 'skill' | 'plugin';
export interface AgentCapabilitySelection { id: string; kind: AgentCapabilityKind; name: string }
export interface AgentCapabilityOption extends AgentCapabilitySelection { description: string; invocation: string; path?: string; source?: string; enabled: boolean; unavailableReason?: string }
export interface AgentCapabilityCatalog { provider: Provider; skills: AgentCapabilityOption[]; plugins: AgentCapabilityOption[]; checkedAt: string; skillError?: string; pluginError?: string }
export interface SessionInput { text: string; sourceIds: string[]; answers: Record<string, string>; capabilities?: AgentCapabilitySelection[] }
export interface WorkspaceAccess { path: string; canonicalPath: string; canCreateProject: boolean; groupName?: string; groupLabel?: string; accessError?: string; isEmpty?: boolean }
export interface RemoteEntry { name: string; path: string; kind: 'directory' | 'file' | 'link'; size: number; modified: number }
export interface FilePreview { name: string; path: string; type: 'text' | 'image' | 'binary'; content: string; truncated: boolean; size: number }
export interface SourceFile { id: string; name: string; localPath: string; sourcePath: string; sha256: string; size: number; fetchedAt: string; contentRef?: { projectId: string; id: string; revision: number } }
export interface SessionFile { path: string; name: string; size: number; modifiedAt: string }
export interface MessageContext { nativeId: string; accepted: boolean; workRecord: boolean; sourceHashes: Record<string, string>; capabilities?: AgentCapabilitySelection[] }
export interface Message { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string; userText?: string; context?: MessageContext; createdAt: string }
export interface ApprovalOption { id: string; label: string; kind: 'allow' | 'deny' | 'answer' }
export interface Approval { id: string; method: string; title: string; summary?: string; details: string; options: ApprovalOption[]; questions?: { id: string; text: string; options: string[] }[] }
export interface RemoteBinding { connectionId: string; host: string; port: number; username: string; fingerprint: string; project: Project }
export interface AgentSession {
  id: string; title: string; provider: Provider; model?: string; closedAt?: string; nativeId?: string; nativePath?: string; codexStorage?: 'workbench';
  cwd: string; purpose: 'work' | 'prepare'; parentId?: string; createdAt: string;
  status: 'idle' | 'starting' | 'running' | 'approval' | 'error'; error?: string;
  messages: Message[]; approvals: Approval[]; sources: SourceFile[]; binding?: RemoteBinding;
  permissionMode?: PermissionMode; permissions?: PermissionReport; permissionIssue?: PermissionIssue;
  projectBrief?: { revision: number; sourceId: string; capturedAt: string }; lastTrajectoryHash?: string; lastTrajectoryQueuedAt?: string;
  assignment?: { id: string; revision: number; title: string; sourceIds: string[] };
  outputFiles?: string[];
  autoUpload: boolean; lastArchiveAt?: string; handoffPath: string;
}
export interface Transfer { metadata?: ContentMetadata; trajectoryHash?: string; cacheCleared?: boolean; sha256?: string; completedAt?: string; id: string; kind: 'upload' | 'history' | 'download'; name: string; status: 'queued' | 'running' | 'done' | 'error'; bytes: number; total: number; target: string; projectName: string; createdAt: string; error?: string; sessionId?: string; localPath: string; binding: RemoteBinding }
export interface DraftDestination { id: string; path: string; description: string }
export interface DraftArtifact { id: string; category: ContributionCategory; title: string; titleAlias?: string; fields: Record<string, string>; body: string; repoUrl?: string; target: string; selected: boolean; submitted?: string }
export type PreparationScope = 'full' | 'incremental';
export interface PreparationSnapshot { capturedAt: string; messageCount: number; totalMessageCount?: number; lastMessageId?: string; conversationHash: string; scope?: PreparationScope; baseDraftId?: string; baseLastMessageId?: string; baseCapturedAt?: string }
export interface ContentMergeSource { id: string; revision: number; title: string; author: string; updatedAt: string }
export interface ContentMergeAnalysis { overview: string; consensus: string[]; conflicts: { topic: string; positions: { sourceIds: string[]; statement: string }[]; resolution?: string; requiresDecision: boolean }[]; evidence: { claim: string; sourceIds: string[] }[]; scope?: string; unresolved: string[] }
export interface ContentUpdateAction { kind: 'saved_conclusion' | 'attached_session' | 'kept_conclusion' | 'deleted_conclusion' | 'acknowledged' | 'archived'; at: string; targetId?: string; targetTitle?: string; sourceRevision?: number }
export interface ContentUpdate { eventId: string; projectId: string; projectName: string; id: string; path?: string; title: string; author?: string; updatedBy?: string; revision: number; category?: ContributionCategory; sourceSessionTitle?: string; change: 'new' | 'updated' | 'deleted' | 'merged'; sourceTitles?: string[]; occurredAt: string; detectedAt: string; readAt?: string; actions?: ContentUpdateAction[]; archiveReason?: 'own_change'; unavailableAt?: string }
export interface ConclusionSource { id: string; kind: 'remote' | 'session' | 'manual' | 'conclusion'; title: string; content?: string; revision?: number; path?: string; updatedAt: string }
export interface ProjectConclusion { id: string; projectId: string; title: string; titleAlias?: string; content: string; sources: ConclusionSource[]; updatedAt: string; version: number; archived?: boolean; deletedAt?: string; automatic?: boolean }
export interface ConclusionMatch { conclusion: ProjectConclusion; score: number; reasons: string[] }
export interface ConclusionOrganization { conclusion: ProjectConclusion; action: 'created' | 'grouped' | 'updated' | 'duplicate' }
export interface Draft { git?: GitRevision; includeGit?: boolean; snapshot?: PreparationSnapshot; preparationScope?: PreparationScope; baseDraftId?: string; id: string; sessionId: string; prepareSessionId?: string; generation?: 'running' | 'ready' | 'error' | 'canceled'; generationError?: string; generationStartedAt?: string; generationFinishedAt?: string; generationStage?: 'directories' | 'agent'; preparationVersion?: number; requestedCategories?: ContributionCategory[]; supplement?: string; repoUrlOverride?: string; destinations?: DraftDestination[]; destinationNote?: string; artifacts?: DraftArtifact[]; mergeProjectId?: string; conclusionMergeProjectId?: string; conclusionMergeInstruction?: string; mergeSources?: ContentMergeSource[]; mergeAnalysis?: ContentMergeAnalysis; mergeCompletedAt?: string; mergeResultId?: string; mergeResultPath?: string; title: string; titleAlias?: string; body: string; repoUrl?: string; target?: string; generatedBody?: string; files: SourceFile[]; binding?: RemoteBinding; inputDir: string; outputPath: string; createdAt: string; submitted?: string }
export interface ProviderInfo { provider: Provider; path: string; available: boolean; version: string; detail: string }
export interface ProviderAuth { status: 'unknown' | 'checking' | 'authenticated' | 'configured' | 'unauthenticated' | 'error' | 'not-required' | 'logging-in'; detail: string; identity?: string; plan?: string; cwd?: string; checkedAt?: string; loginUrl?: string }
export interface ModelOption { id: string; name: string; isDefault?: boolean }
export interface QuotaWindow { name: string; usedPercent: number; windowMinutes?: number; resetsAt?: number }
export interface ProviderCatalog { models: ModelOption[]; modelError?: string; quota: { windows: QuotaWindow[]; detail: string; url: string }; checkedAt: string }
export interface Snapshot { settings: Settings; sessions: AgentSession[]; inputs: Record<string, SessionInput>; transfers: Transfer[]; drafts: Draft[]; connection?: { profile: ConnectionProfile; connected: boolean; workspace?: WorkspaceAccess; workspaces: WorkspaceAccess[] }; providers: ProviderInfo[]; auth: Record<Provider, ProviderAuth>; workspaceReady: boolean; egress?: UserEgressStatus }
export type WorkbenchEvent = { type: 'state' } | { type: 'notice'; message: string };
export interface WorkbenchAPI {
  call<T = unknown>(action: string, payload?: unknown): Promise<T>;
  subscribe(listener: (event: WorkbenchEvent) => void): () => void;
}
declare global { interface Window { workbench: WorkbenchAPI } }
