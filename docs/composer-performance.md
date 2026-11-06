# 输入框响应与草稿保存

输入框按会话订阅本账号窗口的内存草稿，主发送框、子会话和其他会话互不触发整页更新。发送、引用回复、添加附件及失败恢复均读取最新草稿，不依赖上次工作区渲染时捕获的文字。

子会话和临时侧聊保持稳定的历史渲染回调；侧栏隐藏时暂停绘制历史，重新打开时使用最新快照。组件不卸载，保留输入、工具折叠状态和滚动位置。流式回复只重新解析正文发生变化的 Markdown，文件、图片和链接仍使用最新会话上下文。

每次编辑仍立即通过 IPC 更新主进程内存，不把最后几个字只留在界面。磁盘写入在停止输入约 300 毫秒后合并，仅写 `inputs.json`，不复制会话历史或触发账号同步。失焦、切换会话和发送前强制保存；完整存储保存（包括关闭流程）也会先排入待写草稿。所有写入沿用同一有序队列，旧稿不得覆盖新稿或复活已发送的文字。保存失败保留内存草稿并显示错误，可在恢复磁盘后重新编辑或触发保存重试。

## 验证

```powershell
node scripts/test-background.mjs tests/session-input-autosave.test.ts tests/composer-optimistic-input.test.ts tests/core.test.ts tests/store-session-integrity.test.ts
node scripts/composer-performance-smoke.mjs
npm run typecheck
npm run build:check
# 使用上述检查输出的完整临时目录（或已有的当前版本构建），不会覆盖运行中的应用：
node scripts/composer-draft-lifecycle-smoke.mjs C:/完整路径/workbench-build-check-XXXX/user
```

性能冒烟使用当前真实渲染器、Edge 无头实例、隔离样本和模拟 API；覆盖 10/100 轮对话、主/子输入及隐藏侧栏，逐键断言工作区、历史和 Markdown 不重绘，并报告编辑到下一帧的耗时。另检查中文编辑/IME 确认、最新草稿引用、发送失败不覆盖后续编辑、切换、隐藏期间的新回复补齐、流式更新及折叠和滚动状态保留。耗时受测试机器负载影响，不视为所有电脑的性能保证。

桌面生命周期冒烟使用隔离的临时账号和 CLI 桩、真实 Electron/IPC/磁盘，直接走应用的窗口关闭流程，再重启核对草稿；不调用外部模型或读取个人模型账号。单元测试额外覆盖批量写入、写入中强制保存、失败重试及旧稿不得复活。
