import React from 'react';
import { canDeleteSharedContent, type SharedContent } from '../shared/content';

export function sharedDeleteSelection(visible: SharedContent[], selectedIds: string[], username: string, admin: boolean) {
  const eligible = visible.filter(item => canDeleteSharedContent(item, username, admin));
  return { eligible, selected: eligible.filter(item => selectedIds.includes(item.id)) };
}

export function SharedContentDeleteDialog({ items, title, busy, error, close, confirm }: {
  items: SharedContent[]; title: (item: SharedContent) => string; busy: boolean; error: string; close: () => void; confirm: () => void;
}) {
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="bulk-delete-shared-title">
    <header><h2 id="bulk-delete-shared-title">确认批量删除团队成果？</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}>×</button></header>
    <div className="modal-body"><p>将删除以下 {items.length} 项团队成果。同组成员将无法再从团队成果库查看或引用；正文和历史版本无法从库中恢复。</p>
      <ul className="delete-selection-list">{items.map(item => <li key={item.id}>{title(item)} <small>· {item.author} · v{item.revision}</small></li>)}</ul>
      <p className="muted small">已保存的个人副本、本机整理记录、已发送的对话内容及任务和子会话的固定快照保留。其他尚未发送的成果引用，在检测到删除后不再发送给模型。</p>
      <p className="muted small">删除合并成果不会自动恢复被它替代的来源成果。中途失败时停止后续删除，并显示已完成和未完成的数量。</p>
      {error && <div className="inline-error" role="alert">{error}</div>}
    </div><footer><button className="secondary" autoFocus disabled={busy} onClick={close}>取消</button><button className="primary danger" disabled={busy || !items.length || items.length > 100} onClick={confirm}>{busy ? '正在删除…' : `确认删除 ${items.length} 项团队成果`}</button></footer>
  </section></div>;
}
