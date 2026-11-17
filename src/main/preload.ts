import { contextBridge, ipcRenderer } from 'electron';
import type { WorkbenchAPI, WorkbenchEvent } from '../shared/types';
import { userFailure } from '../shared/user-failure';
import { announceFailures } from './failure-events';
const api: WorkbenchAPI = {
  async call<T>(action: string, payload?: unknown): Promise<T> { const response = await ipcRenderer.invoke('workbench', action, payload); if (!response.ok) { const failure = response.failure || userFailure(response.error); announceFailures(failure); throw { name: 'WorkbenchFailure', message: failure.message, code: failure.code, failure }; } announceFailures(response.value); return response.value as T; },
  subscribe(listener) { const handler = (_event: Electron.IpcRendererEvent, data: WorkbenchEvent) => { announceFailures(data); listener(data); }; ipcRenderer.on('workbench:event', handler); return () => ipcRenderer.removeListener('workbench:event', handler); }
};
contextBridge.exposeInMainWorld('workbench', api);
