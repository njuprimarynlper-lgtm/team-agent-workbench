import { contextualError } from './contextual-error';
import { ErrorLogLink } from './error-notice';
import React, { useRef, useState } from 'react';
import type { AgentSession, WorkbenchAPI } from '../shared/types';
import { uiErrorMessage } from '../shared/user-failure';

export function DirectoryMoveNotice({ session, api, changed }: { session: AgentSession; api: WorkbenchAPI; changed: () => Promise<void> }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const pending = useRef(false), move = session.directoryMove;
  if (!move || session.closedAt) return null;
  const choose = async (mode: 'project' | 'fixed') => {
    if (pending.current) return;
    pending.current = true; setBusy(mode); setError('');
    try { await api.call('session.directory.mode', { id: session.id, mode }); try { await changed(); } catch { setError('目录选择已经保存，但界面没刷新。请重新打开这个会话查看，不用再选择一次。'); } }
    catch (reason) { setError(contextualError(reason, { domain: 'local', operation: mode === 'fixed' ? '保留当前工作目录' : '重试切换工作目录' }, { UNCLASSIFIED_FAILURE: mode === 'project' ? '这次切换目录出了问题，文件和对话都还在。你可以先点“继续使用原目录”，保留当前工作。' : '没有保存继续使用当前目录的选择。点“继续使用原目录”再试。' })); }
    finally { pending.current = false; setBusy(''); }
  };
  return <section className="directory-move-notice" aria-label="工作目录切换" role="status">
    <div className="directory-move-row"><div><b>{move.error ? '工作目录未切换' : '工作目录待切换'}</b><span>{move.error ? '原文件和对话都还在。' : '等待当前任务结束后切换，也可继续使用原目录。'}</span></div><div className="directory-move-actions">
      <button type="button" className="secondary compact" disabled={!!busy} onClick={() => void choose('fixed')}>{busy === 'fixed' ? '正在保存…' : '继续使用原目录'}</button>
      {move.error && <button type="button" className="text-button" disabled={!!busy} onClick={() => void choose('project')}>{busy === 'project' ? '正在切换…' : '重试切换'}</button>}
    </div></div>
    {move.error && !error && <p>{/无法迁移特殊文件/.test(move.error) ? '有些文件暂时不能复制，所以还在使用原目录。先点“继续使用原目录”即可接着工作；文件种类可在日志中看。' : uiErrorMessage(move.error, { domain: 'local', operation: '切换工作目录' })} <ErrorLogLink message={move.error}/></p>}
    <details><summary>查看目录</summary><p>当前目录：{session.cwd}</p><p>目标目录：{move.to}</p>{session.inputQueue?.items.length ? <p>待发送消息已保留；选择目录后，请核对并继续队列。</p> : null}</details>
    {error && <p className="inline-error" role="alert">{error} <ErrorLogLink message={error}/></p>}
  </section>;
}
