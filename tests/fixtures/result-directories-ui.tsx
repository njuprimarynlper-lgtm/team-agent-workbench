import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConclusionLibrary } from '../../src/renderer/conclusions';
import { SharedContentLibrary } from '../../src/renderer/shared-content';
import { DraftEditor } from '../../src/renderer/draft-editor';
import { ProjectResults, type ResultScope } from '../../src/renderer/project-results';
import { changeResultDirectory, resultFolderMetadata, type ResultDirectory } from '../../src/shared/result-directories';
import { uploadFilesKey } from '../../src/shared/conclusion-upload';
import type { Draft, ProjectConclusion } from '../../src/shared/types';
import type { SharedContent } from '../../src/shared/content';
import '../../src/renderer/styles.css';
import '../../src/renderer/result-card.css';

const project = { id: 'fixture', name: '实体抽取优化', remoteRoot: '/fixture', uploadPath: '/fixture/submissions/bob', historyPath: '/fixture/history/bob' }, now = new Date().toISOString();
const personalFolder = '11111111-1111-4111-8111-111111111111', personalChild = '11111111-1111-4111-8111-111111111112', teamFolder = '22222222-2222-4222-8222-222222222222';
const directories: Record<string, ResultDirectory[]> = { personal: [{ id: personalFolder, name: '我的验证', parentId: 'exploration', revision: 1 }, { id: personalChild, name: '低频样本', parentId: personalFolder, revision: 1 }], team: [{ id: teamFolder, name: '联合验证', parentId: 'exploration', revision: 1 }] };
const personal: ProjectConclusion[] = [
  { id: '33333333-3333-4333-8333-333333333333', projectId: project.id, title: '当前层结论', content: '当前目录的结论与证据', folderId: personalFolder, category: 'exploration', version: 1, updatedAt: now, sources: [] },
  { id: '33333333-3333-4333-8333-333333333334', projectId: project.id, title: '低频实体分析', content: '独有证据样本', folderId: personalChild, category: 'exploration', version: 1, updatedAt: now, sources: [] },
  { id: '33333333-3333-4333-8333-333333333335', projectId: project.id, title: '待补充样本', content: '补充新的验证数据', category: 'todo', resultStatus: 'pending', version: 1, updatedAt: now, sources: [] },
  { id: '33333333-3333-4333-8333-333333333336', projectId: project.id, title: '已完成评测', content: '完成基础回归', category: 'todo', resultStatus: 'completed', version: 1, updatedAt: now, sources: [] },
  { id: '33333333-3333-4333-8333-333333333337', projectId: project.id, title: '旧版批处理能力', content: '保留的历史能力记录', category: 'capability', archived: true, version: 1, updatedAt: now, sources: [] },
];
const team: SharedContent[] = [{ id: '44444444-4444-4444-8444-444444444444', title: '团队评测结论', description: '评测发现需要增加低频样本。', category: 'exploration', folderId: teamFolder, revision: 2, kind: 'contribution', author: 'alice', updatedBy: 'alice', state: 'submitted', path: '/fixture/shared.md', sha256: 'a'.repeat(64), size: 50, createdAt: now, updatedAt: now }];
const draft: Draft = { id: '55555555-5555-4555-8555-555555555555', sessionId: '66666666-6666-4666-8666-666666666666', binding: { project, username: 'bob' } as any, title: '阶段整理', body: '已整理', generation: 'ready', files: [], inputDir: '', outputPath: '', createdAt: now, resultRules: { contract: 4, categories: ['capability', 'exploration'] }, artifacts: [
  { id: 'draft-1', title: '批量处理能力', category: 'capability', body: '已支持批量处理。', fields: {}, selected: true, target: '/fixture/capabilities' },
  { id: 'draft-2', title: '低频样本发现', category: 'exploration', body: '整理后的证据。', fields: {}, selected: true, target: '/fixture/explorations' },
] };
const calls: any[] = []; Object.assign(window, { fixture: { project, directories, personal, team, draft }, fixtureCalls: calls });
const aliases: Record<string, string> = {};
window.workbench.call = (async (action: string, payload: any = {}) => {
  calls.push({ action, payload: structuredClone(payload) });
  if (action === 'team.cache.read') return undefined;
  if (action === 'result.directory.list') return structuredClone(directories[payload.scope]);
  if (action === 'result.directory.change') { directories[payload.scope] = changeResultDirectory(directories[payload.scope], payload.command); return structuredClone(directories[payload.scope]); }
  if (action === 'result.directory.move') { const items = payload.scope === 'personal' ? personal : team; for (const ref of payload.change.items) { const item = items.find(item => item.id === ref.id)!; Object.assign(item, resultFolderMetadata(item, payload.change.folderId, directories[payload.scope]), { folderId: payload.change.folderId, folderVersion: ref.folderVersion + 1 }); } return []; }
  if (action === 'conclusion.list') return structuredClone(personal);
  if (action === 'conclusion.create') { const item: ProjectConclusion = { ...payload, id: crypto.randomUUID(), version: 1, updatedAt: now, sources: [] }; personal.push(item); return structuredClone(item); }
  if (action === 'conclusion.alias.save') { const item = personal.find(item => item.id === payload.id)!; item.titleAlias = payload.alias; return structuredClone(item); }
  if (action === 'conclusion.save') { const item = personal.find(item => item.id === payload.id)!; if (payload.version !== item.version) throw Error('版本冲突'); Object.assign(item, payload, { version: item.version + 1 }); return structuredClone(item); }
  if (action === 'content.alias.save') { aliases[project.id + ':' + payload.contentId] = payload.alias; return {}; }
  if (action === 'content.edit') { const item = team.find(item => item.id === payload.change.id)!; if (item.author !== 'bob') throw Error('只有提交者可以编辑'); Object.assign(item, payload.change, { revision: item.revision + 1 }); return structuredClone(item); }
  if (action === 'content.list') return structuredClone(team);
  if (action === 'content.history') return [];
  if (action === 'conclusion.import') { const item = team.find(item => item.id === payload.contentId)!; const copy: ProjectConclusion = { id: crypto.randomUUID(), projectId: project.id, title: item.title, category: item.category, content: item.description, folderId: payload.folderId, version: 1, updatedAt: now, automatic: true, sources: [{ kind: 'remote', id: item.id, title: item.title, content: item.description, revision: item.revision, updatedAt: now }] }; personal.push(copy); return { action: 'created', conclusion: copy }; }
  if (action === 'draft.personal.save') { draft.personalSavedIds = payload.artifactIds; (window as any).refreshDraft(); return []; }
  if (action === 'draft.submit') { draft.submitted = 'transfer'; (window as any).refreshDraft(); return []; }
  if (action === 'draft.supplement') { Object.assign(draft, payload); return structuredClone(draft); }
  if (action === 'draft.artifact.edit' || action === 'draft.artifactSelection') { Object.assign(draft.artifacts!.find(item => item.id === payload.artifactId)!, payload); (window as any).refreshDraft(); return structuredClone(draft); }
  if (action === 'conclusion.publish') {
    const item = personal.find(item => item.id === payload.id)!, original = team.find(value => value.id === item.publication?.contentId);
    const saved: SharedContent = { ...original, id: original?.id || crypto.randomUUID(), kind: 'contribution', title: item.title, description: item.content, author: 'bob', state: 'submitted', revision: (original?.revision || 0) + 1, path: '/fixture/' + crypto.randomUUID() + '.md', sha256: 'b'.repeat(64), size: item.content.length, createdAt: now, updatedAt: now, updatedBy: 'bob', folderId: payload.folderId };
    Object.assign(saved, resultFolderMetadata(item, payload.folderId, directories.team));
    if (original) team.splice(team.indexOf(original), 1); team.push(saved);
    item.publication = { contentId: saved.id, revision: saved.revision, version: item.version, path: saved.path, sha256: saved.sha256, files: uploadFilesKey(item.localFiles), at: now };
    return {};
  }
  throw Error('Unexpected fixture API: ' + action);
}) as any;
function App() {
  const [scope, setScope] = useState<ResultScope | 'draft'>('team'), [admin, setAdmin] = useState(false), [notice, setNotice] = useState(''), [current, setDraft] = useState(structuredClone(draft));
  const [localAliases, setAliases] = useState({ ...aliases });
  (window as any).refreshDraft = () => setDraft(structuredClone(draft));
  return <main style={{ height: '100vh', overflow: 'auto', padding: 24 }}><nav className="row"><button className="secondary" onClick={() => setScope('personal')}>项目成果库</button><button className="secondary" onClick={() => setScope('draft')}>成果整理</button><button className="secondary" onClick={() => setAdmin(!admin)}>{admin ? '切换成员' : '切换管理员'}</button></nav><output>{notice}</output>
    {scope !== 'draft' ? <ProjectResults projectName={project.name} scope={scope} changeScope={setScope}>{scope === 'team' ? <SharedContentLibrary embedded project={project} username="bob" admin={admin} aliases={localAliases} aliasSaved={async () => setAliases({ ...aliases })} attach={async () => {}} attachSessions={[]} notice={setNotice} mergeSessions={[]} mergeStarted={() => {}}/> : <ConclusionLibrary embedded username="bob" project={project} sessions={[]} notice={setNotice} mergeStarted={() => {}}/>}</ProjectResults> : <DraftEditor draft={current} transfers={[]} run={async fn => { try { return await fn(); } catch (reason: any) { setNotice(reason.message); } }} notice={setNotice} close={() => setScope('personal')} reorganized={() => {}} sourceTitle="实体抽取工作会话" viewShared={() => {}} viewConclusion={() => setScope('personal')}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
