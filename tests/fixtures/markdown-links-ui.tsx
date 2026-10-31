import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationMessage } from '../../src/renderer/conversation-message';
import { SessionFilesDialog } from '../../src/renderer/session-files';
import { ClosedSessionsDialog } from '../../src/renderer/closed-sessions';
import '../../src/renderer/styles.css';
import type { AgentSession, Message } from '../../src/shared/types';

const calls: { name: string; input: any }[] = [];
(window as any).linkCalls = calls;
window.workbench.call = (async (name: string, input: any) => {
  calls.push({ name, input });
  if (name === 'open.link') {
    if (input.includes('/failure')) throw new Error('默认浏览器无法启动');
    return true;
  }
  if (name === 'session.file.preview') {
    if (input.id === 'remote') throw new Error('此文件位于远程主机，请在 Codex 远程项目中打开');
    if (input.path.includes('missing')) throw new Error('文件不存在或已移动：' + input.path);
    return { name: '报告.md', path: input.path, type: 'text', size: 18, truncated: false, content: '这是文件预览内容' };
  }
  if (name === 'session.files') return [];
  throw new Error('Unexpected IPC: ' + name);
}) as any;

const text = `网页：[网站](https://example.com/report)，[省略协议](//example.com/report)，[www 网站](www.example.com/report)，[打开失败](https://example.com/failure)。

文件：[相对文件](docs/report.md#L12)，[Windows 文件](<C:/fixture/验证 报告.md:12>)，[文件 URI](file:///C:/fixture/report.md)，[文件不存在](missing.md)。

定位：[第一节](#测试标题)，[第二节](#测试标题-1)，[不存在的标题](#missing)，[另一条消息标题](#other-message)。

不支持：[脚本链接](javascript:alert%281%29)，[沙箱链接](sandbox:/mnt/data/report.md)，[空链接]()，[无效网址](https://)。

## 测试标题

第一段。

## 测试标题

第二段，**粗体**和公式 $x^2$ 保留。

注释[^1]。

[^1]: 脚注内容。
`;

function App() {
  const [file, setFile] = useState<string>(), [history, setHistory] = useState(false);
  const closed = { id: 'history', title: '历史会话', provider: 'codex', cwd: 'C:/fixture', status: 'idle', closedAt: '2026-10-31T08:01:00Z', sources: [], approvals: [], messages: [{ id: 'history-reply', role: 'assistant', text, createdAt: '2026-10-31T08:00:00Z' }] } as unknown as AgentSession;
  return <main style={{ maxWidth: 1000, margin: '20px auto' }}>
    <button onClick={() => setHistory(true)}>打开真实历史窗口</button>
    {history && <ClosedSessionsDialog sessions={[closed]} initialId="history" api={window.workbench} close={() => setHistory(false)} reopen={async () => {}} remove={() => {}}/>}
    {['child', 'closed', 'main', 'no-session', 'remote'].map(id => <section key={id} data-testid={id}>
      <h2>{id}</h2>
      <ConversationMessage provider="codex" sessionId={id === 'no-session' ? undefined : id}
        openFile={id === 'main' ? setFile : undefined}
        message={{ id, role: 'assistant', text, createdAt: '2026-10-31T08:00:00Z' } as Message}/>
    </section>)}
    <ConversationMessage provider="codex" sessionId="other" message={{ id: 'other', role: 'assistant', text: '## Other Message', createdAt: '2026-10-31T08:00:00Z' } as Message}/>
    {file && <SessionFilesDialog sessionId="main" initialPath={file} close={() => setFile(undefined)}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
