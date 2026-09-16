import React, { useState } from 'react';
import { ChevronDown, ChevronRight, FolderTree, Plus, RefreshCw, ShieldCheck, UserRound, Users, X } from 'lucide-react';
import type { AdminSnapshot, AdminState, ManagedGroup, ManagedUser } from './types';
import type { Form } from './renderer';
import { memberReadiness } from './member-readiness';

type Open = (form: Form) => void;
export function PeopleManagement({ state, ready, busy, local, open, refresh }: { state: AdminState; ready: boolean; busy: boolean; local: boolean; open: Open; refresh: () => void }) {
  const [view, setView] = useState<'users' | 'groups'>('users');
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [collapsed, setCollapsed] = useState<string[]>([]);
  const users = Object.values(state.users).sort((a, b) => a.username.localeCompare(b.username));
  const groups = Object.values(state.groups).sort((a, b) => a.label.localeCompare(b.label));
  const query = search.trim().toLocaleLowerCase();
  const memberships = (user: ManagedUser) => groups.filter(g => user.groups?.includes(g.name));
  const matches = (user: ManagedUser) => (user.username + ' ' + user.name + ' ' + memberships(user).map(g => g.label + ' ' + g.name).join(' ')).toLocaleLowerCase().includes(query);
  const eligible = (user: ManagedUser) => filter === 'all' || (filter === 'unassigned' ? !memberships(user).length : filter === 'admins' ? memberships(user).some(g => user.contentAdminGroups?.includes(g.name)) : filter === 'enabled' ? user.enabled : !user.enabled);
  const visible = users.filter(u => matches(u) && eligible(u));
  const toggle = (key: string) => setCollapsed(values => values.includes(key) ? values.filter(v => v !== key) : [...values, key]);
  const rows = (list: ManagedUser[], group?: ManagedGroup) => <div className="people-table-scroll"><table><thead><tr><th>成员 / {local ? '模拟账号' : 'Linux 账号'}</th><th>状态</th><th>{group ? '本组角色 / 所属用户组' : '所属用户组与角色'}</th><th>管理操作</th></tr></thead><tbody>{list.map(user => <tr key={user.username} data-user={user.username}>
    <td><button className="person-link" disabled={!ready || user.missing || user.provisioning} onClick={() => open({ kind: 'groups', user })}><span className="admin-avatar"><UserRound size={17}/></span><span><b>{user.name || user.username}</b><code>{user.username}</code></span></button></td>
    <td><span className={'badge ' + (user.enabled ? 'done' : 'error')}>{user.missing ? '账号已变更' : user.provisioning ? '开通未完成' : user.enabled ? '已启用' : '已停用'}</span></td>
    <td>{group && <div className={'member-role ' + (user.contentAdminGroups?.includes(group.name) ? 'subadmin' : '')}>{user.contentAdminGroups?.includes(group.name) ? <><ShieldCheck size={13}/>本组子管理员</> : '本组普通成员'}</div>}<div className="membership-chips">{memberships(user).map(g => <button className={'group-chip ' + (user.contentAdminGroups?.includes(g.name) ? 'subadmin' : '')} key={g.name} disabled={!ready || user.missing || user.provisioning || g.provisioning} title={'管理 ' + g.label + ' 成员身份'} onClick={() => open({ kind: 'membership', group: g, user, role: user.contentAdminGroups?.includes(g.name) ? 'admin' : 'member' })}>{g.label}{user.contentAdminGroups?.includes(g.name) && <><ShieldCheck size={11}/>子管理员</>}</button>)}</div>{!memberships(user).length && <span className="unassigned-label">未分组</span>}</td>
    <td><small className="muted">{memberReadiness(state, user).join(' · ') || '开通完成，可导出配置'}</small><div className="people-actions">
      {group ? <><button className="text-button" disabled={!ready || user.missing || user.provisioning || group.provisioning} onClick={() => open({ kind: 'membership', user, group, role: user.contentAdminGroups?.includes(group.name) ? 'member' : 'admin' })}>{user.contentAdminGroups?.includes(group.name) ? '取消子管理员' : '设为子管理员'}</button><button className="text-button danger" disabled={!ready || user.missing || user.provisioning || group.provisioning} onClick={() => open({ kind: 'membership', user, group, role: 'remove' })}>移出本组</button></> : <><button className="text-button" disabled={!ready || user.missing || user.provisioning} onClick={() => open({ kind: 'membership', user })}>加入用户组</button><button className="text-button" disabled={!ready || user.missing || user.provisioning} onClick={() => open({ kind: 'groups', user })}>组与子管理员</button></>}
      <button className="text-button" disabled={!ready || memberReadiness(state, user).length > 0} onClick={() => open({ kind: 'export', user })}>导出连接配置</button><button className="text-button" disabled={!ready || user.missing || user.provisioning} onClick={() => open({ kind: 'password', user })}>重置密码</button><button className={'text-button ' + (user.enabled ? 'danger' : '')} disabled={!ready || user.missing || user.provisioning} onClick={() => open({ kind: 'enabled', user })}>{user.enabled ? '停用' : '启用'}</button>
    </div></td>
  </tr>)}</tbody></table>{!list.length && <div className="people-empty">{query || filter !== 'all' ? '没有符合筛选条件的成员' : group ? '此组暂无成员，可创建新用户或添加已有用户。' : '暂无成员，可独立创建用户，稍后再分配用户组。'}</div>}</div>;
  return <section className="people-management">
    <div className="people-toolbar"><div className="people-tabs" role="tablist" aria-label="用户管理视图"><button role="tab" aria-selected={view === 'users'} onClick={() => setView('users')}><Users size={16}/>全部用户</button><button role="tab" aria-selected={view === 'groups'} onClick={() => setView('groups')}><FolderTree size={16}/>按组查看</button></div><span className="spacer"/><button className="secondary compact" disabled={!ready} onClick={() => open({ kind: 'group' })}><Plus size={14}/>创建用户组</button><button className="secondary compact" disabled={busy} onClick={refresh}><RefreshCw size={14}/>刷新</button></div>
    <div className="people-filters"><input aria-label="查找成员或用户组" placeholder="查找账号、姓名或用户组" value={search} onChange={e => setSearch(e.target.value)}/><select aria-label="成员筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">所有成员</option><option value="unassigned">未分组</option><option value="admins">项目子管理员</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select><span className="muted small">{view === 'users' ? `${visible.length} / ${users.length} 位成员` : `${groups.length} 个用户组 · ${users.length} 位成员（可加入多个组）`}</span>{(query || filter !== 'all') && <button className="text-button" onClick={() => { setSearch(''); setFilter('all'); }}>清除筛选</button>}</div>
    {view === 'users' ? <section className="admin-table-card people-global" aria-label="全部用户列表">{rows(visible)}</section> : <div className="people-hierarchy">
      {groups.filter(g => !query || (g.label + ' ' + g.name).toLocaleLowerCase().includes(query) || users.some(u => u.groups?.includes(g.name) && matches(u))).map(g => {
        const members = users.filter(u => u.groups?.includes(g.name));
        const expanded = !collapsed.includes(g.name), available = ready && !!g.workspace && !g.provisioning;
        return <section className="admin-table-card group-section" key={g.name} data-group={g.name} aria-label={'用户组 ' + g.label}><header><button className="group-heading" aria-expanded={expanded} onClick={() => toggle(g.name)}>{expanded ? <ChevronDown size={18}/> : <ChevronRight size={18}/>}<FolderTree size={20}/><span><b>{g.label}</b><small>{g.name} · {g.workspace || '工作路径尚未准备'}</small></span></button><span className="group-count">{members.length} 位成员 · {members.filter(u => u.contentAdminGroups?.includes(g.name)).length} 位子管理员</span><span className="spacer"/>{!g.workspace && <button className="secondary compact" disabled={!ready} onClick={() => open({ kind: 'workspace', group: g })}>准备工作目录</button>}<button className="secondary compact" disabled={!available} onClick={() => open({ kind: 'create', group: g })}><Plus size={14}/>组内创建用户</button><button className="primary compact" disabled={!available} onClick={() => open({ kind: 'membership', group: g })}>添加已有用户</button></header>{expanded && rows(members.filter(u => eligible(u) && (matches(u) || (g.label + ' ' + g.name).toLocaleLowerCase().includes(query))), g)}</section>;
      })}
      {!groups.length && <div className="people-empty">还没有用户组。可以先创建用户，也可以先创建用户组。</div>}
      <section className="admin-table-card unassigned-section" data-group="unassigned"><header><h3>未分组用户</h3><span className="muted small">{users.filter(u => !memberships(u).length).length} 位 · 创建账号后，可在这里分配用户组</span></header>{rows(visible.filter(u => !memberships(u).length))}</section>
    </div>}
  </section>;
}

