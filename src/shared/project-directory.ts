import { projectSetupIdentity } from './project-brief';
import type { AgentSession, ConnectionProfile, Settings } from './types';

export function canFollowProjectDirectory(session: AgentSession) {
  return !session.codexRemote && !session.cursorNative && (!session.fork || session.fork.workspaceKind === 'shared-directory');
}
export function followsProjectDirectory(session: AgentSession) {
  if (!canFollowProjectDirectory(session)) return false;
  // Existing records without a choice must not move files during an upgrade.
  return session.directoryMode === 'project';
}

export const projectDirectoryKey = (profile: ConnectionProfile, projectId: string) => projectSetupIdentity(profile, projectId);

// An empty value records the user's choice to work without a code directory.
export function projectDirectory(settings: Settings, profile: ConnectionProfile, projectId: string): string | undefined {
  return settings.projectDirectories?.[projectDirectoryKey(profile, projectId)];
}

export function migrateProjectDirectories(settings: Settings) {
  const profile = settings.workspaceSnapshot?.profile, directories = settings.projectDirectories;
  if (!profile || !directories) return;
  for (const project of profile.projects) {
    const legacy = profile.id + ':' + project.id, key = projectDirectoryKey(profile, project.id);
    if (!Object.hasOwn(directories, legacy)) continue;
    directories[key] ??= directories[legacy];
    delete directories[legacy];
  }
}
