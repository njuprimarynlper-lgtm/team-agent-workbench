import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ContextAction { label: string; run: () => void | Promise<unknown>; disabled?: boolean; danger?: boolean; separator?: boolean }
export interface ContextAnchor { x: number; y: number; target: HTMLElement }
export function contextAnchor(event: React.MouseEvent<HTMLElement>): ContextAnchor {
  event.preventDefault(); event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: event.clientX || rect.left, y: event.clientY || rect.bottom, target: event.currentTarget };
}

export function ContextMenu({ anchor, label, actions, close }: { anchor: ContextAnchor; label: string; actions: ContextAction[]; close: () => void }) {
  const panel = useRef<HTMLDivElement>(null), [point, setPoint] = useState(anchor), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const closeRef = useRef(close); closeRef.current = close;
  useLayoutEffect(() => {
    const rect = panel.current!.getBoundingClientRect();
    setPoint({ ...anchor, x: Math.max(8, Math.min(anchor.x, innerWidth - rect.width - 8)), y: Math.max(8, Math.min(anchor.y, innerHeight - rect.height - 8)) });
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [anchor]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) closeRef.current(); };
    const dismiss = () => closeRef.current();
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', dismiss);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', dismiss); };
  }, []);
  const dismiss = () => { close(); if (anchor.target.isConnected) anchor.target.focus(); };
  return createPortal(<div ref={panel} role="menu" aria-label={label} className="interaction-context-menu" style={{ left: point.x, top: point.y }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); dismiss(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const items = [...panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? items.length - 1 : 1)) % items.length]?.focus();
    }
  }}>{actions.map((item, index) => <React.Fragment key={item.label}>{item.separator && index > 0 && <hr role="separator"/>}<button type="button" role="menuitem" className={item.danger ? 'danger' : ''} disabled={busy || item.disabled} onClick={async () => {
    setBusy(true); setError('');
    try { const result = item.run(); if (result && typeof result.then === 'function') await result; close(); }
    catch (reason: any) { setError(reason.message || '操作失败，请重试'); }
    finally { setBusy(false); }
  }}>{item.label}</button></React.Fragment>)}{error && <p className="interaction-context-error" role="alert">{error}</p>}</div>, document.body);
}
