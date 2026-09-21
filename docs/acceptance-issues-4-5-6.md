# Issue #4、#5、#6 修复与验收

本地验证日期：2026-09-21。未连接实际共享区服务器；Linux 服务相关命令通过模拟验证，不能替代目标容器验收。

## 修复范围

| Issue | 原因 | 本次处理 |
| --- | --- | --- |
| [#4](https://github.com/njuprimarynlper-lgtm/team-agent-workbench/issues/4) | 必需的 ACL 工具缺失，直到创建用户组才暴露 | 连接时检测，缺少 setfacl 时调用 libacl；两者均缺时可在线或离线准备环境，修复后继续 |
| [#5](https://github.com/njuprimarynlper-lgtm/team-agent-workbench/issues/5) | SSH 重载、文件服务托管绑定 systemd | 检测实际 PID 1；保留 systemd，增加 Supervisor 托管及专用实例准备；保留 SSH 配置校验和失败恢复 |
| [#6](https://github.com/njuprimarynlper-lgtm/team-agent-workbench/issues/6) | 启动器只从 PATH 定位 Node/npm | 两个原入口优先选择 `.tools/node-v*-win-x64` 中最新可运行版本，损坏/超时逐个跳过；再回退系统 PATH、自定义离线目录，仅修改子进程环境 |

Supervisor 的支持条件及部署操作见[部署指导](deployment-guide.md#无-systemd-的容器)。工具不负责替换容器 entrypoint；它必须启动同一个 Supervisor，才能让文件服务随容器恢复。

## 已通过的本地验证

- `python -m unittest discover -s tests -p test_*.py -v`：83 项，79 通过，4 项跳过。跳过的是 libacl 原生读写及 Linux 内核权限测试（含公共区隔离、私人请求目录和只读回执）。
- `node --import tsx --test --test-concurrency=1 tests/admin.test.ts tests/launcher.test.ts`：22 项通过，覆盖本机 SSH 测试服务器交互、环境重新检查，以及两个 Windows 入口使用便携 Node、首次准备、失败重试和并发启动。
- `node --import tsx --test --test-concurrency=1 tests/local-space.test.ts tests/local-preservation.test.ts tests/storage-usage.test.ts`：13 项通过，本地打桩多账号、多组、权限变更、上传和空间统计无回归。
- `npm run typecheck`、`npm run build`：通过。
- `npm run test:server-environment-ui`：真实 Electron 界面、回环 SSH 测试服务器，10 个场景通过：包含环境检查、取消不安装、离线目录必填、离线安装失败提示和重试、安装中等待状态、在线安装完成后恢复管理。
- `node scripts/server-upgrade-smoke.mjs`：3 个场景通过：管理程序经 SSH 标准输入传送、取消不触发更新、确认更新成功且保留成员。
- `git diff --check`：通过。

服务端测试还验证：存在 systemctl 不等于 systemd 正在运行；拒绝远程 Supervisor 控制端点；root 控制的系统链接可以使用，成员可写目录不可以；`sshd -t` 失败时恢复规则且不重载；文件服务未启动时不确认首次接入完成；修复后恢复创建不会重复执行 useradd。

新增回退用例覆盖损坏的 node.exe、损坏的 npm.cmd、项目运行时回退系统、自定义离线 Node 路径；ACL 命令缺失使用库、权限失败不回退、ACL 内存释放、默认 ACL 与 mask；离线安装不下载、已满足环境不重复安装、失败重试和专用 Supervisor 配置幂等。

这些用例不调用真实 Codex/Cursor 模型，不消耗模型额度。启动器测试使用受控 npm 夹具，不验证外部依赖下载网络。

## 目标 Ubuntu 容器仍需验收

1. 在目标 Debian/Ubuntu 验证在线安装及离线依赖包安装，确认软件包管理器操作成功。Windows 用例模拟了这些命令，没有执行真实 apt 安装。按部署指导确认 Supervisor、受保护的本机 socket、配置加载目录及 SSH reload 入口。通过管理员界面“重新检查环境”。
2. 对已失败的首个用户创建，从“待恢复操作”点击“继续完成”并重新输入初始密码；确认只有一个 Linux 账号，操作记录完成。
3. 确认新 SSH/SFTP 连接可用，成员按组访问项目；上传、读取和编辑共享内容均成功。
4. 确认文件服务在 Supervisor 中为 RUNNING，并通过停止其子进程验证 Supervisor 能恢复它。
5. 重启目标容器，确认 Supervisor 被启动、文件服务自动恢复；再次建立新 SSH/SFTP 连接并验证共享读写。
6. 在实际挂载点执行 Linux 权限测试，确认 setfacl 和 libacl 两条路径均能设置 ACL、成员无法跨组越权，个人请求可写且回执不可改。运行完整 Python 用例；这四项在 Linux 上不能继续跳过。

在这些检查完成前，#5 应保持待目标环境验收；本地模拟通过不能视作容器端到端已通过。
