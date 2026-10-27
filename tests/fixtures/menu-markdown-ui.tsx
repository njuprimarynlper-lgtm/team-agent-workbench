import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { MarkdownEditor } from '../../src/renderer/markdown-editor';
import { MenuDetails } from '../../src/renderer/menu-details';
import { usePopupDismiss } from '../../src/renderer/popup-dismiss';
import { ProjectBriefSettings } from '../../src/renderer/project-brief-editor';
import { briefFields } from '../../src/shared/project-brief';
import { ConclusionLibrary } from '../../src/renderer/conclusions';
import { PreparationCategoryChoices } from '../../src/renderer/preparation-options';
import { ComposerSettings } from '../../src/renderer/composer-settings';
import { ComposerMode } from '../../src/renderer/composer-mode';
import { CodexComposerTools } from '../../src/renderer/composer-codex-tools';
import '../../src/renderer/styles.css';
import '../../src/renderer/session-toolbar.css';
import type { AgentSession } from '../../src/shared/types';
const session = { id: 'fixture', provider: 'codex', cwd: 'C:/fixture', status: 'idle', messages: [], approvals: [], sources: [] } as unknown as AgentSession;
window.workbench.call = (async (name: string) => {
  if (name === 'project.brief') return { brief: Object.fromEntries(briefFields.map(field => [field.key, ''])), revision: 1 };
  if (['conclusion.list', 'content.list'].includes(name)) return [];
  if (name === 'provider.catalog') return { models: [{ id: 'fixture', name: '测试模型' }], quota: { windows: [] } };
  if (name === 'session.modes') return { modes: [{ id: 'default', name: 'Agent' }, { id: 'plan', name: 'Plan' }] };
  if (name === 'session.capabilities') return { skills: [{ id: 'skill:fixture', kind: 'skill', name: '测试方法', invocation: '$fixture', enabled: true }], plugins: [] };
  return {};
}) as any;
function Child({ owner, close }: { owner: HTMLElement | null; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null); usePopupDismiss(true, ref, close, { owner: () => owner });
  return createPortal(<div className="composer-popover" style={{ position: 'fixed', top: 80, left: 420 }} ref={ref} role="menu" aria-label="二级菜单"><label>子菜单搜索<input aria-label="子菜单搜索"/></label><label><input type="checkbox"/>多选项</label></div>, document.body);
}
function App() {
  const [text, setText] = useState(''), [composer, setComposer] = useState(''), [clicks, setClicks] = useState(0), [modal, setModal] = useState(true), [child, setChild] = useState(false);
  const [directions, setDirections] = useState({}), [selected, setSelected] = useState<any[]>([]); const owner = useRef<HTMLButtonElement>(null);
  const [screen, setScreen] = useState('edit');
  const project = { id: 'fixture', name: '示例项目', remoteRoot: '/fixture', uploadPath: '/fixture/uploads', historyPath: '/fixture/history' };
  if (screen === 'project') return <main style={{ maxWidth: 900, margin: '20px auto' }}><button onClick={() => setScreen('edit')}>返回编辑检查</button><ProjectBriefSettings project={project} admin saved={async () => {}}/></main>;
  if (screen === 'result') return <main style={{ maxWidth: 1000, margin: '20px auto' }}><button onClick={() => setScreen('edit')}>返回编辑检查</button><ConclusionLibrary project={project} sessions={[]} notice={() => {}} mergeStarted={() => {}}/></main>;
  return <main style={{ maxWidth: 1000, margin: '20px auto' }}><button onClick={() => setClicks(clicks + 1)}>外部操作 {clicks}</button><input aria-label="单行名称"/><button>下一个控件</button>
    <div role="dialog" aria-label="编辑弹窗" onKeyDown={event => { if (event.key === 'Escape') setModal(false); }} data-open={modal}>
      <MenuDetails className="session-more"><summary>菜单 A</summary><div className="session-more-actions"><input aria-label="菜单搜索"/><label><input type="checkbox"/>选择一</label><button ref={owner} onClick={() => setChild(true)}>打开二级菜单</button></div></MenuDetails>
      {child && <Child owner={owner.current} close={() => setChild(false)}/>}
      <MenuDetails className="session-more"><summary>菜单 B</summary><div className="session-more-actions"><button>操作 B</button></div></MenuDetails>
      <label className="field">正文<MarkdownEditor aria-label="测试正文" rows={6} value={text} onChange={event => setText(event.target.value)}/></label>
    </div>
    <div className="composer"><MarkdownEditor aria-label="任务输入" value={composer} onChange={event => setComposer(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); setClicks(n => n + 10); } }}/><div className="composer-bottom"><CodexComposerTools session={session} text={composer} changeText={setComposer} selected={selected} change={setSelected}/><ComposerSettings session={session}/><ComposerMode session={session}/></div></div>
    <section><h2>整理提示</h2><PreparationCategoryChoices categories={['capability']} selected={['capability']} directions={directions} disabled={false} select={() => {}} changeDirection={(category, value) => setDirections({ [category]: value })}/></section><button onClick={() => setScreen('project')}>检查项目资料</button><button onClick={() => setScreen('result')}>检查个人成果</button>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
