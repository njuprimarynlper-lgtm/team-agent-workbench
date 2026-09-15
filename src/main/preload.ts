import { contextBridge, ipcRenderer } from 'electron';
import type { WorkbenchAPI, WorkbenchEvent } from '../shared/types';
const api: WorkbenchAPI = {
  async call<T>(action: string, payload?: unknown): Promise<T> { const response = await ipcRenderer.invoke('workbench', action, payload); if (!response.ok) throw new Error(response.error); return response.value as T; },
  subscribe(listener) { const handler = (_event: Electron.IpcRendererEvent, data: WorkbenchEvent) => listener(data); ipcRenderer.on('workbench:event', handler); return () => ipcRenderer.removeListener('workbench:event', handler); }
};
contextBridge.exposeInMainWorld('workbench', api);
