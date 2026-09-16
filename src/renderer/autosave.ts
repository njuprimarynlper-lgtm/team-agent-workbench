import { useSyncExternalStore } from 'react';

type Entry = { value: any; status: string; revision: number; pending: Promise<void>; listeners: Set<() => void>; snapshot: any };
const entries = new Map<string, Entry>();
// The cache outlives view components. Navigation cannot discard failed or pending edits.
export function useAutosave<T>(key: string, initial: T, save: (value: T) => Promise<unknown>) {
  if (!entries.has(key)) entries.set(key, { value: initial, status: '已保存', revision: 0, pending: Promise.resolve(), listeners: new Set(), snapshot: { value: initial, status: '已保存' } });
  const entry = entries.get(key)!;
  const emit = () => { entry.snapshot = { value: entry.value, status: entry.status }; entry.listeners.forEach(fn => fn()); };
  const snapshot = useSyncExternalStore(fn => { entry.listeners.add(fn); return () => { entry.listeners.delete(fn); }; }, () => entry.snapshot);
  const change = (value: T) => {
    const revision = ++entry.revision; entry.value = value; entry.status = '保存中…'; emit();
    entry.pending = entry.pending.catch(() => {}).then(() => save(value)).then(() => { if (revision === entry.revision) { entry.status = '已保存'; emit(); } }, (e: Error) => { if (revision === entry.revision) { entry.status = '保存失败：' + e.message; emit(); } throw e; });
    void entry.pending.catch(() => {});
  };
  const flush = async () => { await entry.pending; };
  return { value: snapshot.value as T, status: snapshot.status as string, change, flush, retry: () => change(entry.value) };
}
