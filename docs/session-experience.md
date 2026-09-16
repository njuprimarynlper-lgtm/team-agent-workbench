# 会话、成果整理与轨迹上传

本次为开发版更新，没有构建安装包或改动已发布的 0.5.0 EXE。运行仓库根目录 `start-user-dev.cmd` 查看已编译的用户界面；源码修改后先运行 `npm run build`。默认继续使用 `%APPDATA%\TeamAgentUser`；若设置 `WORKBENCH_DATA_DIR`，沿用指定数据目录。不要同时启动两个使用同一数据目录的用户进程。

## 用户操作

1. 新建会话先选择 Codex / Cursor。登录状态展示 CLI 返回的邮箱；Codex 还展示返回的套餐。已经登录时，“登录个人账号”禁用；“重新检测”可刷新外部 CLI 的登录变更。没有账号字段时说明“CLI 未提供账号名称”，不会把 Windows 或共享空间账号当作模型账号。
2. 在同一对话框选择模型，查看账号额度；确认工作目录和远端项目后创建。模型固定在会话上，重启、恢复和后台成果整理都沿用该模型。选择“沿用 CLI 默认模型”则保留 CLI 自己的默认行为。列表读取失败不阻止沿用默认模型。
3. 会话工具栏提供“关闭会话”。运行中先提示停止；关闭后保留历史、未发送输入、原生 session ID 和交接文件。左侧“已关闭会话”可以查看并重新打开。重新打开不自动重放任务，需主动发送。进程停止不能撤销已经完成的文件修改。
4. 点击“整理成果”，成果页按三步呈现：后台读取材料；编辑标题、GitHub 链接和修改说明；确认上传目录。后台内部会话不出现在工作会话列表。草稿页直接显示进度、失败原因、停止/重试入口以及需要人处理的操作确认。
5. 生成结果先供预览，点击“采用草稿作为修改说明”才替换编辑区。重试保留人工编辑和此前结果，读取本次草稿的冻结材料；要纳入最新交接文件，应回到原工作会话再次点击“整理成果”。后台失败不会覆盖人工内容。应用退出后，未完成整理显示“已中断”，用户决定是否重试。
6. “轨迹上传”预览采集的会话内容，默认手动。绑定项目的工作会话可开启每轮结束自动上传；上传到项目的 `trajectories/账号/`。移除“会话归档”和本地导出入口。仍保留正常的本地会话记录，以及失败上传重试所需的队列缓存，这不是额外的用户归档操作。

成果仍只上传 GitHub 仓库链接、修改说明和提交元数据，不上传代码或材料快照。

## 接入来源与边界

| 能力 | Codex | Cursor |
| --- | --- | --- |
| 身份 | App Server `account/read`，白名单提取 `email` / `planType` | `status --format json`，白名单提取 `userInfo.email` |
| 模型列表 | `model/list` 分页，使用 `model` 字段，不使用展示 ID | `agent models`，解析当前 CLI 的模型行；无法识别时显式提示 |
| 模型传递 | `thread/start` / `thread/resume` 与 `turn/start` 的 `model` | ACP 新建/恢复后调用 `session/set_model`，传递 `modelId` |
| 额度 | `account/rateLimits/read`，优先显示所有 `rateLimitsByLimitId`，回退旧字段 | 当前 CLI 没有公开个人套餐额度读取接口；按钮打开官方 Spending 页 |

Codex 百分比是“已用”，界面显示 `100 - usedPercent` 的剩余额度和 Unix 秒重置时间。它是账号/用量池信息，不推断模型独享配额。不支持的认证方式或网络失败显示不可用，绝不显示虚构的 0% 或无限额度。额度查询失败不覆盖可用模型列表，也不改变认证状态。身份和额度只留在内存，不写入成果或轨迹。

参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Cursor CLI 参数](https://cursor.com/docs/cli/reference/parameters)、[Cursor ACP](https://cursor.com/docs/cli/acp)、[Cursor 官方用量说明](https://cursor.com/help/models-and-usage/usage-limits)。Cursor `session/set_model` 同时核对本仓库随带官方 CLI 的 ACP 实现；升级 CLI 后应执行协议回归。

## 验证入口

- `npm run check`：类型检查、全部 Node 测试、两个开发版构建。新增身份、模型分页、额度失败、模型协议传递、关闭/重开、并行认证、准备失败/重试/取消/进程退出、重启恢复的用例。
- `npm run test:session-ui`：两种提供方的窗口操作回归，登录按钮禁用、模型与额度、整理页错误/重试、保留编辑、操作确认、关闭/恢复和移除本地轨迹导出。
- `npm run test:ui`：原有用户/管理员隔离、SFTP 共享、成果提交和编辑保存恢复回归。
- `npm run test:local-ui`：管理员与两个成员、本地共享文件系统、项目创建及轨迹实际上传。

真实账号只读联调已验证本机 Codex 的身份、模型列表与额度，不发送付费模型任务。本机 Cursor 尚未登录，Cursor 模型选择与会话交互使用协议模拟 CLI 验证，不能当作真实账号端到端验证。
