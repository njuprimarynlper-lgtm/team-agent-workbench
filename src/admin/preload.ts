import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('admin', {
  async call(action: string, payload?: unknown) { const r = await ipcRenderer.invoke('admin', action, payload); if (!r.ok) throw new Error(r.error); return r.value; },
  subscribe(callback: () => void) { const handler = () => callback(); ipcRenderer.on('admin:changed', handler); return () => ipcRenderer.removeListener('admin:changed', handler); },
});
