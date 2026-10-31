import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SubsessionWorkspace } from '../../src/renderer/subsession-workspace';
import { SessionTree } from '../../src/renderer/subsession-chat';
import { childForSelectedParent, subsessionParentId } from '../../src/shared/subsessions';
import type { AgentSession, SessionInput, WorkbenchAPI } from '../../src/shared/types';
import '../../src/renderer/styles.css';
import '../../src/renderer/subsession-chat.css';
import '../../src/renderer/session-sync-frame.css';
import '../../src/renderer/conversation-typography.css';
import '../../src/renderer/desktop-interactions.css';

const make = (id: string, title: string, parentId?: string): AgentSession => ({ id, title, parentId, provider: 'codex', purpose: 'work', status: 'idle', cwd: '/fixture', createdAt: '', sources: [], approvals: [], autoUpload: false, handoffPath: '', messages: [{ id: id + '-reply', role: 'assistant', text: title + '的独立回复。', createdAt: '' }], ...(parentId ? { fork: { parentId, capturedAt: '2026-10-27T00:00:00Z' } as AgentSession['fork'] } : {}) });
const initial = [make('a', '量化方案研究'), make('a1', '误差分析', 'a'), { ...make('a2', '速度验证', 'a'), status: 'running' as const }, make('b', 'OCR 识别优化'), make('b1', '版面分析', 'b'), make('b2', '识别准确率', 'b'), make('n1', '分块实验', 'a1'), make('n2', '尾部样本', 'a1'), { ...make('closed', '已关闭的探索', 'a'), closedAt: 'now' }, make('empty', '暂无子会话的父会话')];
function Fixture() {
  const [sessions, setSessions] = useState(initial), [parentId, setParent] = useState('a'), [childId, setChild] = useState('a1');
  const [inputs, setInputs] = useState<Record<string, SessionInput>>({}), [width, setWidth] = useState(440);
  const [calls, setCalls] = useState<string[]>([]);
  const child = sessions.find(s => s.id === childId);
  const open = (target: AgentSession) => {
    let root = target; const seen = new Set<string>();
    while (subsessionParentId(root) && !seen.has(root.id)) { seen.add(root.id); const parent = sessions.find(s => s.id === subsessionParentId(root)); if (!parent) break; root = parent; }
    setParent(root.id); setChild(subsessionParentId(target) ? target.id : childForSelectedParent(sessions, root.id, childId));
  };
  const api = { call: async (action: string, payload: any) => {
    setCalls(value => [...value, action + ':' + payload.id]);
    if (action === 'session.rename') { setSessions(value => value.map(s => s.id === payload.id ? { ...s, title: payload.title } : s)); return; }
    if (action === 'session.close') { setSessions(value => value.map(s => s.id === payload.id ? { ...s, closedAt: 'now' } : s)); return; }
    if (action === 'subsession.history') return [];
    throw Error('Unexpected fixture action: ' + action);
  } } as WorkbenchAPI;
  return <main style={{ display: 'flex', height: '100vh', padding: 18, gap: 20 }}>
    <aside style={{ width: 240, overflow: 'auto' }}><h3>会话</h3><SessionTree sessions={sessions.filter(s => !s.closedAt)} selectedId={parentId} childId={childId} open={open} create={() => {}} promote={() => {}} rename={async () => {}}/>
      <button onClick={() => setSessions(value => [...value, ...Array.from({ length: 10 }, (_, i) => make('more-' + i, '比较不同规模下的长标题探索方案 ' + (i + 1), 'a'))])}>增加同级子会话</button>
      <label>右栏宽度<input type="number" aria-label="右栏宽度" value={width} onChange={e => setWidth(Number(e.target.value))}/></label>
      <label>子会话状态<select aria-label="子会话状态" value={child?.stoppedAt ? 'stopping' : child?.status || 'idle'} onChange={e => { const status = e.target.value; setSessions(value => value.map(s => s.id === childId ? { ...s, status: status === 'stopping' ? 'running' : status as AgentSession['status'], stoppedAt: status === 'stopping' ? '2026-10-31T00:00:00Z' : undefined } : s)); }}><option value="idle">空闲</option><option value="running">运行中</option><option value="starting">启动中</option><option value="approval">待审批</option><option value="stopping">停止中</option></select></label>
      <label><input type="checkbox" aria-label="长模型名称" onChange={e => { const long = e.target.checked; setSessions(value => value.map(s => ({ ...s, model: long ? 'a-very-long-model-name-with-reasoning-effort' : undefined, reasoningEffort: long ? 'xhigh' : undefined, settingsPending: long }))); }}/>长模型名称</label>
      <output id="fixture-calls">{calls.join('|')}</output>
    </aside>
    <section style={{ flex: 1, minWidth: 0 }}><h2>父会话</h2><p id="main-parent">{sessions.find(s => s.id === parentId)?.title}</p><p>右侧可切换子会话；各自的输入与回复独立保留。</p></section>
    <aside style={{ width, flex: 'none', display: 'flex', border: '1px solid #dde5df', borderRadius: 10, overflow: 'hidden' }}>
      <SubsessionWorkspace session={child} sessions={sessions} input={child && inputs[child.id]} api={api} active open={open} promote={() => {}} remove={() => {}} closed={() => setChild('')} changed={async () => {}} edit={(id, patch) => setInputs(value => ({ ...value, [id]: { ...(value[id] || { text: '', sourceIds: [], answers: {} }), ...patch } }))}/>
    </aside>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
