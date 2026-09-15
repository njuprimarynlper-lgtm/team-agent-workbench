# 0.1.0 验证记录

日期：2026-09-15。环境：Windows 11 x64。

已通过：

- `npm run typecheck`：TypeScript 编译检查。
- `npm test`：13 项测试，覆盖 SSH 管理身份验证、子管理员访问边界、密码 stdin 传输、SFTP 中文预览/下载/上传、权限拒绝、路径与会话绑定、文件快照、任务恢复和两种 CLI 的协议处理。
- `python -m unittest discover -s tests -p test_admin.py`：5 项测试，覆盖管理操作白名单、root 权限边界、账号身份变更、命令参数与密码分离、撤销子管理员组时断开旧连接。系统命令使用 mock，未在本机操作 Linux 账号。
- `npm run test:ui`：两版开发构建同时运行、独立接口与数据目录、首次连接界面、创建本地工作会话、编辑交接文件、历史默认手动上传、CLI 设置。
- `scripts/check-providers.ts`：官方 Codex 0.154.0 App Server、Cursor Agent 2026.09.10-fd3934a ACP 真实程序初始化成功；未发送付费模型任务。
- 同一检查分别在开发运行文件和最终 `release/user/win-unpacked/resources/providers` 运行；最终 Cursor 417 个发布文件完整复制，含其自身的原生依赖。
- `node scripts/check-packaged.mjs`：两个最终 Windows EXE 同时启动，首次连接界面正常，运行进程、数据目录和可调用接口相互独立；用户版可发现随包提供的两家 CLI。
- 两版分别生成 NSIS 安装程序和完整免安装 ZIP；交付目录提供 SHA256 校验文件。

未宣称完成：公司 Linux 服务器实际建号、PAM/sudo/SSH 规则与目录权限联调；个人模型账号登录后的真实业务任务；在另一台电脑上的安装迁移。当前没有公司服务器凭据，因此没有进行这些外部验证。

共享空间内容管理按照当前范围暂不实现。总管理员可任命项目子管理员；子管理员可以登录并看到自己被分配的项目，但内容管理页面尚未开放。
