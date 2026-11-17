import React from 'react';
import type { UserFailure } from '../shared/user-failure';
const references = new Map<string, UserFailure>();
export function rememberFailure(failure: UserFailure) {
  if (failure?.version !== 1 || typeof failure.message !== 'string') return;
  const previous = references.get(failure.message);
  // Two unrelated operations may have the same public wording. Never open a
  // different operation's log merely because its message happens to match.
  references.set(failure.message, previous && previous.logRef?.operationId !== failure.logRef?.operationId ? { ...failure, logRef: undefined } : failure);
  while (references.size > 200) references.delete(references.keys().next().value!);
}
/** Read public metadata without allowing callers to change the retained reference. */
export function getRememberedFailure(message: string): UserFailure | undefined {
  const failure = references.get(message);
  return failure ? { ...failure, ...(failure.logRef ? { logRef: { ...failure.logRef } } : {}) } : undefined;
}
export function ErrorLogLink({ failure, message }: { failure?: UserFailure; message?: string }) {
  return <button type="button" className="text-button error-log-link" onClick={() => {
    const current = failure || (message ? references.get(message) : undefined);
    window.dispatchEvent(new CustomEvent('workbench:view-logs', { detail: current?.logRef || {} }));
  }}>查看日志</button>;
}
export function ErrorNotice({ error, operation }: { error: any; operation?: string }) {
  const text = typeof error === 'string' ? error : error?.message || `${operation || '此次操作'}未完成，请查看日志。`;
  if (!error) return null;
  return <p className="inline-error" role="alert"><span>{text}</span> <ErrorLogLink failure={error?.failure} message={text}/></p>;
}
