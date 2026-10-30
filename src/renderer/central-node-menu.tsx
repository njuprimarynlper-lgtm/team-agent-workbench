import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import type { Snapshot } from '../shared/types';

interface LoginControls {
  fresh: boolean;
  close: () => void;
  setBusy: (busy: boolean) => void;
}

export function CentralNodeMenu({ connection, busy = false, loginRequest = 0, renderLogin }: {
  connection: Snapshot['connection'];
  busy?: boolean;
  loginRequest?: number;
  renderLogin: (controls: LoginControls) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false), [login, setLogin] = useState(false), [fresh, setFresh] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null);
  const panelId = useId(), blocked = busy || loginBusy;
  const connected = !!connection?.connected, profile = connection?.profile;
  const showLogin = !connected || login;
  const name = profile?.name || profile?.host || '中央节点';
  const close = () => { setOpen(false); setLogin(false); setFresh(false); trigger.current?.focus(); };

  useEffect(() => {
    if (!loginRequest) return;
    setFresh(false); setLogin(true); setOpen(true);
  }, [loginRequest]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!blocked && !root.current?.contains(event.target as Node)) { setOpen(false); setLogin(false); setFresh(false); } };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || blocked || document.querySelector('.modal-backdrop')) return;
      event.preventDefault(); close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, blocked]);
  useEffect(() => {
    if (open) (panel.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled)') || panel.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
  }, [open, showLogin, fresh]);

  return <div className="central-node-menu" ref={root}>
    <button type="button" className="central-node-trigger" ref={trigger} disabled={blocked} aria-expanded={open} aria-controls={panelId} aria-haspopup="dialog" title={connected && profile ? `${profile.host}:${profile.port} · ${profile.username}` : '登录后查看你加入的项目'} onClick={() => { if (open) close(); else { setFresh(false); setLogin(false); setOpen(true); } }}>
      <span className={'central-node-dot' + (connected ? ' online' : '')} aria-hidden="true"/>
      <span className="central-node-trigger-label">{connected ? `中央节点 · ${name}` : '连接中央节点'}</span><ChevronDown size={13}/>
    </button>
    {open && <section id={panelId} ref={panel} className="central-node-panel" role="dialog" aria-label={showLogin ? '登录中央节点' : '中央节点'} aria-busy={blocked}>
      <header className="central-node-panel-head"><strong>{showLogin ? '登录中央节点' : '中央节点'}</strong><button type="button" className="icon" aria-label="关闭中央节点面板" disabled={blocked} onClick={close}><X size={16}/></button></header>
      {showLogin ? renderLogin({ fresh, close, setBusy: setLoginBusy }) : profile && <>
        <div className="central-node-current">
          <div className="central-node-name-row"><strong>{name}</strong><span className="central-node-state">已登录</span></div>
          <div className="central-node-address">{profile.host}:{profile.port}</div>
          <div className="central-node-member"><span className="central-node-avatar" aria-hidden="true">{Array.from(profile.username)[0]?.toUpperCase()}</span><span>{profile.username}</span><span className="central-node-current-tag">当前窗口</span></div>
          <div className="central-node-permissions"><span>可访问项目</span><strong>{profile.projects.length} 个</strong></div>
          <p className="central-node-hint">{profile.projects.length ? '项目已列在左侧，资料同步按项目单独开启。' : '暂未发现可访问项目，可联系管理员核对授权后刷新。'}</p>
          {connection?.workspaces.some(workspace => workspace.accessError) && <p className="inline-error" role="status">部分项目读取失败，请刷新列表后重试。</p>}
        </div>
        <footer className="central-node-panel-footer"><button type="button" className="central-node-add" disabled={blocked} onClick={() => { setFresh(true); setLogin(true); }}><Plus size={14}/>连接其他中央节点</button><span>不同节点或账号在独立窗口打开</span></footer>
      </>}
    </section>}
  </div>;
}
