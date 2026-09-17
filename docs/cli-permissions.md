# CLI 权限检测与人工授权

适用于用户版 Codex / Cursor 会话。权限检测与账号登录分开；沙盒故障不触发重新登录，也不会自动扩大权限。

## 使用入口

- 新建会话 → 执行权限：默认「CLI 原有设置」，可选「人工审批」「完全权限」。
- 现有会话 →「修改权限」：调整当前会话的执行权限，保留原生会话 ID、模型、历史和项目绑定。正在执行时按钮明确为「停止当前任务并应用」。失败操作不会自动重试，用户再次发送任务才继续。
- 会话只显示一行「当前权限 + 可能影响」，旁边提供「修改权限」按钮。有实际运行权限时优先显示实际范围，如「当前为只读权限，可能无法修改文件或运行需要写入的命令」。不展示执行自检、错误码、原始报错或技术详情入口；诊断信息仍保留在本地记录中。
- 授权请求 → 顶部「待授权提醒」，可从其他会话或成果页跳回对应操作。后台窗口请求授权时闪烁任务栏，用户聚焦后停止闪烁。命令、目录、原因直接呈现，原始详情与文件 diff 可展开；用户允许或拒绝后才回传 CLI。
- 成果整理的授权仍显示在成果草稿中，不创建可见的额外工作会话。

## 各模式的实际行为

| 模式 | Codex app-server | Cursor ACP |
| --- | --- | --- |
| CLI 原有设置 | 不覆盖 thread/start/resume 的权限参数；读取启动响应中的生效值 | 保留原有配置和会话模式，报告允许、拒绝规则与只读模式 |
| 人工审批 | workspace-write + untrusted + user；安全读取等仍可能由 CLI 直接执行 | Agent 模式，处理原生一次性授权请求；有自动允许项或自动审核配置时先提示用户修改 |
| 完全权限 | danger-full-access + never + user | 显式使用 --force --sandbox disabled 启动；团队策略及明确拒绝规则仍生效 |

完全权限仅对应当前 Windows 账号的能力，不取得系统管理员权限。工作台不绕过 CLI 的强制策略。即使选择完全权限，CLI 实际发出的授权请求仍展示给用户，不由工作台自动代答。

Codex 人工审批启动后校验 CLI 返回的审批策略及审核者；无法确认时不开始模型任务。管理员允许模式通过 configRequirements/read 检测，禁止的选项不可选择；原生 CLI 启动时仍是最终的执行约束。

Cursor 的全局允许列表可能让操作不经询问。用户展开「配置 Cursor 人工审批」并点击应用，才会修改账号的 cli-config.json 和当前工作目录的 .cursor/cli.json：设为 allowlist、清空 allow、保留 deny 和登录及其他配置。界面说明对同一配置其他 CLI 会话的影响。原文件生成独立备份，先校验两个文件，再原子替换已有文件；无法读取或格式无效时不认定人工审批已配置成功。工作台中的运行中 Cursor 会话需先停止；空闲 ACP 进程重启以重新读取规则。

人工审批是 CLI 工具执行时的授权，不等于逐行审阅所有模型输出，也不承诺每条命令都会产生弹窗。来自 CLI 的一次性允许/拒绝范围必须被遵守；仅有永久授权选项时，工作台取消请求，不扩大授权范围。旧请求按钮不能审批后续复用同一原生请求 ID 的操作。

成果整理继续固定为 Codex read-only / Cursor ask，不继承父会话的完全权限。

## 检测范围

Codex 读取配置和管理员约束，不读取或传播账号密钥。启动原生会话后使用 CLI 返回的实际 sandboxPolicy 执行一次输出固定标记的无副作用命令；不写文件、不访问网络、不调用模型。只读命令通过仅说明基础命令能启动，不证明全部目录、网络、下载和写入都可执行。诊断结果保存在本地记录中，权限提示只显示当前权限与可能影响；网络断开和未登录不归类为权限失败。

Cursor ACP 当前没有等价的独立命令自检接口，因此根据已保存配置和所选权限模式提示可能影响，不显示虚构的检测成功。

2026-09-17 本机 Codex 0.154.0 原生协议验证：临时会话返回 workspaceWrite / untrusted / user；命令自检实际复现 `windows sandbox: CreateProcessWithLogonW failed: 1385`，并归类为执行受限。验证未调用模型、未创建持久会话、未修改个人 CLI 配置。Windows 原生沙盒不支持自定义 outputBytesCap，探测在 Windows 上省略该参数。

## 用例

| 用例 | 验证入口 |
| --- | --- |
| 配置只读、禁止审批、管理员限制可选模式、保留登录秘密 | tests/permissions.test.ts |
| 实际沙盒失败、与登录及网络错误区分、不自动提权 | tests/permissions.test.ts |
| 明确手动/完全权限参数、强制策略拒绝后不自动回退 | tests/permissions.test.ts |
| Cursor 修改须显式点击、备份、保留 deny/登录、不完整配置不误判 | tests/permissions.test.ts、scripts/permissions-smoke.mjs |
| 原生授权允许、拒绝、拒绝限定范围、无一次性选项、过期请求 | tests/permissions.test.ts、tests/agents.test.ts |
| 跨会话提醒与路由、改变权限保留会话、停止挂起请求、不自动重试 | scripts/permissions-smoke.mjs |
| 只读、工作目录内读写、人工审批、完全权限的影响提示；权限入口可用；提示及权限窗口不显示原始报错 | scripts/permissions-smoke.mjs |
| 授权出现在隐藏整理任务对应草稿、取消、关闭、重试 | scripts/session-experience-smoke.mjs |

执行 `npm run typecheck`、`npm test`、`npm run build`、`npm run test:permissions-ui` 和 `npm run test:session-ui`。桌面测试使用独立数据目录和 Cursor 配置，未修改真实账号权限。

2026-09-17 验收：类型检查与两版构建通过；完整 Node 回归 66 项通过；最后对原生轮次与授权隔离的修正完成 11 项专项复测；权限桌面用例及原有会话/成果整理桌面回归通过，窗口截图已检查。开发构建同步至原有本地打桩入口，未生成新安装包。

2026-09-17 权限提示简化：类型检查、两版构建与权限桌面用例通过，覆盖运行时报错、只读自检失败、四种权限说明、修改权限、人工授权和不自动重试。已检查只读界面截图；使用隔离打桩目录，未修改用户现有权限。

接口依据：本机 Codex 0.154.0 生成的协议类型、[Codex app-server](https://developers.openai.com/codex/app-server)、[Codex 安全配置](https://developers.openai.com/codex/security)、[Cursor ACP](https://cursor.com/docs/cli/acp)、[Cursor 权限](https://cursor.com/docs/cli/reference/permissions)、[Cursor 参数](https://cursor.com/docs/cli/reference/parameters)、[Cursor 配置](https://cursor.com/docs/cli/reference/configuration)。
