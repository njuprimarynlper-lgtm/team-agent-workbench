import React, { useState } from 'react';
import type { Draft } from '../shared/types';

export function DraftDeleteDialog({ draft, remove, close }: { draft: Draft; remove: () => Promise<void>; close: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-draft-title">
    <header><h2 id="delete-draft-title">删除整理记录？</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}>×</button></header>
    <div className="modal-body"><p>删除“{draft.titleAlias || draft.title}”的整理记录{draft.generation === 'running' ? '，并停止这次整理' : ''}。</p><p className="muted small">本地成果、团队成果、原 Session 和增量整理进度都会保留。已提交的上传仍可在传输列表查看和重试。记录删除会同步到你的其他电脑。</p>{error && <p className="inline-error" role="alert">{error}</p>}</div>
    <footer><button className="secondary" autoFocus disabled={busy} onClick={close}>取消</button><button className="primary danger" disabled={busy} onClick={async () => { if (busy) return; setBusy(true); setError(''); try { await remove(); } catch (error: any) { setError(error.message); setBusy(false); } }}>{busy ? '正在删除…' : '删除记录'}</button></footer>
  </section></div>;
}
