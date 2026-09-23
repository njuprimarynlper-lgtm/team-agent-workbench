import React, { useRef } from 'react';
import { UserRound, UsersRound } from 'lucide-react';

export type ResultScope = 'team' | 'personal';

export function ProjectResults({ projectName, scope, changeScope, children }: { projectName: string; scope: ResultScope; changeScope: (scope: ResultScope) => void; children: React.ReactNode }) {
  const tabs = useRef<Partial<Record<ResultScope, HTMLButtonElement | null>>>({});
  return <div className="workspace-page project-results-page">
    <div className="page-title"><div><span className="eyebrow">PROJECT RESULTS</span><h1>项目成果库 · {projectName}</h1></div></div>
    <div className="result-scope-tabs" role="tablist" aria-label="成果库范围">
      {(['team', 'personal'] as const).map(value => <button key={value} ref={element => { tabs.current[value] = element; }} type="button" role="tab" aria-label={value === 'team' ? '团队' : '个人'} id={`results-tab-${value}`} aria-controls={`results-panel-${value}`} aria-selected={scope === value} tabIndex={scope === value ? 0 : -1} onClick={() => changeScope(value)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const next = event.key === 'Home' ? 'team' : event.key === 'End' ? 'personal' : value === 'team' ? 'personal' : 'team';
        changeScope(next); tabs.current[next]?.focus();
      }}>{value === 'team' ? <UsersRound size={18}/> : <UserRound size={18}/>}<span>{value === 'team' ? '团队' : '个人'}</span><small>{value === 'team' ? '项目成员共享' : '仅自己可见'}</small></button>)}
    </div>
    <section className="result-scope-panel" role="tabpanel" id={`results-panel-${scope}`} aria-labelledby={`results-tab-${scope}`} tabIndex={0}>{children}</section>
  </div>;
}
