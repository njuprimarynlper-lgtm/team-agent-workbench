import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { AgentSession, WorkbenchAPI } from '../shared/types';
import { cursorSharedSessionUnavailable, isCursorFileSession } from '../shared/cursor-session-consistency';
import { NativeDesktopControls } from './native-desktop-controls';

function syncPresentation(session: AgentSession) {
  let tone = 'independent', label = '非同步会话', detail = '当前仅在工作台继续对话。';
  const linked = session.codexDesktop || session.codexRemote || isCursorFileSession(session);
  if (session.cursorNative && !isCursorFileSession(session)) {
    label = '仅查看'; detail = cursorSharedSessionUnavailable;
  } else if (linked || session.codexSyncRequest || session.provider === 'codex' && session.desktopSyncState === 'connecting') {
    tone = 'waiting';
    if (session.codexSyncRequest && !session.codexDesktop) {
      label = session.codexSyncRequest.error ? '同步待处理' : '同步待连接';
      detail = session.codexSyncRequest.error || '已安排同步，可继续工作。退出 Codex 后，在当前回复结束时接入；需要时由你打开 Codex。';
    } else if (session.desktopSyncState === 'disconnected') {
      label = '同步已断开'; detail = '连接已断开，可点击“恢复同步”重新连接。';
    } else if (session.desktopSyncState === 'connecting') {
      label = '同步连接中'; detail = '正在连接，尚未确认同步完成。';
    } else if (session.desktopSyncPending) {
      label = '补齐记录中'; detail = '已连接，正在补齐完整对话记录。';
    } else if (session.desktopSyncState === 'connected') {
      tone = 'connected'; label = '同步会话';
      detail = session.codexRemote ? `已连接远程会话：${session.codexRemote.hostName}。` : `当前与 ${session.provider === 'cursor' ? 'Cursor' : 'Codex'} 原生会话同步。`;
    } else {
      label = '同步待连接'; detail = '已开启同步，尚未建立连接。';
    }
  }
  return { tone, label, detail };
}

/** The ring reflects confirmed runtime state; the switch only changes the preference. */
export function SessionSyncFrame({ session, api, changed, locked = false, children }: {
  session: AgentSession; api: WorkbenchAPI; changed: () => Promise<unknown>; locked?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), pending = useRef(false);
  const panelId = useId(), noteId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  if (session.closedAt || session.purpose !== 'work') return <>{children}</>;
  const { tone, label, detail } = syncPresentation(session);
  const localCodex = session.provider === 'codex' && !session.codexRemote;
  const enabled = !!(session.codexDesktop || session.codexSyncRequest);
  const active = locked || ['starting', 'running', 'approval'].includes(session.status);
  const connecting = session.desktopSyncState === 'connecting';
  const unavailable = !enabled && session.networkRoute === 'management';
  const disabled = busy || active || connecting || unavailable;
  const note = busy ? '正在更新同步设置…' : active && localCodex ? '当前操作结束后可更改同步。'
    : connecting ? detail : localCodex && unavailable ? '当前使用管理端访问，暂不支持桌面同步。'
    : localCodex && session.codexDesktop ? `${detail} 关闭后两端各自继续，已有记录保留。`
    : localCodex && !enabled ? '开启后可在工作台与 Codex 桌面版继续同一条对话。' : detail;
  const perform = async (work: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await work(); await changed(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  const toggle = () => {
    if (disabled) return;
    const action = session.codexDesktop ? 'session.codexDesktop.disable' : session.codexSyncRequest ? 'session.codexDesktop.cancel' : 'session.codexDesktop.sync';
    void perform(() => api.call(action, { id: session.id }));
  };
  return <div className="session-sync-frame" data-state={tone} aria-label="输入框同步状态">
    <button ref={trigger} type="button" className="session-sync-tab" aria-expanded={open} aria-controls={panelId} aria-label={`${label}，${localCodex ? '调整桌面同步' : '查看同步状态'}`} title={detail} onClick={() => setOpen(value => !value)}>
      <span className="session-sync-dot" aria-hidden="true"/><span aria-live="polite">{label}</span><ChevronDown size={12} aria-hidden="true"/>
    </button>
    <div ref={panel} id={panelId} className="session-sync-options" role="region" aria-label="桌面同步设置" hidden={!open}>
      {localCodex && <div className="session-sync-switch-row"><span>与 Codex 桌面版同步</span><button type="button" className="session-sync-toggle" role="switch" aria-label="与 Codex 桌面版同步" aria-checked={enabled} aria-describedby={noteId} disabled={disabled} onClick={toggle}><span aria-hidden="true"/></button></div>}
      <p id={noteId} className="session-sync-note" role="status">{note}</p>
      {error && <p className="session-sync-error" role="alert">{error}</p>}
      {open && <div className="session-sync-actions"><NativeDesktopControls session={session} run={perform} showStatus={false}/></div>}
    </div>
    {children}
  </div>;
}
