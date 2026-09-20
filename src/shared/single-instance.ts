import { app, BrowserWindow } from 'electron';
export function ownDataDirectory(getWindow: () => BrowserWindow | undefined, openAdditionalWindow?: () => void) {
  // Electron scopes this lock to userData; editions and Windows users keep separate roots.
  if (!app.requestSingleInstanceLock()) { app.quit(); return false; }
  app.on('second-instance', () => {
    if (openAdditionalWindow) { openAdditionalWindow(); return; }
    const window = getWindow(); if (!window || window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus();
  });
  return true;
}
