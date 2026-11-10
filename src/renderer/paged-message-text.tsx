import React, { useState } from 'react';

export const messageTextPageSize = 24_000;

export function PagedMessageText({ text, render }: { text: string; render: (part: string) => React.ReactNode }) {
  const [selected, setSelected] = useState(0);
  if (text.length <= messageTextPageSize) return <>{render(text)}</>;
  const pages = Math.ceil(text.length / messageTextPageSize), page = Math.min(selected, pages - 1);
  const part = text.slice(page * messageTextPageSize, (page + 1) * messageTextPageSize);
  return <div className="paged-message-text">
    <div className="paged-message-controls" aria-label="长消息分段">
      <button type="button" className="text-button" disabled={page === 0} onClick={() => setSelected(page - 1)}>上一段</button>
      <span>第 {page + 1} / {pages} 段</span>
      <button type="button" className="text-button" disabled={page + 1 >= pages} onClick={() => setSelected(page + 1)}>下一段</button>
    </div>
    {render(part)}
  </div>;
}
