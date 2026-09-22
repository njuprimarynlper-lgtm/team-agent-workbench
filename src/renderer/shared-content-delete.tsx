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
    <div className="modal-body"><p>将从团队项目成果库删除以下 {items.length} 项，同组成员将无法再从共享区查看或引用，删除后不能从成果库恢复。</p>
      <ul className="delete-selection-list">{items.map(item => <li key={item.id}>{title(item)} <small>· {item.author} · v{item.revision}</small></li>)}</ul>
      <p className="muted small">已保存的本地成果、会话引用和整理记录保留。删除合并结果不会恢复被合并的来源。</p>
      <p className="muted small">逐项校验版本和权限；中途失败会停止后续删除，并显示已完成和未完成的数量。</p>
      {error && <div className="inline-error" role="alert">{error}</div>}
    </div><footer><button className="secondary" autoFocus disabled={busy} onClick={close}>取消</button><button className="primary danger" disabled={busy || !items.length || items.length > 100} onClick={confirm}>{busy ? '正在删除…' : `确认删除 ${items.length} 项团队成果`}</button></footer>
  </section></div>;
}
