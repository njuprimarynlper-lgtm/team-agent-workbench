import React from 'react';
import { createRoot } from 'react-dom/client';
import { SubsessionChat } from '../../src/renderer/subsession-chat';
import type { AgentSession, WorkbenchAPI } from '../../src/shared/types';
import '../../src/renderer/styles.css';
import '../../src/renderer/subsession-chat.css';
import '../../src/renderer/session-sync-frame.css';
import '../../src/renderer/conversation-typography.css';
import '../../src/renderer/session-name.css';
import '../../src/renderer/session-status.css';
import '../../src/renderer/session-transcript.css';
import 'katex/dist/katex.min.css';

const source = 'flowchart LR\n' + Array.from({ length: 22 }, (_, i) => `A[输入] --> N${i}[方案 ${i + 1}]\nN${i} --> Z[比较]`).join('\n') + '\nclassDef probe fill:#ff0033,stroke:#ff0033,color:#ffffff;\nclass ' + ['A', 'Z', ...Array.from({ length: 22 }, (_, i) => 'N' + i)].join(',') + ' probe;';
const parent: AgentSession = { id: 'parent', title: '图表滚动验证', provider: 'codex', purpose: 'work', cwd: '/fixture', createdAt: '', status: 'idle', messages: [], sources: [], approvals: [], autoUpload: false, handoffPath: '' };
const child: AgentSession = { ...parent, id: 'child', title: '长图表分析', parentId: parent.id, fork: { parentId: parent.id, capturedAt: '2026-10-27T00:00:00Z' } as AgentSession['fork'], messages: [
  { id: 'before', role: 'assistant', phase: 'final_answer', text: '图表之前的消息。\n\n请比较下面这些方案。', createdAt: '' },
  { id: 'diagram', role: 'assistant', phase: 'final_answer', text: '```mermaid\n' + source + '\n```', createdAt: '' },
  { id: 'after', role: 'assistant', phase: 'final_answer', text: '图表之后的消息。\n\n' + '这里是后续结果说明。\n\n'.repeat(15), createdAt: '' },
] };
const api: WorkbenchAPI = { call: async () => { throw Error('Diagram fixture must not read accounts, files or call an agent'); }, subscribe: () => () => {} };
createRoot(document.getElementById('root')!).render(<main style={{ display: 'flex', padding: 24, height: '100vh', gap: 30 }}>
  <section style={{ flex: 1 }}><h2>子会话长图表滚动验证</h2><p>合成图表，未连接账号、模型或中央节点。</p></section>
  <aside id="diagram-panel" style={{ width: 350, display: 'flex', flex: 'none', overflow: 'hidden', border: '1px solid #dfe7e2', borderRadius: 8 }}>
    <SubsessionChat session={child} sessions={[parent, child]} api={api} active edit={() => {}} open={() => {}} promote={() => {}} remove={() => {}} closed={() => {}} changed={async () => {}}/>
  </aside>
</main>);
