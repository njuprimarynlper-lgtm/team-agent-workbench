import { EventEmitter } from 'node:events';

// Main-process lifecycle tests use these Electron services in memory. Logging
// and scheduled-task hooks subscribe to powerMonitor even without a window.
// Nothing here creates desktop windows, trays, notifications or shell processes.
export function fakeElectronBackgroundServices() {
  class Notification extends EventEmitter { static isSupported() { return false; } show() {} }
  class Tray extends EventEmitter { setToolTip() {} setContextMenu() {} destroy() {} displayBalloon() {} }
  return {
    powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleTime: () => 0 }),
    Notification, Tray,
    Menu: { buildFromTemplate: (items: unknown[]) => items },
    nativeImage: { createFromBitmap: () => ({}), createFromDataURL: () => ({}) },
    shell: { openPath: async () => '' },
  };
}
