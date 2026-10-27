import React, { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SidebarProjectItem } from '../../src/renderer/sidebar-project-item';
import { PersonalSection } from '../../src/renderer/personal-workspace';
import { ProjectConnectionEntry } from '../../src/renderer/project-connection';
import { SessionTree } from '../../src/renderer/subsession-chat';
import { ConversationMessage } from '../../src/renderer/conversation-message';
import { SessionTranscript } from '../../src/renderer/session-transcript';
import { SessionTurnProgress } from '../../src/renderer/turn-timing';
import type { AgentSession, WorkbenchAPI } from '../../src/shared/types';
import '../../src/renderer/styles.css';
import '../../src/renderer/personal-workspace.css';
import '../../src/renderer/project-interactions.css';
import '../../src/renderer/project-connection.css';
import '../../src/renderer/session-name.css';
import '../../src/renderer/subsession-chat.css';
import '../../src/renderer/session-status.css';
import '../../src/renderer/session-transcript.css';
import '../../src/renderer/conversation-typography.css';
import '../../src/renderer/turn-timing.css';
import '../../src/renderer/sidebar-projects.css';

const projects = [
  { id: 'team', name: '团队工作台' },
  { id: 'research', name: '算法研究与软件落地的跨团队项目名称很长也不换行' },
  { id: 'legacy', name: '旧版本本机项目' },
  ...Array.from({ length: 12 }, (_, i) => ({ id: `project-${i}`, name: `研究项目 ${i + 1}` })),
];
const enabled = new Map<string, boolean>();
const recorded: AgentSession = {
 id: 'discussion', title: '量化转换方案比较', provider: 'codex', purpose: 'work', status: 'idle', cwd: '.', createdAt: '2026-10-27T06:30:00Z', handoffPath: '', autoUpload: false, sources: [], approvals: [],
 messages: [
  { id: 'question', role: 'user', createdAt: '2026-10-27T06:30:00Z', text: '比较目前的两个方案，给出下一步的验证建议。' },
  { id: 'answer', role: 'assistant', phase: 'final_answer', createdAt: '2026-10-27T06:30:42Z', text: '建议先保留通过精度验证的方案 A，再单独测试速度。\n\n### 当前依据\n- 方案 A：已通过现有精度测试。\n- 方案 B：速度结果尚未复核，仍需检查大幅值样本。\n\n下一步使用相同数据与设备进行比较，保留每轮的原始结果。' },
 ],
 turnTimings: [{ id: 'turn1', userMessageId: 'question', assistantMessageIds: ['answer'], startedAt: '2026-10-27T06:30:00Z', updatedAt: '2026-10-27T06:30:42Z', finishedAt: '2026-10-27T06:30:42Z', outcome: 'completed', phase: 'reply', phaseStartedAt: '2026-10-27T06:30:35Z', durations: { thinking: 18000, tools: 14000, reply: 7000, approval: 0, network: 3000, other: 0 }, thinkingObserved: true, partial: false }],
};
function Fixture() {
  const [selected, select] = useState('team'), [notice, setNotice] = useState('');
  const [sessions, setSessions] = useState([recorded, { ...recorded, id: 'alternative', title: '备选方案探索（含长标题的显示验证）', messages: [], turnTimings: [] }]);
  const [active, setActive] = useState(recorded.id), [running, setRunning] = useState<AgentSession>();
  const scoped = selected === 'team' ? sessions : [];
  const panel = <div className="project-session-panel"><div className="session-heading"><h3>会话</h3><button className="icon" aria-label="新建会话" onClick={() => setNotice('新建会话')}>＋</button></div><div className="session-list"><SessionTree sessions={scoped.filter(s => !s.closedAt)} selectedId={active} open={s => setActive(s.id)} create={s => setNotice('创建子会话：' + s.title)} promote={() => {}} manage={s => setNotice('迁移：' + s.title)} closeSession={s => setSessions(items => items.map(item => item.id === s.id ? { ...item, closedAt: new Date().toISOString() } : item))} rename={async (id, title) => setSessions(items => items.map(item => item.id === id ? { ...item, title } : item))}/></div><button className="closed-toggle text-button" onClick={() => setNotice('查看已关闭会话')}>已关闭会话（{scoped.filter(s => s.closedAt).length}）</button></div>;
  const [fail, setFail] = useState(false), [pending, setPending] = useState(2);
  const call = useCallback(async (action: string, input: any) => {
    if (fail) throw new Error('暂时无法读取项目设置，请检查连接后重试');
    if (action === 'rsi.settings') return { config: { enabled: enabled.get(input.projectId) ?? true, quiet: false } };
    if (action === 'rsi.shadow.configure') { enabled.set(input.projectId, input.config.enabled); return { enabled: input.config.enabled, quiet: false }; }
    throw new Error('Unexpected fixture action: ' + action);
  }, [fail]) as WorkbenchAPI['call'];
  return <div className="app">
    <aside className="sidebar sidebar-project-tree" style={{ width: 262 }}>
      <div className="sidebar-project-pane"><div className="sidebar-head"><h3>项目与会话</h3></div>
      <div className="workgroup-list" aria-label="项目列表" style={{ flex: 1, minHeight: 0 }}>
        <PersonalSection groups={[{ id: 'notes', name: '资料研究' }]} sessions={[]} active={selected === 'personal'} selected="" select={() => select('personal')} move={() => {}} call={call} changed={async () => {}}>{panel}</PersonalSection>
        {projects.map(project => <section className="workgroup project-card" key={project.id}>
          <SidebarProjectItem count={project.id === 'team' ? sessions.filter(s => !s.closedAt).length : 0} project={project} selected={selected === project.id} select={() => select(project.id)} settings={() => setNotice('项目设置：' + project.name)} role={project.id === 'team' ? 'creator' : 'member'} call={call} pending={pending} recommendations={() => setNotice('AI推荐：' + project.name)} connection={<ProjectConnectionEntry local={project.id === 'legacy'} connected={project.id === 'team'} open={() => setNotice('中央节点：' + project.name)}/>}>{panel}</SidebarProjectItem>
        </section>)}
        <section className="workgroup project-card"><div className="workgroup-title"><b>尚未完善的项目资料</b></div><p>项目资料待完善</p><button className="text-button">完善项目资料</button></section>
      </div>
    </div></aside>
    <main className="main-content"><div style={{ padding: '14px 24px', borderBottom: '1px solid #e0e6e2' }}><h2>量化转换方案比较</h2><small>实际组件 · 隔离打桩数据</small></div><div className="messages"><SessionTranscript session={recorded} renderMessage={message => <ConversationMessage message={message} provider="codex"/>}/>{running && <SessionTurnProgress session={running}/>}</div><div style={{ padding: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}><p id="fixture-notice" role="status">{notice}</p><button onClick={() => setFail(value => !value)}>切换设置错误</button><button onClick={() => setPending(999)}>大量推荐</button><button onClick={() => { const now = new Date().toISOString(); setRunning({ ...recorded, id: 'live', status: 'running', turnTimings: [{ ...recorded.turnTimings![0], id: 'live', phase: 'thinking', phaseStartedAt: now, startedAt: now, updatedAt: now, finishedAt: undefined, durations: { thinking: 0, tools: 0, reply: 0, approval: 0, network: 0, other: 0 } }] }); }}>开始计时</button><button onClick={() => setRunning(undefined)}>结束计时</button></div></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
