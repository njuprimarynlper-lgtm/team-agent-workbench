import { build } from 'electron-builder';
import path from 'node:path';
const requested = process.argv[2];
for (const edition of requested ? [requested] : ['admin', 'user']) {
  if (!['admin', 'user'].includes(edition)) throw new Error('Unknown edition');
  const product = edition === 'admin' ? 'Team Agent Admin' : 'Team Agent User';
  await build({ projectDir: process.cwd(), config: {
    appId: 'local.teamagent.' + edition, productName: product,
    directories: { app: path.resolve('dist', edition), output: path.resolve('release', edition) },
    electronVersion: '44.3.0', electronDist: path.resolve('node_modules/electron/dist'),
    asar: true, npmRebuild: false, nodeGypRebuild: false, compression: 'normal',
    files: ['**/*'],
    extraResources: edition === 'user' ? [
      { from: '.tools/cursor/dist-package', to: 'providers/cursor', filter: ['**/*'] },
      { from: 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc', to: 'providers/codex', filter: ['**/*'] },
      { from: 'third-party/Codex-LICENSE', to: 'providers/codex/LICENSE' },
    ] : [],
    win: { target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }], signAndEditExecutable: false,
      artifactName: 'TeamAgent-' + edition + '-${version}-${arch}.${ext}' },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, createDesktopShortcut: true,
      shortcutName: edition === 'admin' ? '团队工作台-管理员版' : '团队工作台-用户版', uninstallDisplayName: product },
  }});
}
