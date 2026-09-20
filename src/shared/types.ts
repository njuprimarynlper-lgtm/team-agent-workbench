import type { ContentMetadata, ContributionCategory, GitRevision } from './content';
import type { ProjectBrief } from './project-brief';
export type Provider = 'codex' | 'cursor';
export type PermissionMode = 'inherit' | 'review' | 'auto' | 'full';
export interface PermissionReport { provider: Provider; checkedAt: string; source: 'config' | 'runtime'; sandbox: string; approval: string; reviewer?: string; warnings: string[]; allowedModes?: PermissionMode[]; execution?: 'passed' | 'blocked' | 'unknown'; executionDetail?: string; cursorConfig?: { files: string[]; allow: string[]; deny: string[] }; }
export interface PermissionIssue { kind: 'sandbox' | 'policy' | 'filesystem'; message: string; at: string; }
export interface Project { briefRevision?: number; id: string; name: string; remoteRoot: string; uploadPath: string; historyPath: string; managed?: boolean; groupName?: string; groupLabel?: string }
export interface ConnectionProfile { mode?: 'sftp' | 'local'; localRoot?: string; id: string; name: string; host: string; port: number; username: string; fingerprint: string; manifestPath: string; projects: Project[]; workPath?: string }
export interface WorkspaceSnapshot { profile: ConnectionProfile; workspaces: WorkspaceAccess[] }
export interface ProjectBriefState { brief?: ProjectBrief; revision: number; updatedAt?: string }
export interface Settings { workspaceSnapshot?: WorkspaceSnapshot; projectDirectories?: Record<string, string>; autoUploadMinutes?: number; sidebarProjectHeight?: number; trustedServerIdentities?: Record<string, string>; contentSeen?: Record<string, Record<string, number>>; connections: ConnectionProfile[]; providerPaths: Record<Provider, string>; lastWorkspace: string; localWorkspace?: string; verifiedLocalWorkspace?: string }
export interface SessionInput { text: string; sourceIds: string[]; answers: Record<string, string> }
export interface WorkspaceAccess { path: string; canonicalPath: string; canCreateProject: boolean; groupName?: string; groupLabel?: string; accessError?: string; isEmpty?: boolean }
export interface RemoteEntry { name: string; path: string; kind: 'directory' | 'file' | 'link'; size: number; modified: number }
export interface FilePreview { name: string; path: string; type: 'text' | 'image' | 'binary'; content: string; truncated: boolean; size: number }
export interface SourceFile { id: string; name: string; localPath: string; sourcePath: string; sha256: string; size: number; fetchedAt: string }
export interface MessageContext { nativeId: string; accepted: boolean; workRecord: boolean; sourceHashes: Record<string, string> }
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
  autoUpload: boolean; lastArchiveAt?: string; handoffPath: string;
}
export interface Transfer { metadata?: ContentMetadata; trajectoryHash?: string; cacheCleared?: boolean; sha256?: string; completedAt?: string; id: string; kind: 'upload' | 'history' | 'download'; name: string; status: 'queued' | 'running' | 'done' | 'error'; bytes: number; total: number; target: string; projectName: string; createdAt: string; error?: string; sessionId?: string; localPath: string; binding: RemoteBinding }
export interface DraftDestination { id: string; path: string; description: string }
export interface DraftArtifact { id: string; category: ContributionCategory; title: string; fields: Record<string, string>; body: string; repoUrl?: string; target: string; selected: boolean; submitted?: string }
export interface ContentMergeSource { id: string; revision: number; title: string; author: string; updatedAt: string }
export interface ContentMergeAnalysis { overview: string; consensus: string[]; conflicts: { topic: string; positions: { sourceIds: string[]; statement: string }[]; resolution?: string; requiresDecision: boolean }[]; evidence: { claim: string; sourceIds: string[] }[]; scope?: string; unresolved: string[] }
export interface ContentUpdate { projectId: string; projectName: string; id: string; path: string; title: string; author: string; updatedBy: string; revision: number; change: 'new' | 'updated' }
export interface Draft { git?: GitRevision; includeGit?: boolean; snapshot?: { capturedAt: string; messageCount: number; lastMessageId?: string; conversationHash: string }; id: string; sessionId: string; prepareSessionId?: string; generation?: 'running' | 'ready' | 'error' | 'canceled'; generationError?: string; generationStartedAt?: string; generationFinishedAt?: string; generationStage?: 'directories' | 'agent'; preparationVersion?: number; supplement?: string; repoUrlOverride?: string; destinations?: DraftDestination[]; destinationNote?: string; artifacts?: DraftArtifact[]; mergeProjectId?: string; mergeSources?: ContentMergeSource[]; mergeAnalysis?: ContentMergeAnalysis; mergeCompletedAt?: string; mergeResultId?: string; mergeResultPath?: string; title: string; body: string; repoUrl?: string; target?: string; generatedBody?: string; files: SourceFile[]; binding?: RemoteBinding; inputDir: string; outputPath: string; createdAt: string; submitted?: string }
export interface ProviderInfo { provider: Provider; path: string; available: boolean; version: string; detail: string }
export interface ProviderAuth { status: 'unknown' | 'checking' | 'authenticated' | 'configured' | 'unauthenticated' | 'error' | 'not-required' | 'logging-in'; detail: string; identity?: string; plan?: string; cwd?: string; checkedAt?: string; loginUrl?: string }
export interface ModelOption { id: string; name: string; isDefault?: boolean }
export interface QuotaWindow { name: string; usedPercent: number; windowMinutes?: number; resetsAt?: number }
export interface ProviderCatalog { models: ModelOption[]; modelError?: string; quota: { windows: QuotaWindow[]; detail: string; url: string }; checkedAt: string }
export interface Snapshot { settings: Settings; sessions: AgentSession[]; inputs: Record<string, SessionInput>; transfers: Transfer[]; drafts: Draft[]; connection?: { profile: ConnectionProfile; connected: boolean; workspace?: WorkspaceAccess; workspaces: WorkspaceAccess[] }; providers: ProviderInfo[]; auth: Record<Provider, ProviderAuth>; workspaceReady: boolean }
export type WorkbenchEvent = { type: 'state' } | { type: 'notice'; message: string };
export interface WorkbenchAPI {
  call<T = unknown>(action: string, payload?: unknown): Promise<T>;
  subscribe(listener: (event: WorkbenchEvent) => void): () => void;
}
declare global { interface Window { workbench: WorkbenchAPI } }
