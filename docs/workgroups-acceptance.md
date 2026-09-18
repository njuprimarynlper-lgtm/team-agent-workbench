# 按账号发现工作组：开发版验收

本次修改在现有 0.6.3 源码上验证，更新开发启动入口，未生成新安装包。

2026-09-17 验证结果：类型检查与构建通过；Node 回归覆盖 59 项，其中一次并行运行的成果整理用例等待超时，单独复测通过；Python 22 项通过；工作组桌面用例、管理员与两个用户的本地文件系统联调、SFTP 桌面回归与离线重启均通过。桌面截图已检查。

## 使用规则

- 用户填写服务器地址、账号、密码和本机工作目录；共享工作路径不再由用户输入。
- 本地打桩仍需指定管理员提供的共享区根目录，相当于选择服务器。目录下的工作组和项目由登录身份决定。
- 未分组账号可以登录，但没有工作台和新建会话入口；共享区域提示“还没有加入工作组”。
- 工作台按工作组分区展示项目，创建会话时也按组列出项目。同名项目依靠项目 ID 区分。
- 项目子管理员只能在授权组中创建项目；普通成员不显示创建入口。
- 刷新立即更新组成员与项目；窗口可见时每 30 秒自动刷新。Linux 组权限变更会断开旧连接，需重新登录；本地打桩刷新即可。
- 会话、成果和传输保持原项目绑定。移出组不会删除本地会话，也不会把上传转到其他组。
- 成员信息错误和组目录访问错误有各自提示，不误报为未分组。

## 用例与验证入口

| 用例 | 验证入口 |
| --- | --- |
| 未分组账号登录且不能创建工作会话 | `tests/workgroups.test.ts`、`scripts/workgroups-smoke.mjs` |
| 用户指定旧路径、项目清单不能取得额外入口 | `tests/workgroups.test.ts`、`tests/sftp.test.ts` |
| 登录后发现全部授权组，隐藏未授权组 | `tests/workgroups.test.ts`、`scripts/workgroups-smoke.mjs` |
| 多组同名项目、分组显示、分组选择项目 | `tests/workgroups.test.ts`、`scripts/workgroups-smoke.mjs` |
| 多组创建需明确目标组，普通成员不可创建 | `tests/workgroups.test.ts`、`scripts/workgroups-smoke.mjs` |
| 添加成员、撤销子管理员、移出组后刷新 | `tests/workgroups.test.ts`、`scripts/workgroups-smoke.mjs` |
| 切组不改变会话绑定，原组撤权后上传失败 | `tests/workgroups.test.ts`、`scripts/workgroups-smoke.mjs` |
| 一个组不可访问时保留组错误，其他组仍可用 | `tests/workgroups.test.ts` |
| 拒绝旧版或可被普通用户篡改的成员记录 | `tests/workgroups.test.ts` |
| 管理员发布普通成员、未分组用户及子管理员信息 | `tests/test_admin.py` |
| 管理员刷新升级旧成员文件，其他操作不丢失旧成员关系 | `tests/test_admin.py` |
| 管理员与两个用户并行使用、上传、预览、轨迹隐私 | `scripts/local-smoke.mjs` |
| SFTP 交互、管理员恢复、成员直接登录、离线重启、会话资料 | `scripts/smoke.mjs` |

运行：`npm run typecheck`、`npm test`、`python -m unittest discover -s tests -p test_admin.py`、`npm run build`、`npm run test:workgroups-ui`、`npm run test:local-ui`、`npm run test:ui`。多套 Electron 和 CLI 用例宜分别运行，避免进程启动争用导致等待超时。

桌面用例使用独立测试账号和目录，结果与截图保存在 `.test-data/workgroups-ui-*/`，不修改现有比赛联调账号和项目。Linux 使用真实 SSH/SFTP 协议测试桩和 Python 命令测试，未连接实际 Linux 主机验收。

## 既有服务器升级

新版管理员端登录后读取实际 Linux 组成员关系，生成受 root 保护的 `/.workbench/roles.json`，增加 `membershipVersion: 1` 与各账号的 `groups`。已打开的管理员端可点击刷新。原 Linux 组、目录、成果、轨迹继续使用。用户端不接受配置文件中的手工 `workPath`、`manifestPath`、`projects` 作为授权入口；历史自定义布局应先由管理员纳入工作组项目布局。
