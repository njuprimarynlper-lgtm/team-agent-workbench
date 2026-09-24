import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function launchDesktop(root, edition, spawnProcess = spawn) {
  if (!['user', 'admin'].includes(edition)) throw new Error('Unknown workbench edition');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  // A detached process with no inherited stdio cannot keep the launcher's
  // Windows Terminal tab alive. Do not set SW_HIDE: it also hides Electron's
  // first application window, even when BrowserWindow requests show: true.
  const child = spawnProcess(path.join(root, 'node_modules/electron/dist/electron.exe'), [path.join(root, 'dist', edition)], {
    cwd: root, env, detached: true, windowsHide: false, shell: false, stdio: 'ignore',
  });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
  child.unref();
  return child.pid;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  launchDesktop(process.cwd(), process.argv[2]).then(pid => console.log(`Workbench process: ${pid}`), error => {
    console.error(error.message); process.exitCode = 1;
  });
}
