import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionSyncFrame } from '../../src/renderer/session-sync-frame';
import type { AgentSession, SourceFile, WorkbenchAPI } from '../../src/shared/types';
import '../../src/renderer/styles.css';
import '../../src/renderer/session-sync-frame.css';

const sources = (count: number): SourceFile[] => Array.from({ length: count }, (_, i) => ({ id: 'source-' + i, name: '参考资料 ' + (i + 1), sourcePath: 'local-conclusion:' + i + ':v1', localPath: '/fixture/' + i + '.md', sha256: 'hash-' + i, size: 8, fetchedAt: '' }));
const initial: AgentSession = { id: 'fixture', title: '测试会话', provider: 'codex', purpose: 'work', status: 'idle', cwd: '/fixture', nativeId: 'native', createdAt: '', messages: [], sources: [], approvals: [], handoffPath: '', autoUpload: false };
const api = { call: async (action: string) => {
  if (action !== 'session.source.preview') throw Error('Unexpected fixture action: ' + action);
  return { type: 'text', name: '参考资料.md', content: '参考资料正文', truncated: false };
} } as WorkbenchAPI;
function Fixture() {
  const [session, setSession] = useState(initial), [width, setWidth] = useState(900), [ids, select] = useState<string[]>([]);
  return <main style={{ padding: 30 }}>
    <div style={{ display: 'flex', gap: 10, marginBottom: 240 }}>
      {[0, 1, 3, 8].map(count => <button key={count} onClick={() => { setSession({ ...initial, sources: sources(count) }); select([]); }}>{count} 份资料</button>)}
      <label>输入区宽度<input aria-label="输入区宽度" type="number" value={width} onChange={event => setWidth(Number(event.target.value))}/></label>
      <button onClick={() => setSession(current => ({ ...current, sources: current.sources.slice(0, 1) }))}>仅留一份</button>
      <button onClick={() => {
        const briefs = [1, 2, 3].map(revision => ({ ...sources(1)[0], id: 'brief-' + revision, name: '项目说明 · v' + revision, sourcePath: '/project/项目说明.md', sha256: 'brief-hash-' + revision }));
        setSession({ ...initial, sources: briefs, projectBrief: { sourceId: briefs[2].id, revision: 3, capturedAt: '' } }); select([briefs[0].id, briefs[1].id]);
      }}>连续更新项目说明</button>
      <button onClick={() => setSession(current => ({ ...current, messages: [{ id: 'sent', role: 'user', text: '已发送', createdAt: '', context: { nativeId: current.nativeId!, accepted: true, workRecord: false, sourceHashes: Object.fromEntries(current.sources.filter(source => source.id === current.projectBrief?.sourceId).map(source => [source.id, source.sha256])) } }] }))}>确认已发送</button>
    </div>
    <div className="composer-wrap" style={{ width, maxWidth: '100%', padding: 0 }}>
      <SessionSyncFrame session={session} api={api} changed={async () => {}} references={{ sourceIds: ids, select, detach: async source => { setSession(current => ({ ...current, sources: current.sources.filter(item => item.id !== source.id) })); } }}>
        <div className="composer"><textarea aria-label="会话草稿" defaultValue="保留当前草稿" style={{ minHeight: 100, width: '100%', boxSizing: 'border-box' }}/></div>
      </SessionSyncFrame>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