export function MembershipDialog({ form, snapshot, close, done }: { form: Form; snapshot: AdminSnapshot; close: () => void; done: () => Promise<void> }) {
  const groups = Object.values(snapshot.state?.groups || {}).filter(g => g.workspace && !g.provisioning);
  const users = Object.values(snapshot.state?.users || {}).filter(u => !u.missing && !u.provisioning);
  const [username, setUsername] = useState(form.user?.username || ''), [groupName, setGroupName] = useState(form.group?.name || '');
  const [role, setRole] = useState<'member' | 'admin' | 'remove'>(form.role || 'member');
  const [search, setSearch] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const selectedUser = users.find(u => u.username === username), selectedGroup = groups.find(g => g.name === groupName);
  const candidateGroups = groups.filter(g => !form.user || !form.user.groups?.includes(g.name) || form.group?.name === g.name);
  const candidates = users.filter(u => !u.groups?.includes(groupName) && (u.username + ' ' + u.name).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const removing = role === 'remove';
  const title = form.user && form.group ? '管理组成员' : form.user ? '将用户加入已有组' : '向组添加已有用户';
  const submit = async () => {
    setBusy(true); setError('');
    try { await window.admin.call('operation', { op: 'group_member', username, group: groupName, role }); await done(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><section className="modal membership-dialog"><header><h2>{title}</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}><X size={19}/></button></header><div className="modal-body">
    {error && <div className="inline-error" role="alert">{error}</div>}
    {form.user ? <div className="member-summary"><UserRound size={24}/><div><b>{form.user.name}</b><code>{form.user.username}</code><small>当前所属组：{groups.filter(g => form.user!.groups?.includes(g.name)).map(g => g.label).join('、') || '未分组'}</small></div></div> : <><label className="field">查找已有用户<input aria-label="查找已有用户" value={search} onChange={e => setSearch(e.target.value)} placeholder="账号或姓名"/></label><div className="member-candidates">{candidates.map(u => <label className="check-row" key={u.username}><input type="radio" name="existing-user" aria-label={'选择用户 ' + u.username} checked={username === u.username} onChange={() => setUsername(u.username)}/><span><b>{u.name}</b> <code>{u.username}</code><small>{u.enabled ? '已启用' : '已停用'} · 已加入：{groups.filter(g => u.groups?.includes(g.name)).map(g => g.label).join('、') || '未分组'}</small></span></label>)}{!candidates.length && <p className="muted">{search ? '没有匹配的可添加用户' : '暂无可添加用户，已有用户均已加入本组。'}</p>}</div></>}
    {form.group ? <p>目标用户组：<b>{form.group.label}</b> <code>{form.group.name}</code></p> : <label className="field">选择已有用户组<select aria-label="选择已有用户组" value={groupName} onChange={e => setGroupName(e.target.value)}><option value="">请选择用户组</option>{candidateGroups.map(g => <option key={g.name} value={g.name}>{g.label}</option>)}</select>{!candidateGroups.length && <small>暂无可加入的用户组，请先创建用户组。</small>}</label>}
    <label className="field">成员身份<select aria-label="成员身份" value={role} onChange={e => setRole(e.target.value as typeof role)}><option value="member">普通成员</option><option value="admin">项目子管理员（仅本组）</option>{form.user && form.group && <option value="remove">移出此组</option>}</select></label>
    <div className={'callout ' + (removing ? 'membership-removal' : '')}><div>{removing ? '解除该用户与此组的关系，并撤销本组子管理员权限。' : role === 'admin' ? '加入该组，并获得对应工作路径的项目创建和内容管理权限。' : '加入该组，获得对应项目组工作路径的访问权限。'}<small>{removing ? '保留用户账号、其他组身份，以及已上传的成果和轨迹。' : '子管理员权限按组授予；管理用户和任命管理员仍由总管理员操作。'}</small><small>{snapshot.profile?.mode === 'local' ? '权限变更在下一次共享操作时生效。' : '执行后将断开此用户的旧共享连接，重新登录后应用最新权限。'}</small></div></div>
  </div><footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy || !selectedUser || !selectedGroup} onClick={() => void submit()}>{busy ? '执行中…' : '确认执行'}</button></footer></section></div>;
}
