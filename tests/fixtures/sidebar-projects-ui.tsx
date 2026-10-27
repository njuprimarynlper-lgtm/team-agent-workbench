import React, { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SidebarProjectItem } from '../../src/renderer/sidebar-project-item';
import { PersonalSection } from '../../src/renderer/personal-workspace';
import { ProjectConnectionEntry } from '../../src/renderer/project-connection';
import type { WorkbenchAPI } from '../../src/shared/types';
import '../../src/renderer/styles.css';
import '../../src/renderer/personal-workspace.css';
import '../../src/renderer/project-interactions.css';
import '../../src/renderer/project-connection.css';
import '../../src/renderer/sidebar-projects.css';

const projects = [
  { id: 'team', name: '团队工作台' },
  { id: 'research', name: '算法研究与软件落地的跨团队项目名称很长也不换行' },
  { id: 'legacy', name: '旧版本本机项目' },
  ...Array.from({ length: 12 }, (_, i) => ({ id: `project-${i}`, name: `研究项目 ${i + 1}` })),
];
const enabled = new Map<string, boolean>();
function Fixture() {
  const [selected, select] = useState('team'), [notice, setNotice] = useState('');
  const [fail, setFail] = useState(false), [pending, setPending] = useState(2);
  const call = useCallback(async (action: string, input: any) => {
    if (fail) throw new Error('暂时无法读取项目设置，请检查连接后重试');
    if (action === 'rsi.settings') return { config: { enabled: enabled.get(input.projectId) ?? true, quiet: false } };
    if (action === 'rsi.shadow.configure') { enabled.set(input.projectId, input.config.enabled); return { enabled: input.config.enabled, quiet: false }; }
    throw new Error('Unexpected fixture action: ' + action);
  }, [fail]) as WorkbenchAPI['call'];
  return <div className="app">
    <aside className="sidebar" style={{ width: 262 }}>
      <div className="sidebar-head"><h3>项目与会话</h3></div>
      <div className="workgroup-list" aria-label="项目列表" style={{ flex: 1, minHeight: 0 }}>
        <PersonalSection groups={[{ id: 'notes', name: '资料研究' }]} sessions={[]} active={selected === 'personal'} selected="" select={() => select('personal')} move={() => {}} call={call} changed={async () => {}}/>
        {projects.map(project => <section className="workgroup project-card" key={project.id}>
          <SidebarProjectItem project={project} selected={selected === project.id} select={() => select(project.id)} settings={() => setNotice('项目设置：' + project.name)} role={project.id === 'team' ? 'creator' : 'member'} call={call} pending={pending} recommendations={() => setNotice('AI推荐：' + project.name)} connection={<ProjectConnectionEntry local={project.id === 'legacy'} connected={project.id === 'team'} open={() => setNotice('中央节点：' + project.name)}/>}/>
        </section>)}
        <section className="workgroup project-card"><div className="workgroup-title"><b>尚未完善的项目资料</b></div><p>项目资料待完善</p><button className="text-button">完善项目资料</button></section>
      </div>
    </aside>
    <main style={{ padding: 24 }}><h2>项目列表 · 实际组件</h2><p role="status">{notice}</p><button onClick={() => setFail(value => !value)}>切换设置错误</button><button onClick={() => setPending(999)}>大量推荐</button></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
