import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConclusionLibrary } from '../../src/renderer/conclusions';
import { SharedContentLibrary } from '../../src/renderer/shared-content';
import type { ProjectConclusion } from '../../src/shared/types';
import type { SharedContent } from '../../src/shared/content';
import '../../src/renderer/styles.css';
const project = { id: 'fixture-project', name: '成果验证', remoteRoot: '/fixture', uploadPath: '/fixture/submissions/bob', historyPath: '/fixture/history/bob' };
const now = new Date().toISOString();
const shared: SharedContent = { id: '22222222-2222-4222-8222-222222222222', title: '成员自己的团队待办', description: '需要验证', category: 'todo', resultStatus: 'pending', kind: 'contribution', revision: 2, path: '/fixture/team.md', sha256: 'a'.repeat(64), size: 10, state: 'submitted', author: 'bob', updatedBy: 'bob', createdAt: now, updatedAt: now };
const local: ProjectConclusion = { id: '11111111-1111-4111-8111-111111111111', projectId: project.id, title: '已分享的本地成果', content: '本地内容', category: 'todo', resultStatus: 'pending', sources: [], version: 2, updatedAt: now, publication: { contentId: shared.id, revision: 2, version: 2, path: shared.path, sha256: shared.sha256, files: '[]', at: now } };
const status = new URLSearchParams(location.search).get('state') || 'linked';
const calls: { action: string; payload: any }[] = []; (window as any).fixtureCalls = calls;
window.workbench.call = (async (action: string, payload: any) => {
  calls.push({ action, payload });
  if (action === 'team.cache.read') return undefined;
  if (action === 'content.list') return [shared];
  if (action === 'content.history') return [];
  if (action === 'conclusion.list') return [local];
  if (action === 'conclusion.deletePreview') return [{ localId: local.id, title: local.title, projectId: project.id, status, ...(status === 'linked' ? { contentId: shared.id, revision: 2 } : { message: status === 'missing' ? '团队中的原成果已不存在' : '无法查询团队成果：网络断开' }) }];
  if (action === 'conclusion.deleteMany') return { missing: [] };
  return {};
}) as any;
window.workbench.subscribe = () => () => {};
function App() {
  const [mode, setMode] = useState('team'), [notice, setNotice] = useState('');
  return <main><nav><button onClick={() => setMode('team')}>检查成员团队成果</button><button onClick={() => setMode('personal')}>检查本地成果删除</button></nav><output>{notice}</output>{mode === 'team'
    ? <SharedContentLibrary project={project} username="bob" admin={false} aliases={{}} aliasSaved={async () => {}} attach={async () => {}} attachSessions={[]} notice={setNotice} mergeSessions={[]} mergeStarted={() => {}}/>
    : <ConclusionLibrary project={project} sessions={[]} notice={setNotice} mergeStarted={() => {}}/>}</main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
