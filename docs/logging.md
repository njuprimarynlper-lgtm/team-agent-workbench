# 日志管理与问题收集 · v2.3.46

工作台只有一套日志写入和管理机制，提供故障排查、工作流分析两类记录。现有会话执行事件也由它管理，作为完整会话资料单独保留，不复制到普通日志中。不自动上传、不调用模型。

## 给使用者的收集步骤

1. 记下出现问题的时间、客户端版本、项目及会话，并描述“做了什么、期待什么、实际发生什么”。
2. 用户端打开 **更多 → 日志与分析**；管理员版打开 **连接设置 → 日志与分析**。
3. 选择故障前后的一段时间、项目或会话，填写问题描述，点击 **导出故障诊断包**，将 ZIP 通过已有内部渠道发给维护者。
4. 分析使用流程时，选择所需日期和项目，点击 **导出工作流分析包**。不需要上传完整会话。
5. 只有维护者确实需要工具执行原文时，才选择已停止运行的会话，展开“完整执行轨迹”并单独导出。该包包含对话和工具内容，分享前应确认可提供这些资料。

不要直接复制整个 `%APPDATA%\TeamAgentUser`、`TeamAgentAdmin`、Codex/Cursor 账号目录或项目工作目录。完整资料与凭据不属于普通诊断包。

## 打不开客户端时

现有源码启动进度窗口提供 **导出诊断**，启动失败弹窗也可选择导出。只收集受限启动输出和无账号归属的全局启动/崩溃记录，不读取账号数据库、会话和认证文件。

也可从源码目录运行已有入口的收集模式；此命令不安装依赖、不构建、不启动应用，且不依赖 Node：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-dev-hidden.ps1 user -ExportDiagnostics "$env:USERPROFILE\Desktop\TeamAgent-startup.zip"
```

管理员版将 `user` 换成 `admin`。目标文件应尚不存在。后续安装包和便携 ZIP 在程序目录的 `tools/` 中附带同一个离线收集器，不需要 Node、源码、原工作台进程或中央节点：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\tools\collect-diagnostics.ps1
```

它会识别用户版/管理端并弹出保存窗口。自定义数据目录可加 `-DataRoot "实际数据根目录"`，命令行导出可加 `-Output "尚不存在的 ZIP 路径"`。离线报告是启动/全局故障报告，不包含当前团队账号的全部运行记录。

## 保存位置与空间

- 用户版普通日志：`%APPDATA%\TeamAgentUser\logs`。
- 管理员版普通日志：`%APPDATA%\TeamAgentAdmin\logs`。
- 自定义 `WORKBENCH_DATA_DIR` / `WORKBENCH_ADMIN_DATA_DIR` 时，使用相应数据根目录。
- 原 `.test-data\launcher` 仅作源码启动的有界暂存区：启动输出保留前段与末段，单路小于 2 MiB，目录按 4 MiB 和 14 天清理；应用启动后将结束进程的输出尾段脱敏归入诊断日志，成功后移除暂存文件。错误发生在 Node 启动前也可收集。
- 每个客户端数据根目录共用故障 30 MiB、工作流 20 MiB 配额，覆盖所有账号和窗口。故障配额中预留 4 MiB 给早期启动暂存；压缩前先腾出空间。普通日志按年龄或空间先到者清理。
- 故障最多保留 14 天，工作流最多保留 90 天。文件分别在 4 MiB、2 MiB 轮转并无损压缩。
- 完整轨迹位于各账号资料目录 `sessions/<会话ID>/`，兼容 `events.jsonl` 与有序 `events-00000001.jsonl.gz` 分段。它不受普通日志 50 MiB 限额控制，持续使用仍会增长；界面单独显示当前账号轨迹占用，可以按会话确认删除。对话、成果、附件和厂商原生历史不随普通日志清理。

旧轨迹后台逐个压缩，校验解压内容的哈希一致后才删除原文件；失败保留原件。读取、事件编号、AI 推荐证据及轨迹上传使用共同接口，压缩不会改变上传去重哈希。异常退出留下半行时保留原片段并隔开新事件，标记轨迹不完整。

## 如何阅读两类包

`diagnostic.jsonl` 记录重要操作阶段、错误堆栈、错误码、CLI 连接/退出、网络路线、压缩、同步和后台任务失败。`report.json` 附版本、操作系统、运行环境、已有 CLI 检测信息、脱敏配置、选择范围及覆盖说明。用 `operationId` 关联一次请求的阶段，用 `sessionId`、`turnId` 查后续生成状态。

`workflow.jsonl` 记录操作意图及结果、页面打开、发送、首次输出、生成结束、资料实际应用、后台运行和传输结束。`origin=user/ai/background` 区分来源。汇总按项目、操作、阶段和来源分组，分别记录请求、成功、失败、取消次数与有观测的阶段耗时，不将“请求”和“结束”算成两次完成。

会话阶段复用既有计时：思考、工具、回复、授权等待、网络等待等。焦点、系统空闲、休眠和恢复记录用于解释时间空白；它们是粗粒度状态，不是精确人工工时，不能据此直接评价个人效率。

普通日志不记录输入框每次编辑、逐 token 输出、滚动和逐字节进度。单条最多 16 KiB，队列最多 1,000 条/2 MiB；普通持续写入 20 条/秒，突发最多 100 条。同类错误 60 秒合并，进度最多 5 秒一条。超过容量优先抑制低优先级记录，包内标明抑制数、无法读取和解析的记录；缺少事件不等于用户没有操作。

完整轨迹不采样。通过批量写入、流式压缩和 CLI 事件接收背压限制内存；持久化失败会在状态面板显示，相关会话保留不完整标识，不自动重放任务。日志存储错误冷却重试，不递归记录自身错误。

## 开发接口与验证

- `logs.status`：根目录配额、当前账号轨迹占用、队列、最后写入、抑制与错误状态。
- `logs.export`：`{kind:diagnostic|workflow|trace,from?,to?,projectId?,sessionId?,description?}`；使用系统保存窗口，按当前账号隔离，限制一个并发导出，流式写入。
- `logs.cleanup`：`{kind:ordinary}` 清理普通日志；`{kind:trace,sessionId}` 确认后删除已停止会话的完整轨迹。
- 界面错误和页面状态使用经过校验的内部 `logs.rendererError`、`logs.interaction`，不接收任意日志字段、路径或文件内容。

验证命令：`npm run typecheck`、`node scripts/test-background.mjs tests/logging.test.ts`、`node --import tsx --test tests/launcher.test.ts`、`npm run build`、`node scripts/logging-smoke.mjs`。验收截图和导出示例保存在 `artifacts/logging/`，全部使用隔离数据和模拟 CLI，不调用真实模型。
