import type { ConnectionProfile, Project } from './types';
import { PERSONAL_PROJECT_ID } from './personal-workspace';
import { connectionProject } from './project-connection';

export function workspaceSelection(personal: boolean, projectId: string | undefined, localProjects: Project[], profile?: ConnectionProfile) {
  if (personal) {
    const selected = projectId || PERSONAL_PROJECT_ID;
    if (selected !== PERSONAL_PROJECT_ID && !localProjects.some(project => project.id === selected)) throw new Error('本机项目已不存在，请重新选择项目');
    return selected;
  }
  if (projectId && !profile) throw new Error('当前账号的项目列表尚未就绪，请重新选择项目');
  return profile ? connectionProject(profile, projectId) : undefined;
}

// A stale selection is only a navigation preference, never permission to open
// another account's project. Keep legacy windows without a selection unchanged.
export function restoredWorkspaceSelection(projectId: string | undefined, localProjects: Project[], teamProjects: Project[]) {
  if (!projectId) return undefined;
  return projectId === PERSONAL_PROJECT_ID || [...localProjects, ...teamProjects].some(project => project.id === projectId) ? projectId : PERSONAL_PROJECT_ID;
}
