import React, { useSyncExternalStore } from 'react';
import type { SessionInput } from '../shared/types';

const emptyInput: SessionInput = { text: '', sourceIds: [], answers: {}, capabilities: [] };
/** Account-view scoped: a keystroke notifies only the matching composer. */
export class SessionInputDrafts {
  private listeners = new Map<string, Set<() => void>>();
  private errors = new Map<string, string>();
  private revisions = new Map<string, number>();
  constructor(readonly inputs: Record<string, SessionInput> = {}) {}
  read(id: string, initial?: SessionInput) { return this.inputs[id] || initial || emptyInput; }
  subscribe(id: string, listener: () => void) {
    const listeners = this.listeners.get(id) || new Set(); this.listeners.set(id, listeners); listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  private emit(id: string) { this.listeners.get(id)?.forEach(listener => listener()); }
  error(id: string) { return this.errors.get(id) || ''; }
  async flush(id: string, save: () => Promise<unknown>) {
    const revision = this.revisions.get(id);
    try { await save(); if (this.revisions.get(id) === revision && this.errors.delete(id)) this.emit(id); }
    catch (error) { if (this.revisions.get(id) === revision) { this.errors.set(id, '输入保存失败，请保留当前窗口并重试：' + (error as Error).message); this.emit(id); } throw error; }
  }
  write(id: string, input: SessionInput, save: () => Promise<unknown>) {
    const revision = (this.revisions.get(id) || 0) + 1; this.revisions.set(id, revision);
    this.inputs[id] = input; this.errors.delete(id); this.emit(id);
    void save().then(() => {
      if (this.revisions.get(id) === revision && this.errors.delete(id)) this.emit(id);
    }, (error: Error) => {
      if (this.revisions.get(id) !== revision) return;
      this.errors.set(id, '输入保存失败，请保留当前窗口并重试：' + error.message); this.emit(id);
    });
  }
}

export function useSessionInputDraft(drafts: SessionInputDrafts, id: string, initial?: SessionInput) {
  const read = () => drafts.read(id, initial), readError = () => drafts.error(id);
  const input = useSyncExternalStore(listener => drafts.subscribe(id, listener), read, read);
  const error = useSyncExternalStore(listener => drafts.subscribe(id, listener), readError, readError);
  return { input, error };
}

export function SessionInputDraft({ drafts, id, initial, children }: {
  drafts: SessionInputDrafts; id: string; initial?: SessionInput;
  children: (input: SessionInput, error: string) => React.ReactNode;
}) {
  const { input, error } = useSessionInputDraft(drafts, id, initial);
  return <>{children(input, error)}</>;
}
