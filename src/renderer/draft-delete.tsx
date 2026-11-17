import { userFailure } from '../shared/user-failure';
import { uiErrorMessage } from '../shared/user-failure';
import { resultLabelTitle } from '../shared/result-labels';
import React, { useState } from 'react';
import type { Draft } from '../shared/types';
import type { DraftDeleteResult } from '../shared/draft-delete';

export function DraftDeleteDialog({ draft, remove, close }: { draft: Draft; remove: () => Promise<void>; close: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-draft-title">
    <header><h2 id="delete-draft-title">删除整理记录？</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}>×</button></header>
    <div className="modal-body"><p>删除“{resultLabelTitle(draft.titleAlias || draft.title)}”的整理记录{draft.generation === 'running' ? '，并停止这次整理' : ''}。</p><p className="muted small">已保存的个人成果、已提交的团队成果、原 Session 和增量整理进度都会保留。尚未保存或提交的草稿内容会随记录删除。已提交的上传仍可在传输列表查看和重试；记录删除会同步到你的其他电脑。</p>{error && <p className="inline-error" role="alert">{error}</p>}</div>
    <footer><button className="secondary" autoFocus disabled={busy} onClick={close}>取消</button><button className="primary danger" disabled={busy} onClick={async () => { if (busy) return; setBusy(true); setError(''); try { await remove(); } catch (error: any) { setError(uiErrorMessage(error, { domain: 'local', operation: '删除整理记录', outcome: 'unknown' })); setBusy(false); } }}>{busy ? '正在删除…' : '删除记录'}</button></footer>
  </section></div>;
}

export function DraftBulkDeleteDialog({ drafts, remove, close }: { drafts: Draft[]; remove: (ids: string[]) => Promise<DraftDeleteResult>; close: () => void }) {
  const [remaining, setRemaining] = useState(drafts), [deleted, setDeleted] = useState(0), [failures, setFailures] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const running = remaining.filter(draft => draft.generation === 'running').length;
  const confirm = async () => {
    if (busy || !remaining.length) return; setBusy(true); setError('');
    try {
      const result = await remove(remaining.map(draft => draft.id));
      setDeleted(count => count + result.deletedIds.length);
      if (!result.failures.length) { close(); return; }
      const errors = Object.fromEntries(result.failures.map(item => [item.id, userFailure(item.message, { domain: 'local' }).code === 'STORAGE_FULL' ? '这台电脑空间不足，没能保存删除记录。请腾出空间，再点下方“重试删除”。' : uiErrorMessage(item.message, { domain: 'local', operation: '删除该整理记录', outcome: 'unknown' })]));
      setFailures(errors); setRemaining(items => items.filter(item => item.id in errors));
    } catch (reason: any) { setError(uiErrorMessage(reason, { domain: 'local', operation: '删除整理记录', outcome: 'unknown' })); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-drafts-title">
    <header><h2 id="delete-drafts-title">批量删除整理记录？</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}>×</button></header>
    <div className="modal-body">
      {deleted > 0 && <p role="status">已删除 {deleted} 条记录，剩余 {remaining.length} 条未完成。</p>}
      <p>{deleted ? `以下 ${remaining.length} 条还没删完：` : `将删除以下 ${remaining.length} 条整理记录。`}</p>
      <ul className="delete-selection-list">{remaining.map(draft => <li key={draft.id}><b>{resultLabelTitle(draft.titleAlias || draft.title)}</b><small className="muted"> · {draft.binding?.project.name || '本机项目'}{draft.generation === 'running' ? ' · 整理中' : ''}</small>{failures[draft.id] && <p className="inline-error">{failures[draft.id]}</p>}</li>)}</ul>
      {running > 0 && <p>其中 {running} 条正在整理，删除会先停止这些整理任务。</p>}
      <p className="muted small">只删除所选整理记录。个人成果、团队成果和原会话都保留；尚未保存的草稿会删除。</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
    <footer><button className="secondary" autoFocus disabled={busy} onClick={close}>{deleted ? '关闭' : '取消'}</button><button className="primary danger" disabled={busy || !remaining.length} onClick={() => void confirm()}>{busy ? '正在删除…' : `${Object.keys(failures).length ? '重试删除' : '确认删除'} ${remaining.length} 条记录`}</button></footer>
  </section></div>;
}
