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
await fs.writeFile(path.join(demo, '开发版同步.md'), `# 当前打桩入口\n\n三个“打开”启动文件已同步到当前开发构建（同步时源码提交 ${commit}）。\n\n- 程序目录：${path.join(repo, 'dist')}\n- 管理员数据：本目录 admin-data\n- Alice / Bob 数据：本目录 alice-data、bob-data\n- 共享目录：本目录 shared\n\n本页仅记录打桩开发入口；安装包单独保存在仓库 release/版本号/ 下。原有账号、组、项目、成果与轨迹继续使用。后续在源码目录执行 npm run build，以上入口即使用最新构建。密码仍需在连接时输入，不写入启动文件。\n`, 'utf8');
await fs.appendFile(path.join(demo, '开发版同步.md'), '\n会话输入框底部可直接选择模型和权限，模型菜单内可查看账号额度。切换保留已有对话与未发送草稿；正在运行时需确认停止当前任务。顶部压缩为紧凑工具栏，项目资料引用和 Agent 工作记录收在“会话资料”菜单内。\n', 'utf8');
await fs.appendFile(path.join(demo, '开发版同步.md'), '\n成果整理默认使用完全访问；新建和重新整理均不继承来源会话的人工审批配置。已有等待审批的整理可取消后重新整理。上传仍由用户确认。\n', 'utf8');
const guide = path.join(demo, '使用说明.md');
await fs.appendFile(path.join(demo, '开发版同步.md'), '\n新增空组首次使用引导：首位新建或添加的成员默认子管理员（可调整）。子管理员登录空组时填写项目背景、目标、验收标准等内容，创建首个项目和《项目说明.md》，也可稍后填写并保留草稿。现有项目及成员身份不自动改变。\n', 'utf8');
await fs.appendFile(path.join(demo, '开发版同步.md'), '\n用户版只选择本机工作路径，共享区根目录沿用管理员配置，不再要求用户选择。新设备可从管理员版导出并导入连接配置。只有一份连接配置时直接显示连接说明，多个连接才显示有标签的选择器；工作组在一次登录后自动发现，不需要每组建立连接。\n', 'utf8');
const original = await fs.readFile(guide, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
if (original) {
  const note = `> 当前三个启动文件使用最新开发构建，程序位于 \`${path.join(repo, 'dist')}\`，不再依赖旧版安装包。共享目录、账号及历史会话继续使用本目录原有数据。本地管理员无需账号密码，启动自动打开已保存的共享目录；“创建用户 / 创建用户组”已并排；用户版的整理成果已改为后台等待面板、AI 自动说明与上传位置、小型可选补充、人工确认上传；方向性与结果性结论无需仓库链接即可上传，链接为可选项；Agent 工作记录已移到默认收起的“会话资料”，先只读预览；成果页说明两类内容的区别，并提供取消返回（整理中会停止，草稿和补充保留）；用户登录后自动发现全部工作组，按组展示项目，无需填写共享工作路径；未分组账号可登录但没有工作台，界面提示联系管理员；组权限变更后刷新即可；会话固定绑定原项目。新建会话可选择 CLI 原有设置、人工审批或完全权限，现有会话可检测与修改权限，命令受限和待授权操作会明确提醒；修改权限不会自动重试任务。公共成果支持检索、引用、本人修订和子管理员整理/合并/锁定；项目资料有版本与更新提示；整理可附代码版本；轨迹上传去重，可清理成功缓存。离线授权默认 8 小时，过期只读。模型选择和轨迹上传继续保留。重新打开启动文件即可查看；以下四轮比赛记录属于历史验证。`;
  await fs.writeFile(guide, /^> 当前三个启动文件.*$/m.test(original) ? original.replace(/^> 当前三个启动文件.*$/m, note) : note + '\n\n' + original, 'utf8');
}
console.log(JSON.stringify({ demo, commit, launchers: launchers.map(([name]) => path.join(demo, name)), build: path.join(repo, 'dist') }, null, 2));
