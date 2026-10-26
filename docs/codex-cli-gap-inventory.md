# 尚未完成的 Codex 桌面能力与 CLI 支持情况

完整的已实现／未实现对照以根目录 [Codex 功能对照表](../Codex功能对照表.md) 为准。本文件保留最初范围讨论时的缺口快照。

核对日期：2026-10-26。基于工作台 v2.2.30 当前代码、本机 Codex CLI `0.162.0-alpha.17.2` 导出的 App Server 协议与官方说明。

本清单仅记录工作台尚未完整提供的能力，不是本次界面对齐的实施范围。CLI 包含命令行和 App Server；“支持”表示有原生能力或接口，不代表已完成本机端到端验证。实验接口需要能力检测、版本兼容和联调。

| 当前缺口 | CLI 原生支持 | 工作台需要补充 |
| --- | --- | --- |
| 下一条消息预测 | 支持，实验接口 | 请求、展示、采纳与取消；`thread/prediction/request` |
| 会话内容全文搜索 | 支持，实验接口 | 搜索与结果定位；`thread/search`、`thread/searchOccurrences` |
| 指定历史轮次分叉、回退 | 支持 | 历史位置选择；`thread/fork`、`thread/revert` |
| 手动压缩、上下文用量显示 | 支持 | 压缩入口与用量展示；`thread/compact/start`、Token 用量通知 |
| 图片直接输入模型、图片生成与编辑 | 支持 | 真正的图片输入及生成结果交互，区别于仅传文件路径 |
| 实时语音对话 | 支持，实验接口 | 录音、播放、转写和状态；`thread/realtime/*` |
| 原生多 Agent 执行过程与控制 | 支持 | 展示原生子 Agent 状态、调用和结果；区别于手动子会话 |
| 原生长期记忆、持续目标管理 | 支持 | 状态和管理入口；部分记忆控制接口为实验接口 |
| 插件市场安装、卸载、更新 | 支持 | 现有已安装插件选择之外的安装管理 |
| Fast／Ultrafast 速度档位选择 | 支持，受账号和模型限制 | 能力检测、档位选择 |
| 一个项目关联多个代码根目录 | 支持，实验接口 | 多目录配置与展示；项目 `roots` |
| 完整文件树、代码编辑器、交互式终端 | 部分支持 | 文件操作和 PTY 底层可复用，编辑器与终端界面需实现 |
| Diff 审查、Git／PR／CI 操作面板 | 部分支持 | 原生审查和 Git 命令可复用，面板与 GitHub 集成需补 |
| 云任务提交与查看、远程控制配对 | 支持，部分为实验能力 | `codex cloud`、`codex remote-control`；不等于现有 SSH 共享区连接 |
| 高保真原型内嵌预览、点选修改 | 部分支持 | 代码生成原生支持，预览、元素选择和标注需宿主 |
| 交互图表、Office／PDF／LaTeX 内嵌查看 | 不提供完整桌面渲染 | CLI 可生成或处理文件，查看器需额外接入 |
| 内置浏览器、操作已有浏览器和桌面应用 | 需要额外工具或宿主 | 浏览器控制与 Computer Use 插件、服务和权限 |
| Appshots、电脑活动历史、操作录制回放 | 非 CLI 核心原生能力 | 依赖桌面采集、插件与运行环境 |
| 通用定时任务、周期唤醒 | 不提供完整调度服务 | 需要调度器；现有项目 RSI 推荐不是通用任务调度 |
| Dot 完整能力 | 未发现完整 CLI 调用接口 | 原生目标、记忆、多 Agent 仅覆盖部分组件 |

## 核对来源

- [App Server](https://learn.chatgpt.com/docs/app-server)：以安装版本生成的协议为适配依据。
- [图片生成](https://learn.chatgpt.com/docs/image-generation)
- [Visualizations](https://learn.chatgpt.com/docs/visualizations)
- [Browser](https://learn.chatgpt.com/docs/browser)
- [Computer Use](https://learn.chatgpt.com/docs/computer-use)
- [Appshots](https://learn.chatgpt.com/docs/appshots)
- [定时任务](https://learn.chatgpt.com/docs/automations)
- [Dots](https://learn.chatgpt.com/docs/dots)

版本更新后应重新核对，不能仅凭功能开关存在就认定完整能力可用。已实现的基础会话、模型与额度、权限、Plan、队列、桌面同步、Skill/MCP 使用、项目共享和 RSI 推荐不在本缺口清单中。
