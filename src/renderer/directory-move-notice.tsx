import React, { useRef, useState } from 'react';
import type { AgentSession, WorkbenchAPI } from '../shared/types';

export function DirectoryMoveNotice({ session, api, changed }: { session: AgentSession; api: WorkbenchAPI; changed: () => Promise<void> }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const pending = useRef(false), move = session.directoryMove;
  if (!move || session.closedAt) return null;
  const choose = async (mode: 'project' | 'fixed') => {
    if (pending.current) return;
    pending.current = true; setBusy(mode); setError('');
    try { await api.call('session.directory.mode', { id: session.id, mode }); await changed(); }
    catch (reason: any) { setError(reason.message || '未能保存，请重试'); }
    finally { pending.current = false; setBusy(''); }
  };
  return <section className="directory-move-notice" aria-label="工作目录切换" role="status">
    <div className="directory-move-row"><div><b>{move.error ? '工作目录未切换' : '工作目录待切换'}</b><span>{move.error ? '原文件和对话已保留，请选择后继续。' : '等待当前任务结束后切换，也可继续使用原目录。'}</span></div><div className="directory-move-actions">
      <button type="button" className="secondary compact" disabled={!!busy} onClick={() => void choose('fixed')}>{busy === 'fixed' ? '正在保存…' : '继续使用原目录'}</button>
      {move.error && <button type="button" className="text-button" disabled={!!busy} onClick={() => void choose('project')}>{busy === 'project' ? '正在切换…' : '重试切换'}</button>}
    </div></div>
    <details><summary>查看{move.error ? '原因与' : ''}目录</summary>{move.error && <p>{move.error}</p>}<p>当前目录：{session.cwd}</p><p>目标目录：{move.to}</p>{session.inputQueue?.items.length ? <p>待发送消息已保留；选择目录后，请核对并继续队列。</p> : null}</details>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
