import React from 'react';
import { RefreshCw } from 'lucide-react';

export function ProjectRefreshButton({ connected, busy, refresh }: { connected: boolean; busy: boolean; refresh: () => void }) {
  return <button className="icon" aria-label="刷新项目和文件" title={busy ? '正在刷新项目' : connected ? '刷新项目和文件' : '连接中央节点并刷新项目'} disabled={busy} onClick={refresh}><RefreshCw size={15} className={busy ? 'spin' : ''}/></button>;
}
