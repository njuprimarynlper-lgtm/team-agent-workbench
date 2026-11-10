import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentSession, Message } from '../../src/shared/types';
import { SessionTranscript } from '../../src/renderer/session-transcript';
import '../../src/renderer/session-transcript.css';

const records: Message[] = Array.from({ length: 900 }, (_, index) => ({ id: `m${index}`, role: 'user', text: `Message ${index}`, createdAt: '' }));
function App() {
  const [count, setCount] = useState(900);
  const session: AgentSession = { id: 'fixture', title: 'Long history', provider: 'codex', purpose: 'work', status: 'idle', cwd: '', createdAt: '', handoffPath: '', autoUpload: false, approvals: [], sources: [], messageCount: count, messages: records.slice(Math.max(0, count - 160), count) };
  const inherited = useMemo(() => ({ count: count - session.messages.length, parentCount: 0, read: async (before: number, limit: number) => ({ before: Math.max(0, before - limit), messages: records.slice(Math.max(0, before - limit), before) }) }), [count]);
  return <><button id="append" onClick={() => { records.push({ id: `m${records.length}`, role: 'user', text: `Message ${records.length}`, createdAt: '' }); setCount(records.length); }}>Append</button>
    <button id="latest" onClick={() => document.querySelector('[data-transcript-scroll]')?.dispatchEvent(new Event('workbench:transcript-latest'))}>Latest</button>
    <div data-transcript-scroll tabIndex={0} style={{ height: 450, overflowY: 'auto', border: '1px solid #aaa' }}>
      <SessionTranscript session={session} inherited={inherited} renderMessage={message => <div style={{ height: 30 }}>{message.text}</div>}/>
    </div></>;
}
createRoot(document.getElementById('root')!).render(<App/>);
