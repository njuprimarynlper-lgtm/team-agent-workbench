import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Point the prepared demo at the current development build without replacing its data.
const repo = fileURLToPath(new URL('../', import.meta.url));
const demo = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node scripts/sync-local-demo.mjs <existing-demo-directory>');
if (/["%\r\n]/.test(repo)) throw new Error('Repository path cannot be represented safely in a batch launcher');
const runtime = path.join(repo, 'node_modules/electron/dist/electron.exe');
for (const file of [runtime, path.join(repo, 'dist/admin/main.cjs'), path.join(repo, 'dist/user/main.cjs'), path.join(demo, 'shared/.workbench-local/registry.json'), path.join(demo, 'admin-data/connection.json'), path.join(demo, 'alice-data/settings.json'), path.join(demo, 'bob-data/settings.json')]) await fs.access(file);
const profiles = [JSON.parse(await fs.readFile(path.join(demo, 'admin-data/connection.json'), 'utf8')), ...await Promise.all(['alice', 'bob'].map(async user => {
  const settings = JSON.parse(await fs.readFile(path.join(demo, user + '-data/settings.json'), 'utf8'));
  return settings.connections.find(p => p.mode === 'local' && p.username === user);
}))];
for (const p of profiles) if (!p || p.mode !== 'local' || path.resolve(p.localRoot) !== path.join(demo, 'shared')) throw new Error('Demo connections must use the existing local shared directory');
const launchers = [
  ['打开管理员.cmd', 'admin', 'WORKBENCH_ADMIN_DATA_DIR', 'admin-data'],
  ['打开用户A.cmd', 'user', 'WORKBENCH_DATA_DIR', 'alice-data'],
  ['打开用户B.cmd', 'user', 'WORKBENCH_DATA_DIR', 'bob-data'],
];
for (const [name, edition, variable, directory] of launchers) {
  const lines = ['@echo off', 'chcp 65001 >nul', 'set "WORKBENCH_TEST="', 'set "ELECTRON_RUN_AS_NODE="', `set "${variable}=%~dp0${directory}"`, `cd /d "${repo}"`, `start "" "${runtime}" "${path.join(repo, 'dist', edition)}"`, ''];
  await fs.writeFile(path.join(demo, name), lines.join('\r\n'), 'utf8');
}
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
await fs.writeFile(path.join(demo, '开发版同步.md'), `# 当前打桩入口\n\n三个“打开”启动文件已同步到当前开发构建（同步时源码提交 ${commit}）。\n\n- 程序目录：${path.join(repo, 'dist')}\n- 管理员数据：本目录 admin-data\n- Alice / Bob 数据：本目录 alice-data、bob-data\n- 共享目录：本目录 shared\n\n此次不生成安装包。原有账号、组、项目、成果与轨迹继续使用。后续在源码目录执行 npm run build，以上入口即使用最新构建。密码仍需在连接时输入，不写入启动文件。\n`, 'utf8');
const guide = path.join(demo, '使用说明.md');
const original = await fs.readFile(guide, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
if (original) {
  const note = `> 当前三个启动文件使用最新开发构建，程序位于 \`${path.join(repo, 'dist')}\`，不再依赖旧版安装包。共享目录、账号及历史会话继续使用本目录原有数据。管理员的“创建用户 / 创建用户组”已并排；用户版的整理成果已改为后台等待面板、AI 自动说明与上传位置、小型可选补充、人工确认上传；模型选择和轨迹上传继续保留。重新打开启动文件即可查看；以下四轮比赛记录属于历史验证。`;
  await fs.writeFile(guide, /^> 当前三个启动文件.*$/m.test(original) ? original.replace(/^> 当前三个启动文件.*$/m, note) : note + '\n\n' + original, 'utf8');
}
console.log(JSON.stringify({ demo, commit, launchers: launchers.map(([name]) => path.join(demo, name)), build: path.join(repo, 'dist') }, null, 2));
