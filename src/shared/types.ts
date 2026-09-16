export type Provider = 'codex' | 'cursor';
export interface Project { id: string; name: string; remoteRoot: string; uploadPath: string; historyPath: string; managed?: boolean }
export interface ConnectionProfile { mode?: 'sftp' | 'local'; localRoot?: string; id: string; name: string; host: string; port: number; username: string; fingerprint: string; manifestPath: string; projects: Project[]; workPath?: string }
export interface Settings { connections: ConnectionProfile[]; providerPaths: Record<Provider, string>; lastWorkspace: string; localWorkspace?: string; verifiedLocalWorkspace?: string }
export interface SessionInput { text: string; sourceIds: string[]; answers: Record<string, string> }
export interface WorkspaceAccess { path: string; canonicalPath: string; canCreateProject: boolean; groupName?: string }
export interface RemoteEntry { name: string; path: string; kind: 'directory' | 'file' | 'link'; size: number; modified: number }
export interface FilePreview { name: string; path: string; type: 'text' | 'image' | 'binary'; content: string; truncated: boolean; size: number }
export interface SourceFile { id: string; name: string; localPath: string; sourcePath: string; sha256: string; size: number; fetchedAt: string }
export interface Message { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string; createdAt: string }
export interface ApprovalOption { id: string; label: string; kind: 'allow' | 'deny' | 'answer' }
export interface Approval { id: string; method: string; title: string; details: string; options: ApprovalOption[]; questions?: { id: string; text: string; options: string[] }[] }
export interface RemoteBinding { connectionId: string; host: string; port: number; username: string; fingerprint: string; project: Project }
export interface AgentSession {
  id: string; title: string; provider: Provider; nativeId?: string; nativePath?: string;
  cwd: string; purpose: 'work' | 'prepare'; parentId?: string; createdAt: string;
  status: 'idle' | 'starting' | 'running' | 'approval' | 'error'; error?: string;
  messages: Message[]; approvals: Approval[]; sources: SourceFile[]; binding?: RemoteBinding;
  autoUpload: boolean; lastArchiveAt?: string; handoffPath: string;
}
export interface Transfer { id: string; kind: 'upload' | 'history' | 'download'; name: string; status: 'queued' | 'running' | 'done' | 'error'; bytes: number; total: number; target: string; projectName: string; createdAt: string; error?: string; sessionId?: string; localPath: string; binding: RemoteBinding }
export interface Draft { id: string; sessionId: string; prepareSessionId?: string; title: string; body: string; repoUrl?: string; target?: string; generatedBody?: string; files: SourceFile[]; binding?: RemoteBinding; inputDir: string; outputPath: string; createdAt: string; submitted?: string }
export interface ProviderInfo { provider: Provider; path: string; available: boolean; version: string; detail: string }
export interface ProviderAuth { status: 'unknown' | 'checking' | 'authenticated' | 'configured' | 'unauthenticated' | 'error' | 'not-required' | 'logging-in'; detail: string; cwd?: string; checkedAt?: string; loginUrl?: string }
export interface Snapshot { settings: Settings; sessions: AgentSession[]; inputs: Record<string, SessionInput>; transfers: Transfer[]; drafts: Draft[]; connection?: { profile: ConnectionProfile; connected: boolean; workspace?: WorkspaceAccess }; providers: ProviderInfo[]; auth: Record<Provider, ProviderAuth>; workspaceReady: boolean }
export type WorkbenchEvent = { type: 'state' } | { type: 'notice'; message: string };
export interface WorkbenchAPI {
  call<T = unknown>(action: string, payload?: unknown): Promise<T>;
  subscribe(listener: (event: WorkbenchEvent) => void): () => void;
}
declare global { interface Window { workbench: WorkbenchAPI } }
