import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectInteractionPanel, type InteractionTab } from '../../src/renderer/project-interactions';
import type { RsiInbox } from '../../src/shared/rsi';
import type { WorkbenchAPI } from '../../src/shared/types';
import '../../src/renderer/styles.css';
import '../../src/renderer/project-interactions.css';

const recommendation = (index: number): RsiInbox['items'][number] => ({
  id: 'r' + index, projectId: 'project', sessionId: 'session', runId: 'run', policyId: 'policy', createdAt: '2026-10-27T07:00:00Z', fingerprint: 'f' + index,
  title: ['两个实验使用的测试集不同，暂时无法直接比较结果', '候选方案尚未完成独立速度测试', '边界样本的结果需要补充复核'][index % 3],
  action: '建议固定同一组测试数据后，再比较候选方案与当前基线。', reason: '两条会话记录使用了不同版本的验证集。', evidenceIds: [], evidence: [], conditions: [], uncertainty: '', priority: .8,
  review: { decision: 'pending', closed: false, feedback: '' },
});
function Fixture() {
  const [active, select] = useState<InteractionTab | ''>('questions');
  const [inbox, setInbox] = useState<RsiInbox>({ projectId: 'project', enabled: true, busy: false, queued: false, sessions: [], items: [] });
  const call: WorkbenchAPI['call'] = async (action, payload: any) => {
    if (action !== 'rsi.feedback') throw new Error('Unexpected action: ' + action);
    const reaction = payload.reaction;
    setInbox(current => ({ ...current, items: current.items.map(item => item.id !== reaction.suggestionId ? item : { ...item, review: { ...item.review,
      ...(reaction.kind === 'accepted' || reaction.kind === 'rejected' ? { decision: reaction.kind } : {}),
      ...(['dismissed', 'supplement'].includes(reaction.kind) ? { closed: true } : {}),
    } }) }));
    return undefined as any;
  };
  return <div style={{ display: 'flex', height: '100vh', background: '#fff' }}>
    <main className="main-content" style={{ flex: 1, minWidth: 0, padding: 28 }}>
      <h2>量化转换方案比较</h2><p className="muted small">实际组件 · 离线测试数据</p>
      <p style={{ marginTop: 60 }}>主会话保持原来的位置，推荐在右侧提示。</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 50 }}>
        <button onClick={() => setInbox(current => ({ ...current, items: Array.from({ length: 3 }, (_, i) => recommendation(i)) }))}>模拟收到推荐</button>
        <button onClick={() => setInbox(current => ({ ...current, items: Array.from({ length: 120 }, (_, i) => recommendation(i)) }))}>模拟大量推荐</button>
        <button onClick={() => setInbox(current => ({ ...current, items: [] }))}>清空推荐</button>
        <button onClick={() => setInbox(current => ({ ...current, enabled: false }))}>停止后台分析</button>
      </div>
    </main>
    <ProjectInteractionPanel projectName="算法竞赛优化" active={active} select={select} close={() => select('')} inbox={inbox} call={call} reload={async () => {}} questionCount={1}
      questions={<div style={{ padding: 20 }}><h3>寻求帮助</h3><p style={{ marginTop: 14 }}>请协助确认两组实验是否可直接比较。</p><textarea aria-label="求助草稿" placeholder="补充问题…"/></div>}
      subsessions={<p style={{ padding: 20 }}>子会话内容</p>} sideChats={<p style={{ padding: 20 }}>侧边提问内容</p>}/>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
