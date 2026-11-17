import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LogsPanel } from './logs-panel';
import type { UserFailure } from '../shared/user-failure';

export function viewFailureLog(failure?: UserFailure) {
  window.dispatchEvent(new CustomEvent('workbench:view-logs', { detail: failure?.logRef || {} }));
}
/** Shared host also serves components which live outside the main view's modal tree. */
export function installErrorLogHost(api: { call<T = unknown>(action: string, payload?: unknown): Promise<T> }) {
  const element = document.createElement('div'); document.body.append(element);
  function Host() {
    const [reference, setReference] = useState<UserFailure['logRef']>();
    useEffect(() => { const listener = (event: Event) => setReference((event as CustomEvent).detail || {}); window.addEventListener('workbench:view-logs', listener); return () => window.removeEventListener('workbench:view-logs', listener); }, []);
    return reference ? <LogsPanel api={api} logRef={reference} close={() => setReference(undefined)}/> : null;
  }
  createRoot(element).render(<Host/>);
}
