# CLI 批准模式与访问范围

## 用户界面

新建会话和输入框底部的权限菜单使用各提供方的原生名称。默认沿用原设置，只有用户明确选择后才覆盖当前会话。

| 提供方 | 选项 | 用户可见的行为 |
| --- | --- | --- |
| Codex | 请求批准 | 在工作目录内执行，超出范围时向用户请求批准 |
| Codex | 帮我批准 | 由 Codex 自动审查符合条件的批准请求，仍可能需要用户确认 |
| Codex | 完全访问 | 可访问本机账号允许的文件和网络，通常不再请求批准 |
| Cursor | Allowlist（白名单） | 已允许的操作直接执行，其余操作可能需要用户批准 |
| Cursor | Auto-review（自动审查） | 当前 ACP 接入不提供可靠的切换支持，选项禁用并注明原因 |
| Cursor | Run Everything（全部运行） | 自动执行工具操作，明确禁止的操作仍可能被拒绝 |
| Claude Code | 手动批准 | 未预先允许的操作交给用户单次确认 |
| Claude Code | 自动审查 | 使用 Claude Code 的 `auto` 模式，仍可能要求用户确认 |
| Claude Code | 跳过权限询问 | 使用 `bypassPermissions`，仍受明确拒绝规则和组织策略约束 |

当前权限显示在输入框底部，点击后向上展开选项及影响说明，不再单独占用聊天区上方一行。不显示底层错误、错误码或沙盒探测日志。模式名表达批准行为；文件是否可写是独立的限制，不命名为“只读权限”或“工作目录内读写权限”。

Codex 只有运行时返回的批准策略、审核者与访问范围匹配预设时才显示该预设。例如只读加人工批准显示“当前：自定义设置（请求批准）”，后面说明修改文件需要额外授权。禁止批准的自定义配置明确提示受限操作可能无法完成。运行时的真实范围优先于用户选择；尚未执行的选择显示“已选择”，读取的 CLI 配置显示“已保存设置”。

## 参数与支持范围

| Codex 选择 | sandbox | approvalPolicy | approvalsReviewer |
| --- | --- | --- | --- |
| 沿用 Codex 设置 | 不覆盖 | 不覆盖 | 不覆盖 |
| 请求批准 | workspace-write | on-request | user |
| 帮我批准 | workspace-write | on-request | auto_review |
| 完全访问 | danger-full-access | never | user |

不再使用已退役的 untrusted 作为“请求批准”的映射。旧本地 review 值保留，但下次启动/恢复会话发送正确的 on-request。旧运行记录中的 untrusted 显示为自定义设置。

configRequirements/read 的 allowedSandboxModes、allowedApprovalPolicies、allowedApprovalsReviewers 用于禁用管理员不允许的选项。Codex 启动后校验批准策略和审核者；不一致时不开始模型任务，不自动重试或提权。Windows 尚未配置沙盒时，Codex 可能把请求的 workspace-write 收窄为 readOnly；此时界面如实说明限制，仍允许读取和分析。

Cursor Run Everything 显式使用 --force --sandbox disabled acp，仍受团队策略和拒绝规则约束。Allowlist 沿用既有的明确配置动作：点击“应用 Cursor Allowlist 配置”才清空账号和当前目录的 allow，保留 deny、登录信息和其他配置，并备份原文件。修改前检查两个文件以及运行中的 Cursor 会话，空闲进程重新启动读取配置。

Cursor CLI 的命令行帮助包含 --auto-review，但本机打包版本的 ACP 路径未可靠接入该选择，不能仅根据 CLI 通用参数宣称已生效。因此不发送此参数、不把它映射为 --force，也不修改账号的自动审查设置。后端同样拒绝通过接口给 Cursor 创建或切换 auto 会话。已有配置中的 auto-review 可以作为“已保存设置”显示，不承诺为当前 ACP 会话生效。Agent / Ask / Plan 是任务模式，不作为批准模式。

Claude Code 沿用设置时不传 `--permission-mode`；手动批准、自动审查、跳过权限询问分别传 `default`、`auto`、`bypassPermissions`。`-p` 会话通过 `--permission-prompt-tool stdio` 把未被规则决定的工具请求和 `AskUserQuestion` 交给用户端。工作台只答复当前请求，不写入 Claude Code 的永久允许规则。CLI 已保存的允许、拒绝和组织策略继续生效。当前界面不能可靠读取这些规则的完整有效集合，因此“已保存设置”显示为沿用 Claude Code 设置，不推断具体文件或网络范围。

## 会话与授权

修改权限重启当前会话的底层进程，保留原生会话 ID、模型、消息和项目绑定。运行中需先停止；修改后由用户主动继续，不重放任务。切换提供方时不会把 Codex 的“帮我批准”带入 Cursor。

来自 CLI 的一次性批准请求仍交给用户，包含“帮我批准”或完全访问下实际发出的残余请求。工作台不代用户点击允许，不把一次性授权扩展成永久授权；过期请求不能审批后续操作。

成果整理单独固定为完全访问：Codex danger-full-access + never，Cursor --force --sandbox disabled + Agent 模式，Claude Code `bypassPermissions`；新建、重试和旧整理助手恢复均使用该策略，不继承或修改原工作会话的权限。整理范围仍由任务要求限定为冻结材料，上传仍需用户确认。Codex 会话独立存储及旧会话上下文迁移保持不变，见 [会话隔离](codex-session-isolation.md)。

## 验证

- tests/permissions.test.ts：三种 Codex 参数、审核者不匹配拒绝、管理员约束、收窄为只读仍能分析、原生名称与自定义范围、Cursor 不支持选项的后端校验、原生授权及配置保护。
- scripts/permissions-smoke.mjs：两家选项名称、模式切换、Codex 自动审查后仍能人工批准、保持会话 ID、不自动重放、Cursor 配置、界面不显示技术报错。
- scripts/permission-presets-smoke.ts：本机 Codex 0.154.0 的真实 app-server 协议。使用独立目录、临时会话和无需鉴权的本地模型配置，验证请求批准/帮我批准/完全访问的返回值；不发起模型轮次。
- scripts/codex-isolation-smoke.ts：真实 CLI 配合本地模拟模型，验证会话隔离及修改权限前后的上下文延续。

执行 npm run typecheck、npm run build、npm run test:permission-presets、npm run test:permissions-ui，以及权限、会话生命周期和 Agent 协议专项测试。桌面验证使用隔离测试目录，不修改真实账号配置。开发构建供本地打桩入口使用；不生成安装包。

依据：[Codex 权限与沙盒](https://learn.chatgpt.com/docs/sandboxing)、[Cursor Run Modes](https://cursor.com/docs/agent/security/run-modes)、[Cursor CLI 配置](https://cursor.com/docs/cli/reference/configuration)、[Cursor ACP](https://cursor.com/docs/cli/acp)，以及本机两个 CLI 的协议/实现。

成果整理权限回归：`tests/preparation-permissions.test.ts` 与 `npm run test:preparation-permissions-ui` 验证 Codex/Cursor 在来源会话为人工审批时仍以完全访问整理，正常执行不出现批准请求，重试保留补充且不会自动上传。真实 Codex 的 `test:permission-presets` 包含整理助手的实际返回权限验证。
