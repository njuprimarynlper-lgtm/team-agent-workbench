# 0.4.0 本地文件系统验收用例

本次实现重点是用真实本地目录替代共享服务器，用应用层权限桩验证管理员与成员协作。保留原有 Linux/SFTP 模式。权限桩不会修改操作系统账号或 ACL。

| 场景 | 验证内容 | 用例入口 |
|---|---|---|
| 首次管理员 | 专用空目录初始化；拒绝接管非空目录；登记测试管理员；错误密码与普通成员不能进入管理员操作；重连保留记录 | `tests/local-space.test.ts`、`scripts/local-smoke.mjs` |
| 用户与项目组 | 创建组自动建立目录；创建成员时分组与任命组管理员；重复账号拒绝；最长账号和组名可以直接登录 | `tests/local-space.test.ts` |
| 成员登录 | 本地桩直接绑定共享目录和成员身份；正式使用由成员填写服务器地址与个人账号；密码只以加盐哈希保存在桩记录 | `tests/local-space.test.ts`、`scripts/local-smoke.mjs` |
| 项目创建 | 只有组管理员能建项目；自动建立 submissions/trajectories；同名不覆盖；普通成员刷新发现项目 | `tests/local-space.test.ts`、`scripts/local-smoke.mjs` |
| 文件共享 | 上传写入真实磁盘；队列完成后另一成员可预览和下载；不能覆盖已有成果，不能向他人成果目录写入 | `tests/local-space.test.ts`、`scripts/local-smoke.mjs` |
| 轨迹与来源 | 每会话独立交接；历史 ZIP 真实落盘；他人轨迹不可读；共享资料引用冻结为本机快照 | `tests/local-space.test.ts`、已有 `tests/core.test.ts` / `tests/usability.test.ts` |
| 动态撤权 | 已连接成员停用后下一次读写拒绝；恢复启用后恢复访问；换组与撤销组管理员立即重新校验；改密码后旧凭据拒绝 | `tests/local-space.test.ts`、`scripts/local-smoke.mjs` |
| 路径与身份 | 拒绝越界、Windows 保留名/ADS、大小写绕过、符号链接与目录联接；拒绝伪造绑定与项目标记变更 | `tests/local-space.test.ts` |
| 本地持续工作 | 不同 session 输入/交接独立；退出重启可离线恢复；共享操作仍需重连 | `tests/local-space.test.ts`、`scripts/smoke.mjs` |
| 三个窗口并行 | 同时打开管理员、Alice、Bob；接口隔离、数据目录独立、共享区同一目录；模拟 CLI 登录前置检查 | `scripts/local-smoke.mjs`，支持 `--packaged` |
| Codex 文件批准 | 请求只含 itemId 时仍呈现此前收到的路径与 diff；不串其他会话或上一轮；界面展开详情并拒绝 | `tests/agents.test.ts`、`scripts/local-smoke.mjs` |
| 演练续跑 | 原生完成事件及轮次匹配后才能跳过模型调用；文本只容许 LF/CRLF 转换，二进制仍精确校验 | `tests/pilot-evidence.test.ts` |
| Linux 模式回归 | 原 SSH/SFTP transport、真实权限拒绝响应、用户管理命令替身、失败恢复及原界面流程 | `npm run check`、Python unittest、`scripts/smoke.mjs --packaged` |
| 安装产物 | 两 EXE 同时运行；ASAR 与构建一致；用户包不含管理脚本；ZIP CRC 完整；官方 Codex/Cursor 文件逐个一致 | `scripts/check-packaged.mjs`、`scripts/verify-release.mjs` |

## 真实 Codex 比赛演练

使用用户指定的 0831-V1 任务书、六接口模板、公开 mini_sample 与 self_check。原给定 `_test` 路径当前不存在，实际同名资料位于 `D:\project\NVFP4HiF4` 根目录及其 `example`。仅复制指定资料到独立演练目录；不编辑原项目及其中已有未提交改动。

| 顺序 | 模拟成员 | 实际工作 | 协作输入与输出 |
|---|---|---|---|
| 1 | Alice 第一轮 | 编写合法六接口朴素量化器、单元测试和公开自检 | 输入任务资料；输出代码版本、第一轮说明与轨迹 |
| 2 | Bob 第一轮 | 合入 Alice 代码，建立输出误差与耗时评估工具 | 从共享区取 Alice 说明作为会话引用；代码通过本地 Git 合入 |
| 3 | Alice 第二轮 | 使用 Bob 反馈进行单一量化改进，保留 baseline 对照 | 从共享区取 Bob 说明，使用同一评估器比较 |
| 4 | Bob 第二轮 | 独立复核、补边界测试、给出采用建议 | 重新执行两方案验证；输出最终报告与轨迹 |

`scripts/competition-pilot.ts` 使用用户版共用的 Workbench 核心驱动真实 CLI；这是可重放的集成演练。界面操作由单独的三个窗口测试覆盖，不能把测试驱动自动执行的 Git/共享动作描述成人工点选。CLI 额外权限请求逐项复核后回传；演练脚本不会自动批准任意命令。

本机两名成员是模拟团队身份，真实模型调用复用当前 Windows 用户已有的个人 Codex 登录。没有第二个真实模型账户，也没有官方比赛平台提交。算法是从接口模板起步的联调候选，不替代原项目的成熟解法。官方标准量化器与目标判题机器未接入，因此不得报告官方得分或目标服务器耗时。

实际四轮完成状态、原生会话 ID、Git 提交及运行结果以演练目录中的 `result.json`、`rounds.json` 和各轮 Markdown/JSON 为准；没有对应成功记录的步骤不计为通过。

## 仍待目标环境验证

Linux ACL、sudo/PAM/sshd 与另一台电脑迁移不在本地权限桩的验证范围内。已有并发认证问题仍按 `auth-concurrency-plan.md` 保留为方案项，没有计入本版已修复项目。
