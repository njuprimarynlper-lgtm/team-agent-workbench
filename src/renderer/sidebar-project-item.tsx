import React, { useEffect, useState } from 'react';
import { ChevronRight, Settings } from 'lucide-react';
import type { WorkbenchAPI } from '../shared/types';
import { RsiRecommendationToggle } from './rsi-recommendation-toggle';
import { PERSONAL_PROJECT_ID, type PersonalGroup } from '../shared/personal-workspace';

export function LocalProjectsSection({ children }: { children: React.ReactNode }) {
  return <section className="workgroup local-projects" aria-label="本机项目"><div className="workgroup-title"><b>本机项目</b><span className="spacer"/><span className="muted small">未关联工作组</span></div>{children}</section>;
}

export function LocalWorkspaceNote({ project, groupId, groups, openResults }: { project?: { id: string; name: string }; groupId: string; groups: PersonalGroup[]; openResults: () => void }) {
  const title = project && project.id !== PERSONAL_PROJECT_ID ? project.name : groupId === '*' ? '全部本机会话' : groups.find(group => group.id === groupId)?.name || '未分组';
  return <div className="personal-side-note"><b>{title}</b>会话和整理成果保存在本机。<button className="text-button" onClick={openResults}>查看个人成果库</button></div>;
}

export function SidebarProjectItem({ project, selected, select, settings, call, recommendations, pending, conflict, connection }: {
  project: { id: string; name: string }; selected: boolean;
  select: () => void; settings: () => void; call: WorkbenchAPI['call'];
  connection?: React.ReactNode; recommendations?: () => void; pending?: number; conflict?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { if (!selected) setCollapsed(false); }, [selected]);
  const expanded = selected && !collapsed;
  const detailsId = 'project-controls-' + project.id;
  return <div className={'workgroup-project-item' + (selected ? ' is-selected' : '') + (expanded ? ' is-expanded' : '')}>
    <div className="workgroup-project-row">
      <button className={'workgroup-project' + (selected ? ' selected' : '')} data-project-id={project.id} aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} onClick={() => { setCollapsed(selected ? !collapsed : false); select(); }}>
        <ChevronRight size={13} className="project-expand-icon"/><span title={project.name}>{project.name}</span>
      </button>
      <button className="icon project-settings-action" title={'项目设置：' + project.name} aria-label={'项目设置：' + project.name} onClick={settings}>{conflict ? <span className="inline-error" title="项目资料有分歧，点击处理">●</span> : <Settings size={14}/>}</button>
    </div>
    {expanded && <div className="workgroup-project-details" id={detailsId}>{connection}<RsiRecommendationToggle projectId={project.id} projectName={project.name} call={call} open={recommendations} pending={pending}/></div>}
  </div>;
}
