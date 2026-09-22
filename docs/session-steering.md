# 会话生成中的引导

Codex 正在生成或等待授权时，在原输入框补充要求，点击“引导”或按 Enter，先打开二次确认框，查看目标会话、补充内容及附带参考和能力；点击“确认发送引导”才提交给当前执行轮次。取消时保留输入，普通发送不增加此确认。Shift+Enter 仍换行；“停止”按钮独立保留。任务尚未就绪时不能引导。

- 使用官方 App Server `turn/steer`，携带当前 `threadId` 和 `expectedTurnId`；不新开轮次，不先中断任务，也不修改模型或权限。
- 新勾选的成果、文件、Skill 与插件随引导发送。文件快照先验证哈希；已经送达的引用不重复附带。
- 只有 CLI 确认接收后才记录为“引导”并清空对应输入。等待期间切换 Session、编辑文字或修改勾选，不清空后来输入的内容。失败保留输入，不自动重试或转成新一轮问题。
- 执行已经结束、轮次变化、停止、关闭、重复点击、引用失效均有检查。引导失败不把原本运行中的任务标成失败；待授权项不会被引导绕过。
- 当前轮次 ID 只在运行时快照中提供，不作为重启后可继续引导的状态恢复。已送达的用户消息和引用状态仍正常持久化。
- 确认框冻结打开时的输入与轮次；原任务结束、停止、关闭或换轮后，不能把旧确认转成下一轮发送。用户取消或发送失败不清空草稿，发送成功也不覆盖确认后新输入的内容。

Cursor 产品有 Send now。当前工作台使用的 ACP 接入尚未接入同等能力：本机 `2026.09.15-d2fe57e` 的 ACP `handlePrompt` 会在新 prompt 到来时先调用 `pendingPromptCancel`。不能把并发 `session/prompt` 当作不中断的引导。官方 SDK 已提供 `run.steer()`；后续更换接入前，需要验证登录、权限和旧会话兼容性，不能删除或无提示转换既有 Session。本批保持现有 Cursor 行为并明确显示接入限制。

验证包括真实 JSON-RPC 管道中的模拟 CLI 回归、静态页面渲染和输入确认逻辑测试；没有运行真实模型请求或可见界面测试。

参考：[OpenAI App Server](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)、[Cursor Send now](https://cursor.com/docs/agent/overview#steer-a-running-agent)、[Cursor SDK steering](https://cursor.com/docs/sdk/typescript#steering-a-run-in-flight)。
