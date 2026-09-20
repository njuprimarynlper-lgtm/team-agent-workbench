# 会话输入框与显示空间

- 当前会话的模型、权限、Skill 与插件放在输入框底部。点击后向上展开菜单，点击外部或 Esc 收起。权限名称使用提供方的名称，完整影响说明只在菜单中显示。
- 空闲时选择即应用；正在执行或等待授权时，先在菜单内确认“停止当前任务并切换”。修改不发起推理、不重发任务、不创建新会话。
- Codex 使用原 thread/resume + turn/start 的 model；Cursor 使用原 session/load + session/set_model。保留 nativeId、历史引用记录及未发送草稿。选择具名模型（包括列表中标为默认的具体模型），避免将空 model 错当成原生会话的模型重置。
- 模型菜单显示账号额度、官方额度页和刷新入口。Cursor 沿用现有额度查询能力；不可读取时明确显示不可用。Cursor ACP 不支持的 Auto-review 仍禁用，Allowlist 配置仍需明确操作。
- 切换期间服务端拒绝同会话的并发发送和设置变更；不会在进程关闭期间以旧模型启动任务。启动中不允许修改。
- 顶栏缩至 52px，会话工具栏约 58px。项目说明和阶段摘要位于工具栏“AI 参考内容”，资料新版本保留更新标记。聊天区独立滚动，参考菜单不挤压高度。
- Skill 与插件选择只作用于下一条消息，并作为未发送输入按会话保存。发送成功后清空；发送失败、切换会话或重启工作台时保留。已发送消息显示当轮使用的能力标签，轨迹也保留这些选择。
- Codex 从当前原生会话调用 `skills/list` 和 `plugin/installed`；发送时分别使用 `$skill`、`@plugin`，并附结构化 `skill` 或 `mention(plugin://...)` 输入。插件安装、登录、启停继续由 Codex 管理。
- Cursor 从 ACP 的 `available_commands_update` 取得当前工作区可用的 Skill/命令，按 `/name` 调用；每条消息只显式选择一个 Skill。个人和项目 `.cursor/mcp.json` 中的 MCP server 显示为插件工具，选择后要求本轮使用该工具，实际加载、登录、启停和批准仍由 Cursor CLI 处理。

验证入口：

- `tests/session-settings.test.ts`：两个提供方的模型参数、原生会话延续、引用保留、无自动重发、草稿、并发保护、停止确认及持久化。
- `scripts/composer-smoke.mjs`：两个提供方的模型/权限/能力菜单、Codex 结构化 Skill 与 Plugin 提及、Cursor `/skill` 与 MCP 工具提示、单条消息清空、失败重试、运行中取消/确认、草稿、键盘与 1100×760 布局。
- `tests/provider-capabilities.test.ts`：Codex 原生目录解析、不可调用应用状态、Cursor 命令过滤和项目 MCP 配置发现。
- `scripts/permissions-smoke.mjs`：原生权限名称、切换及批准请求、只读影响、Cursor 禁用选项与显式配置。
- `scripts/codex-isolation-smoke.ts`：真实 Codex CLI + 本机模拟模型服务，确认切换后的模型请求包含历史上下文，保持桌面会话隔离；不消耗在线模型额度。
