/** Send only public metadata through the isolated-world DOM bridge. */
export function announceFailures(value: any, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 10) return;
  if (value.version === 1 && typeof value.code === 'string' && typeof value.message === 'string') { window.postMessage({ type: 'workbench:failure', failure: value }, '*'); return; }
  if (Array.isArray(value)) { for (const item of value) announceFailures(item, depth + 1); return; }
  for (const [key, item] of Object.entries(value)) if (!['messages', 'content', 'body', 'text', 'nativeDetails', 'sources', 'inputs'].includes(key)) announceFailures(item, depth + 1);
}
