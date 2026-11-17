import { contextualError } from './contextual-error';
import { uiErrorMessage } from '../shared/user-failure';
import React, { useSyncExternalStore } from 'react';
import type { SessionInput } from '../shared/types';

const emptyInput: SessionInput = { text: '', sourceIds: [], answers: {}, capabilities: [] };
/** Account-view scoped: a keystroke notifies only the matching composer. */
export class SessionInputDrafts {
  private listeners = new Map<string, Set<() => void>>();
  private errors = new Map<string, string>();
  private revisions = new Map<string, number>();
  private statusListeners = new Set<() => void>();
  unsavedCount() { return this.errors.size; }
  subscribeStatus(listener: () => void) { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener); }; }
  constructor(readonly inputs: Record<string, SessionInput> = {}) {}
  read(id: string, initial?: SessionInput) { return this.inputs[id] || initial || emptyInput; }
  subscribe(id: string, listener: () => void) {
    const listeners = this.listeners.get(id) || new Set(); this.listeners.set(id, listeners); listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  private emit(id: string) { this.listeners.get(id)?.forEach(listener => listener()); this.statusListeners.forEach(listener => listener()); }
  error(id: string) { return this.errors.get(id) || ''; }
  async flush(id: string, save: () => Promise<unknown>) {
    const revision = this.revisions.get(id);
    try { await save(); if (this.revisions.get(id) === revision && this.errors.delete(id)) this.emit(id); }
    catch (error) { if (this.revisions.get(id) === revision) { this.errors.set(id, contextualError(error, { domain: 'local', operation: '保存输入草稿' }, { STORAGE_FULL: '草稿没保存：这台电脑的磁盘已满。请先保留此窗口，释放空间后再保存草稿。', FILE_ACCESS_DENIED: '草稿没保存：Windows 不允许写入草稿文件。请先保留此窗口，检查文件权限后再保存。', UNCLASSIFIED_FAILURE: '这次没能保存草稿。输入还在这个窗口里，请先保留窗口，再试一次保存。' })); this.emit(id); } throw error; }
  }
  write(id: string, input: SessionInput, save: () => Promise<unknown>) {
    const revision = (this.revisions.get(id) || 0) + 1; this.revisions.set(id, revision);
    this.inputs[id] = input; this.errors.delete(id); this.emit(id);
    void save().then(() => {
      if (this.revisions.get(id) === revision && this.errors.delete(id)) this.emit(id);
    }, (error: Error) => {
      if (this.revisions.get(id) !== revision) return;
      this.errors.set(id, contextualError(error, { domain: 'local', operation: '保存输入草稿' }, { STORAGE_FULL: '草稿没保存：这台电脑的磁盘已满。请先保留此窗口，释放空间后再保存草稿。', FILE_ACCESS_DENIED: '草稿没保存：Windows 不允许写入草稿文件。请先保留此窗口，检查文件权限后再保存。', UNCLASSIFIED_FAILURE: '这次没能保存草稿。输入还在这个窗口里，请先保留窗口，再试一次保存。' })); this.emit(id);
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


/** Only the save-error count subscribes globally; typing still updates its own composer. */
export function InputDraftSaveStatus({ drafts, children }: { drafts: SessionInputDrafts; children: React.ReactNode }) {
  const count = useSyncExternalStore(listener => drafts.subscribeStatus(listener), () => drafts.unsavedCount(), () => drafts.unsavedCount());
  return count ? <span className="inline-error">{count} 份输入草稿未保存</span> : <>{children}</>;
}
