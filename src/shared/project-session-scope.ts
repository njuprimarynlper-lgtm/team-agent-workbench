import type { AgentSession, Project } from './types';
import { isPersonalBinding, PERSONAL_PROJECT_ID } from './personal-workspace';

// Session bindings are historical snapshots. Resolve membership against the
// current project's stable ID rather than the group name saved at import time.
export function inProjectWorkgroup(saved: Project | undefined, selected: Project | undefined, projects: Project[]) {
  if (!saved || !selected) return false;
  if (saved.id === selected.id) return true;
  const current = projects.find(project => project.id === saved.id);
  return !!selected.groupName && !!current && current.groupName === selected.groupName;
}

export function projectWorkSessions(sessions: AgentSession[], project: Project | undefined, projects: Project[], personal: boolean, personalGroup = '*') {
  return sessions.filter(session => session.purpose === 'work' && (personal
    ? isPersonalBinding(session.binding) && session.binding?.project.id === project?.id && (project?.id !== PERSONAL_PROJECT_ID || personalGroup === '*' || (session.personalGroupId || '') === personalGroup)
    : !isPersonalBinding(session.binding) && inProjectWorkgroup(session.binding?.project, project, projects)));
}
