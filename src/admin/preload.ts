import { contextBridge, ipcRenderer } from 'electron';
import { userFailure } from '../shared/user-failure';
import { announceFailures } from '../main/failure-events';
contextBridge.exposeInMainWorld('admin', {
  async call(action: string, payload?: unknown) { const r = await ipcRenderer.invoke('admin', action, payload); if (!r.ok) { const failure = r.failure || userFailure(r.error); announceFailures(failure); throw { name: 'WorkbenchFailure', message: failure.message, code: failure.code, failure }; } announceFailures(r.value); return r.value; },
  subscribe(callback: () => void) { const handler = () => callback(); ipcRenderer.on('admin:changed', handler); return () => ipcRenderer.removeListener('admin:changed', handler); },
});
