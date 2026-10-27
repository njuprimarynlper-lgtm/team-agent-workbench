import React from 'react';
import { SquareKanban, Settings } from 'lucide-react';
import type { WorkbenchAPI } from '../shared/types';
import { RsiRecommendationToggle } from './rsi-recommendation-toggle';
import { PERSONAL_PROJECT_ID, type PersonalGroup } from '../shared/personal-workspace';
import { groupRoleLabels, type GroupRole } from '../shared/team-groups';

export function LocalWorkspaceNote({ project, groupId, groups, openResults }: { project?: { id: string; name: string }; groupId: string; groups: PersonalGroup[]; openResults: () => void }) {
  const title = project && project.id !== PERSONAL_PROJECT_ID ? project.name : groupId === '*' ? '全部本机会话' : groups.find(group => group.id === groupId)?.name || '未分组';
  return <div className="personal-side-note"><b>{title}</b>会话和整理成果保存在本机。<button className="text-button" onClick={openResults}>查看个人成果库</button></div>;
}

export function SidebarProjectItem({ project, selected, select, settings, call, recommendations, pending, conflict, connection, role, count = 0 }: {
  project: { id: string; name: string }; selected: boolean;
  select: () => void; settings: () => void; call: WorkbenchAPI['call'];
  connection?: React.ReactNode; recommendations?: () => void; pending?: number; conflict?: boolean; role?: GroupRole;
  count?: number;
}) {
  const detailsId = 'project-controls-' + project.id;
  return <div className={'workgroup-project-item' + (selected ? ' is-selected' : '')}>
    <div className="workgroup-project-row">
      <button className={'workgroup-project' + (selected ? ' selected' : '')} data-project-id={project.id} aria-pressed={selected} onClick={select}>
        <SquareKanban size={14} aria-hidden="true"/><span title={project.name}>{project.name}</span>
      </button>
      <span className="project-session-count" title="未关闭的工作会话（含子会话）" aria-label={`${count} 个未关闭会话`}>{count}</span>
      {role && role !== 'member' && <span className="badge">{groupRoleLabels[role]}</span>}
      <button className="icon project-settings-action" title={'项目设置：' + project.name} aria-label={'项目设置：' + project.name} onClick={settings}>{conflict ? <span className="inline-error" title="项目资料有分歧，点击处理">●</span> : <Settings size={14}/>}</button>
    </div>
    {selected && <div className="workgroup-project-details" id={detailsId}><div className="workgroup-project-controls">{connection}<RsiRecommendationToggle projectId={project.id} projectName={project.name} call={call} open={recommendations} pending={pending}/></div></div>}
  </div>;
}
