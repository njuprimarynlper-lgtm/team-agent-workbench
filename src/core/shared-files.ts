import type { ContentEdit, ContentMetadata } from '../shared/content';
import { SftpConnection } from './sftp';
import { LocalFileConnection } from './local-files';
import type { ConnectionProfile, RemoteBinding } from '../shared/types';
import type { ProjectBrief } from '../shared/project-brief';

export class SharedFiles {
  private backend: SftpConnection | LocalFileConnection;
  constructor(private changed: () => void) { this.backend = new SftpConnection(changed); }
  get profile() { return this.backend.profile; }
  get workspaces() { return this.backend.workspaces; }
  get workspace() { return this.backend.workspace; }
  get connected() { return this.backend.connected; }
  async connect(profile: ConnectionProfile, password: string, trust: (s: string) => Promise<boolean>) {
    this.disconnect(); this.backend = profile.mode === 'local' ? new LocalFileConnection(this.changed) : new SftpConnection(this.changed);
    return this.backend.connect(profile, password, trust);
  }
  disconnect() { this.backend.disconnect(); }
  channel(binding?: RemoteBinding) { return this.backend.channel(binding); }
  binding(id: string) { return this.backend.binding(id); }
  verifyWorkspace(target: string) { return this.backend.verifyWorkspace(target); }
  loadManifest() { return this.backend.loadManifest(); }
  createProject(name: string, groupName?: string, brief?: ProjectBrief) { return this.backend.createProject(name, groupName, brief); }
  contentList(binding: RemoteBinding) { return this.backend.contentList(binding); }
  contentAdopt(binding: RemoteBinding, target: string) { return this.backend.contentAdopt(binding, target); }
  contentEdit(binding: RemoteBinding, change: ContentEdit) { return this.backend.contentEdit(binding, change); }
  contentReplace(binding: RemoteBinding, change: ContentEdit, file: string) { return this.backend.contentReplace(binding, change, file); }
  projectBrief(binding: RemoteBinding) { return this.backend.projectBrief(binding); }
  saveProjectBrief(binding: RemoteBinding, brief: ProjectBrief, revision: number) { return this.backend.saveProjectBrief(binding, brief, revision); }
  ensurePersonalFolder(binding: RemoteBinding, target: string) { return this.backend.ensurePersonalFolder(binding, target); }
  list(binding: RemoteBinding, target: string) { return this.backend.list(binding, target); }
  preview(binding: RemoteBinding, target: string) { return this.backend.preview(binding, target); }
  download(binding: RemoteBinding, target: string, local: string, progress?: (bytes: number, total: number) => void) { return this.backend.download(binding, target, local, progress); }
  upload(binding: RemoteBinding, local: string, target: string, progress: (bytes: number, total: number) => void, metadata?: ContentMetadata, hash?: string) { return this.backend.upload(binding, local, target, progress, metadata, hash); }
}
