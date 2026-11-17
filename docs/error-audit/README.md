# 报错整改验证说明

主要入口：[报错整改报告](报错整改报告.html)。移动时请保留整个目录，包含 `screenshots/` 和 `readability-baseline/`；网页可离线搜索、筛选、放大和跳转。

本轮重新按人的理解审查：149 个主场景中，148 项逐项至少 9 分，1 项修复后已没有错误，记 N/A；23 张涉及提示及恢复的补图也逐张通过。分数来自独立 subagent 的主观评审，不代表真实用户研究。其他测试桩动作截图只作功能证据，不计入 9 分统计。

当前门禁使用 `readability-review.json`：每项分数、事实签核和当前截图哈希必须同时有效，补图也须满足；不能用平均分、自动断言或旧图片的通过记录替代。`initial-readability-review.json` 的初评 127 项及所有低分返修记录保留。本轮起点的真实旧图存于 `readability-baseline/`，原始 Git 基线图继续保留。

- 基线：`d4d51bb30d23f03a883867054a893c547e558f9e`，v2.3.46。
- `inventory.json`：对基线源码的 AST 候选扫描，以及 Python/启动脚本的异常候选。父容器和同一传播路径可能重复，不将候选数量当作独立错误场景数量。
- `user-review.json`、`admin-review.json`、`pipeline-review.json`：每个候选的处置和依据，明确区分规则分类与直接源链检查。
- `*-scenarios.json`：从真实生产 React 组件、完整界面或原生对话框得到的前后证据。故障来自隔离的合成数据及协议桩，不连接实际中央节点、不读取真实会话、不启动付费模型。
- `readability-review.json`：本轮逐图复述、评分、事实签核和补图记录。`visual-review.json` 及 `visual-review-round1.json` 只作上一轮历史证据。
- `candidate-followup.json`：68 条曾建议单独修改的候选逐条收尾；区分正常行为、内部诊断、实际修改和共用界面，保留额外发现的验证依据。
- `readability-verification.json`：本轮 8 组专项回归通过；额外的成果生命周期、展示完整文件回归为 20 通过、1 失败，失败与固定基线的旧快照标识问题一致，未跳过或冒充通过。各批次有重叠，不把通过数量相加当成独立测试总数。
- 原生截图工具返回 JPEG。当前报告使用与原捕获字节完全一致的 `.jpg` 副本；最初的 `.png` 命名文件保留供首轮历史记录追溯，没有转码或改图。
- `log-scope-verification.json`：实际 Electron IPC 验证首次/重复失败定位和跨窗口拒读。
- 正文及模型、工具输出不作批量改写；内部异常和错误码保留原业务语义，技术原因记入脱敏日志，界面通过独立的结构化错误信息展示。

## 复现

固定基线目录（已存在时直接使用）：

```powershell
git worktree add --detach .test-data/error-audit/baseline d4d51bb30d23f03a883867054a893c547e558f9e
```

TypeScript 7 不提供 JavaScript AST API；扫描工具使用隔离安装的 TS 5，不改变产品依赖：

```powershell
npm --prefix .test-data/error-audit/ast-tools install typescript@5.9.3 --no-save --package-lock=false --ignore-scripts
node scripts/error-audit-inventory.mjs
```

以下是最初 Git 基线的重放方式。已冻结的 before 和起点评审应保留，不能用当前代码回填旧图。第二轮修订前源码保存在本机 `.test-data/error-readability/baseline`；新增补查场景及两项夹具纠正均在报告中明确标注，没有冒充最初基线。

```powershell
node scripts/error-audit-user.mjs --phase=before --source=.test-data/error-audit/baseline
node scripts/error-audit-user.mjs --phase=after
node scripts/error-audit-admin.mjs --phase=before --source=.test-data/error-audit/baseline
node scripts/error-audit-admin.mjs --phase=after
node --import tsx scripts/error-audit-boundary.mjs --phase=before --source=.test-data/error-audit/baseline
node --import tsx scripts/error-audit-boundary.mjs --phase=after
```

第二轮管理域 after 使用 `--readability-round=2`；用户新增 u52 的 before 需显式 `--new-readability-scene`。`error-audit-notices.mjs` 先复用用户域生成的隔离完整 App 种子，再把实际后端事件或受控故障送进生产界面；不读取个人数据。

日志桌面验证使用 `node scripts/build.mjs --check` 输出的独立目录，传给 `error-audit-logs.mjs --phase=after --build=<目录>`。`logging-smoke.mjs` 和 `error-audit-log-scope.mjs` 同样支持指定独立构建。原生窗口由 `error-audit-native.mjs`、`error-audit-launcher.mjs` 和 `error-audit-launcher-export.mjs` 启动隔离故障；现界面直接调用生产 Electron／WinForms 代码。原生自动布局和 DPI 可能改变窗口尺寸，截图没有裁切、合成或转码。

```powershell
node scripts/build-error-audit-report.mjs
node scripts/verify-error-audit-report.mjs
npm run typecheck
npm run build:check
```

报告验收以当前图片散列与独立复审相符为准。`verify-error-audit-report.mjs` 会拒绝低于 9 分、补图未签、哈希过期或候选收尾待办。`verification.json` 保留首轮全量与基线记录，其中 3 个基线也能复现的失败没有冒充通过。本轮源码、回归及报告均独立于正在维护的用户手册。
