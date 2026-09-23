# Claude Code 接入

用户版可以在新建会话时选择 Claude Code。工作台调用本机安装的 `claude` CLI，沿用它自己的登录与配置；团队 SSH 账号、项目权限和模型账号仍相互独立。管理员版不需要保存任何 Claude 凭据。

## 准备与登录

1. 按 [Claude Code 官方安装说明](https://code.claude.com/docs/en/quickstart) 在成员电脑安装 CLI，确认 `claude --version` 可运行。若自动检测不到，在“设置 → 本机与 CLI”选择 `claude.exe` 或 `claude.cmd`。
2. 在工作台的 Claude Code 账号卡片点击“登录个人账号”；也可以先在终端执行 `claude auth login`。工作台用 `claude auth status` 检测登录，不保存 OAuth 令牌。若已有 API Key、Bedrock、Vertex 或 Foundry 配置，模型计费由这些环境配置决定，应先在原生 CLI 核对。
3. 新建会话选择 Claude Code 和模型。留空沿用 CLI 默认模型；Sonnet、Opus、Haiku 是 CLI 支持的别名，实际可用模型由账号和组织配置决定。工作台不猜测套餐额度，可通过“官方额度页”查看。

## 对话与权限

Claude Code 会话通过 `stream-json` 接入。每轮结束保存原生会话 ID，下一轮以该 ID 续聊；切换模型或权限后仍尝试续聊同一上下文。对话框显示文字、工具调用、工具结果和结构化提问。工作台采集这些可见事件用于本地记录和用户主动上传的轨迹，不声称获得模型的隐藏推理。

会话中的权限选择对应 Claude Code 原生模式：手动批准对应 `manual`，自动审查对应 `auto`，跳过权限询问对应 `bypassPermissions`；“沿用设置”保留 CLI 配置，并将未预先决定的请求交给工作台。CLI 发来的单次操作授权及 `AskUserQuestion` 会显示在会话卡片中，用户可允许、拒绝或填写答案。成果整理使用完全权限，由工作台原有整理流程控制。修改权限不会自动重放已经失败的操作。

Skill 从当前项目及个人 `.claude/skills`、`.claude/commands` 中发现，按 Claude Code 的 `/name` 命令在下一条消息中调用；已安装插件由 `claude plugin list --json` 列出，安装和启停仍在 Claude Code 内完成。生成中的补充引导暂不支持；等待本轮结束后再发送即可。工作台不把 Claude Code 自行打开的其他会话自动纳入团队记录。

## 网络出口

可直连的成员保持“通过管理端访问模型服务”关闭。需要转发时，管理员在“网络出口”中单独启用 Claude Code，测试 `api.anthropic.com` 连通后提供接入码；用户版仅给本工作台启动的 CLI 注入代理环境。该出口限制为已启用产品的官方域名和 TCP 443，不代理任意网站，也不改变共享空间的 SSH/SFTP 权限。

## 验证范围

本仓库的打桩用例覆盖旧设置迁移、登录状态、两轮同一会话、流式输出、授权与结构化提问；类型检查和构建检查覆盖两端入口。正式部署前仍需在目标电脑用其本人账号做一次真实 Claude Code 对话，并分别核验直连与管理端出口、组织策略、模型可用性和额度页面。
