import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Database, Folder, FolderOpen, HardDrive, RefreshCw, Square, Users, X } from 'lucide-react';
import type { AdminState, StorageCategoryKey, StorageUsageReport } from './types';

const colors: Record<StorageCategoryKey, string> = {
  submissions: '#3976a8', trajectories: '#8a63b8', curated: '#36a47b', project: '#62a6b8', system: '#95a2ad', unassigned: '#d49a45',
};
const formatBytes = (bytes = 0) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`;
};
const formatTime = (value?: string) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
const percent = (value: number, total: number) => total > 0 ? Math.min(100, value / total * 100) : 0;

export function StorageView({ active, enabled, identity, state }: { active: boolean; enabled: boolean; identity: string; state?: AdminState }) {
  const [summary, setSummary] = useState<StorageUsageReport>();
  const [folder, setFolder] = useState<StorageUsageReport>();
  const [tab, setTab] = useState<'groups' | 'users' | 'folders'>('groups');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [autoScanned, setAutoScanned] = useState(false);
  useEffect(() => { setSummary(undefined); setFolder(undefined); setError(''); setAutoScanned(false); }, [identity]);
  const scan = async (path = '', append = false, offset = 0) => {
    setBusy(true); setError('');
    try {
      const result = await window.admin.call<StorageUsageReport>('storage.scan', { path, offset, limit: 100 });
      if (!path) setSummary(result);
      setFolder(current => append && current?.path === result.path ? { ...result, children: [...current.children, ...result.children] } : result);
    } catch (reason: any) { setError(reason.message || '空间统计失败'); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (active && enabled && !summary && !busy && !autoScanned) { setAutoScanned(true); void scan(); } }, [active, enabled, summary, busy, autoScanned]);
  const cancel = async () => { try { await window.admin.call('storage.cancel'); } catch (reason: any) { setError(reason.message || '取消统计失败'); } };
  const root = summary;
  const totalCategories = root?.categories.reduce((sum, item) => sum + item.bytes, 0) || 0;
  const donut = useMemo(() => {
    if (!root || !totalCategories) return '#e7ebef';
    let cursor = 0;
    const stops = root.categories.filter(item => item.bytes > 0).map(item => {
      const start = cursor; cursor += item.bytes / totalCategories * 100;
      return `${colors[item.key]} ${start}% ${cursor}%`;
    });
    return `conic-gradient(${stops.join(',')})`;
  }, [root, totalCategories]);
  const volumeUsed = root?.volume.totalBytes ? root.volume.totalBytes - root.volume.freeBytes : 0;
  const groupLabels = new Map(Object.entries(state?.groups || {}).map(([id, group]) => [id, group.label]));
  const crumbs = folder?.path ? folder.path.split('/').map((name, index, all) => ({ name, path: all.slice(0, index + 1).join('/') })) : [];

  if (!enabled) return <div className="admin-connect-card"><HardDrive size={36}/><h2>共享空间</h2><p>连接并初始化团队空间后，可以查看容量和目录占用。</p></div>;
  return <section className="storage-view" aria-label="共享空间管理">
    <div className="page-title storage-title"><div><span className="eyebrow">SHARED STORAGE</span><h1>共享空间</h1><p>统计团队共享目录中的文件占用，不包含成员本机目录或 Linux Home。</p></div><div className="storage-actions">{root && <span className="storage-scanned">统计于 {formatTime(root.scannedAt)}</span>}{busy ? <button className="secondary" onClick={() => void cancel()}><Square size={14}/>取消统计</button> : <button className="primary" onClick={() => void scan()}><RefreshCw size={15}/>刷新统计</button>}</div></div>
    {error && <div className="inline-error admin-alert" role="alert"><span>{error}</span><button className="icon" aria-label="关闭错误" onClick={() => setError('')}><X size={17}/></button></div>}
    {busy && <div className="storage-loading"><span className="spinner"/>正在统计共享空间，可以继续切换页面。</div>}
    {!root && !busy ? <div className="storage-empty"><HardDrive size={42}/><h3>还没有空间统计</h3><button className="primary" onClick={() => void scan()}>开始统计</button></div> : root && <>
      <div className="storage-stat-grid">
        <div className="storage-stat primary-stat"><span>共享文件总量</span><strong>{formatBytes(root.total.bytes)}</strong><small>{root.total.files.toLocaleString()} 个文件 · {root.total.directories.toLocaleString()} 个目录</small></div>
        <div className="storage-stat"><span>磁盘剩余</span><strong>{root.volume.totalBytes ? formatBytes(root.volume.freeBytes) : '不可用'}</strong><small>{root.volume.totalBytes ? `总容量 ${formatBytes(root.volume.totalBytes)}` : '服务器未返回磁盘容量'}</small></div>
        <div className="storage-stat"><span>项目组</span><strong>{root.groups.length}</strong><small>{root.groups.reduce((sum, group) => sum + group.projects, 0)} 个已登记项目</small></div>
        <div className="storage-stat"><span>成员共享占用</span><strong>{formatBytes(root.users.reduce((sum, user) => sum + user.bytes, 0))}</strong><small>{root.users.filter(user => user.bytes > 0).length} 位成员有共享内容</small></div>
      </div>
      <div className="storage-overview-grid">
        <section className="storage-card storage-category-card"><header><div><h3>内容构成</h3><small>按共享目录用途归类</small></div></header><div className="storage-category-body"><div className="storage-donut" style={{ background: donut }}><div><strong>{formatBytes(root.total.bytes)}</strong><span>共享文件</span></div></div><div className="storage-legend">{root.categories.map(item => <div key={item.key}><i style={{ background: colors[item.key] }}/><span>{item.label}</span><b>{formatBytes(item.bytes)}</b><small>{percent(item.bytes, root.total.bytes).toFixed(1)}%</small></div>)}</div></div></section>
        <section className="storage-card storage-volume-card"><header><div><h3>磁盘容量</h3><small>共享空间所在磁盘或分区</small></div></header>{root.volume.totalBytes ? <><div className="capacity-number"><strong>{percent(volumeUsed, root.volume.totalBytes).toFixed(1)}%</strong><span>已使用</span></div><div className="capacity-track"><i style={{ width: `${percent(volumeUsed, root.volume.totalBytes)}%` }}/></div><div className="capacity-labels"><span>已用 {formatBytes(volumeUsed)}</span><span>剩余 {formatBytes(root.volume.freeBytes)}</span></div></> : <div className="capacity-unavailable">当前环境无法读取磁盘容量，目录占用统计不受影响。</div>}{root.warningCount > 0 && <div className="storage-warning"><AlertTriangle size={16}/><span>{root.warningCount} 个路径未能完整统计</span><details><summary>查看</summary>{root.warnings.map((warning, index) => <p key={index}><code>{warning.path || '/'}</code>{warning.message}</p>)}</details></div>}</section>
      </div>
      <div className="storage-tabs" role="tablist" aria-label="空间占用视图"><button role="tab" aria-selected={tab === 'groups'} onClick={() => setTab('groups')}><Database size={16}/>项目组</button><button role="tab" aria-selected={tab === 'users'} onClick={() => setTab('users')}><Users size={16}/>用户</button><button role="tab" aria-selected={tab === 'folders'} onClick={() => setTab('folders')}><FolderOpen size={16}/>文件夹</button></div>
      {tab === 'groups' && <GroupUsage report={root}/>} 
      {tab === 'users' && <section className="storage-card storage-table-card"><header><div><h3>用户占用</h3><small>只统计成员成果和轨迹；团队整理内容归项目组公共空间</small></div></header><div className="storage-table-scroll"><table><thead><tr><th>用户</th><th>所属项目组</th><th>成果提交</th><th>轨迹</th><th>合计</th><th>文件数</th><th>最近变化</th></tr></thead><tbody>{root.users.map(user => <tr key={user.username}><td><b>{user.name}</b><code>{user.username}</code></td><td><div className="storage-chips">{user.groups.map(id => <span key={id}>{groupLabels.get(id) || id}</span>)}</div></td><td>{formatBytes(user.submissionsBytes)}</td><td>{formatBytes(user.trajectoriesBytes)}</td><td><b>{formatBytes(user.bytes)}</b></td><td>{user.files.toLocaleString()}</td><td>{formatTime(user.modifiedAt)}</td></tr>)}</tbody></table>{!root.users.length && <div className="storage-no-rows">暂无团队成员</div>}</div></section>}
      {tab === 'folders' && folder && <section className="storage-card storage-folders"><header><div><h3>文件夹占用</h3><div className="storage-breadcrumb"><button disabled={busy} onClick={() => void scan('')}>共享空间</button>{crumbs.map(crumb => <React.Fragment key={crumb.path}><ChevronRight size={13}/><button disabled={busy} onClick={() => void scan(crumb.path)}>{crumb.name}</button></React.Fragment>)}</div></div><span className="spacer"/><span className="folder-total">当前目录 {formatBytes(folder.total.bytes)}</span></header><div className="storage-table-scroll"><table><thead><tr><th>文件夹</th><th>递归占用</th><th>目录直属文件</th><th>文件数</th><th>子目录数</th><th>最近变化</th></tr></thead><tbody>{folder.children.map(item => <tr key={item.path}><td><button className="folder-link" disabled={busy} onClick={() => void scan(item.path)}><Folder size={18}/><span>{item.name}<small>{item.path}</small></span><ChevronRight size={15}/></button></td><td><b>{formatBytes(item.bytes)}</b></td><td>{formatBytes(item.directBytes)}</td><td>{item.files.toLocaleString()}</td><td>{item.directories.toLocaleString()}</td><td>{formatTime(item.modifiedAt)}</td></tr>)}</tbody></table>{!folder.children.length && <div className="storage-no-rows">当前目录没有子文件夹 · 直属文件占用 {formatBytes(folder.total.directBytes)}</div>}</div>{folder.children.length < folder.childCount && <footer><button className="secondary" disabled={busy} onClick={() => void scan(folder.path, true, folder.children.length)}>加载更多（已显示 {folder.children.length} / {folder.childCount}）</button></footer>}</section>}
    </>}
  </section>;
}

function GroupUsage({ report }: { report: StorageUsageReport }) {
  const maximum = Math.max(...report.groups.map(group => group.bytes), 1);
  return <section className="storage-card storage-group-card"><header><div><h3>项目组占用</h3><small>总量包含成员提交、轨迹、团队整理和项目公共文件</small></div></header><div className="group-usage-list">{report.groups.map(group => <article key={group.id}><div className="group-usage-heading"><span><b>{group.label}</b><small>{group.members} 位成员 · {group.projects} 个项目</small></span><strong>{formatBytes(group.bytes)}</strong></div><div className="usage-track"><i style={{ width: `${group.bytes / maximum * 100}%` }}/></div><div className="usage-breakdown"><span>成员成果 {formatBytes(group.submissionsBytes)}</span><span>轨迹 {formatBytes(group.trajectoriesBytes)}</span><span>团队整理 {formatBytes(group.curatedBytes)}</span><span>项目公共 {formatBytes(group.projectBytes)}</span>{group.unassignedBytes > 0 && <span className="unassigned">未归属 {formatBytes(group.unassignedBytes)}</span>}</div></article>)}{!report.groups.length && <div className="storage-no-rows">暂无已准备共享目录的项目组</div>}</div></section>;
}
