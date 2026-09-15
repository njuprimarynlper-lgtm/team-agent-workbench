# 团队工作台

Windows 本地 Agent 工作台与独立的团队管理应用。远端使用 Linux 账号、SSH/SFTP 和文件系统，无常驻业务服务。当前版本 **0.1.0**。

## 两个应用

| 应用 | 当前功能 | 本机数据目录 |
| --- | --- | --- |
| Team Agent User 用户版 | Cursor / Codex 会话、共享文件浏览与引用、交接文件、成果草稿与上传、会话归档 | `%APPDATA%\TeamAgentUser` |
| Team Agent Admin 管理员版 | 用户创建、密码重置、启停账号、用户组、项目子管理员任命 | `%APPDATA%\TeamAgentAdmin` |

两个应用可同时运行，拥有不同的安装标识、快捷方式、入口、IPC 接口和配置目录。用户版不包含管理员 Python 程序、用户管理接口或“切换管理员”按钮。

管理员版识别两种身份：

- **总管理员**：以服务器已有 root 或 sudo 账号登录，经远端实际权限验证后进行用户管理。
- **项目子管理员**：以总管理员创建的个人账号登录，从服务器 root 拥有且普通用户不可修改的任命记录中读取所属项目。只能进入项目内容管理入口，不能调用用户管理接口。

**本版尚未实现共享空间内容管理。** 子管理员任命、识别和权限隔离已实现，内容管理页面显示待开放。项目目录、内容整理和目录 ACL 暂由运维在 Linux 上配置；任命子管理员不会自动给所有目录添加写权限。

## 安装与迁移

产物位于 `release/admin` 和 `release/user`：

- `TeamAgent-admin-0.1.0-x64.exe`：管理员版安装程序。
- `TeamAgent-user-0.1.0-x64.exe`：用户版安装程序。
- 同名 `.zip`：免安装目录压缩包，**解压全部文件**后运行 `Team Agent Admin.exe` 或 `Team Agent User.exe`。

支持 Windows x64；当前在 Windows 11 验证。安装包未配置企业代码签名证书。安装程序可选择安装位置，卸载默认保留用户数据。两版运行都无需预先安装 Node.js；用户版包含 Cursor Agent 与 Codex CLI 运行文件，管理员版不包含模型运行文件。

迁移到其他电脑只需复制对应安装包或完整的免安装压缩包，重新配置服务器并登录个人模型账号。不会把开发者的账号、密码、工作记录打进安装包。

## 第一次连接

两个应用启动时均打开服务器连接对话框。地址、端口、Linux 账号、服务器指纹可保存；登录密码和 sudo 密码只保留在本次连接的内存中，不落盘，不进入模型 prompt。修改信息后重新连接即可生效。

管理员版通过左下角 **连接设置** 修改，用户版通过右上角服务器按钮或左侧 **配置连接** 修改。首次连接需要与运维核对 SSH SHA256 主机指纹；已有指纹不匹配时拒绝连接。换服务器后重新核对。

总管理员需要服务器已经存在的 root 或 sudo 管理账号。Windows 的管理员身份、安装顺序、应用名称都不能赋予 Linux 管理权限。普通成员仅需要服务器分配的个人账号。

## 总管理员操作

1. 输入 SSH 地址、端口、管理账号、密码和团队根路径，例如 `/srv/teamspace`。sudo 密码与登录密码相同则留空。
2. 首次点击 **初始化账号管理**：要求指定路径不存在或为空，创建账号登记、专用成员组和 root 保护的元数据目录。已有团队使用原路径，不重新初始化。
3. **配置接入规则**：明确确认后，将本团队成员组限定为密码认证的 `internal-sftp`，以团队根路径为 chroot，禁止终端和端口转发。工具先执行 `sshd -t`，再重载 SSH 服务；校验/重载失败恢复原配置文件。
4. **创建用户**：填写 Linux 账号、姓名和初始密码。密码至少 8 位，不能有冒号、换行或空字符。工具不接管已有 Linux 账号，不自动创建 root/sudo 管理员。将初始凭据通过公司的既有渠道交给本人。
5. **创建用户组**：例如 `ocr`，生成带团队前缀的普通成员组和内容子管理员组。
6. 在用户行点击 **组与子管理员**：选择成员所属组，并按项目任命内容子管理员。
7. 重置密码、停用账号或调整组成员时，旧的远端会话/进程会被终止，以便新密码、禁用和组权限立即生效。这些账号应专用于团队共享；本地 CLI 会话不因此结束。

每个管理操作都经 SSH 发送固定程序与结构化输入，调用 `useradd`、`usermod`、`groupadd`、`gpasswd`、`chpasswd` 等系统命令。密码经加密连接的 stdin 传递，不插入远端命令参数。服务器上的操作以锁串行执行，登记文件以替换方式写入。Linux 多步操作不是事务；操作中断或部分失败时应刷新实际状态后处理，不应盲目重试。

账号登记：`<团队根路径>/.workbench/admin/state.json`；操作日志：同目录 `audit.jsonl`；子管理员入口任命：`<团队根路径>/.workbench/roles.json`。后者没有密码，root 拥有、成员只读；客户端还检查它及父目录的属主、写权限和符号链接。各项目实际读写仍由 Linux 文件权限控制。

服务器要求：Linux、Python **3.9+**、OpenSSH、shadow/passwd 用户管理命令、procps。SSH 规则自动配置另外需要 systemd，以及主 sshd_config 中已启用 `/etc/ssh/sshd_config.d/*.conf` 的 Include。需要输入 TTY 的 sudo 策略暂不支持。不同发行版的 SSH/PAM 策略请由运维确认。

## 共享目录和用户版入口

本版不自动创建项目内容和 ACL。运维按团队策略创建各项目的参考目录、成果目录和会话归档目录，并将 Linux 组或个人 ACL 应用到相应路径。目录 ACL 的设置示例见 `examples/README.md`。

用户版可导入 `examples/member-connection.json` 格式的配置，或者在连接对话框中手动填写项目入口。配置只有路径提示，不赋予文件权限。

启用本工具的 chroot 规则后，服务器 `/srv/teamspace/projects/ocr` 在成员 SFTP 中显示为 **`/projects/ocr`**。不能把 chroot 外部的服务器绝对路径直接用作 SFTP 路径。

用户版连接后，左侧按项目显示目录。文本、Markdown 和常见图片可预览，其他格式下载查看；手动刷新或每 30 秒刷新当前目录。**加入当前会话**会下载选中文件快照，下一次发送时把来源、快照路径和 SHA256 加入 prompt。不会自动把整个共享空间喂给模型。

## Agent、成果与会话

- 用户在 CLI 设置中登录自己的 Cursor 或 Codex。服务器密码与模型账号无关。也可指定自己安装的 CLI 路径；Cursor 必须是 Agent CLI，而不是编辑器的 `cursor` 命令。
- 每个会话绑定本地工作目录、提供方和可选的远端项目。切换左侧项目不会改变已有会话的上传目标。CLI 权限请求和补充问题显示在会话中；不支持的请求会明确拒绝或报错。
- 本地工作目录下 `.workbench/sessions/<id>/handoff.md` 是交接文件。首次发送提示 CLI 在形成阶段性结果时更新它；用户也可点击 **交接文件** 编辑。CLI 是否充分填写仍取决于其执行结果。
- 点击 **整理成果**后，工作台复制交接文件和已选择的参考材料，启动一个独立的同提供方会话提炼草稿。采用 CLI 的只读/Ask 模式；原工作会话可继续。生成内容不会自动覆盖用户编辑的草稿正文。
- 用户编辑标题与说明、选择附件，然后点击 **确认并上传成果**。附件复制为快照并记录 SHA256，打包时检查快照是否变化。代码文件与其他附件一致固化；不会自动提交、合并或修改用户自己的 Git 仓库。目录需先打包再作为附件选择。
- 成果 ZIP 包含 `README.md`、`manifest.json` 和选中的附件。每个上传使用唯一包名，经临时文件上传完成后重命名，失败可在传输记录重试。
- 会话历史单独归档，默认手动；可在每个工作会话中开启“每轮结束后自动上传”。归档包括规范化对话、工具/协议事件、原生 session ID，以及 Codex 返回时提供的原生记录路径。
- 会话归档仅覆盖本工作台启动/接续并采集的事件，**不冒充厂商完整原生数据库，也不包含不可访问的隐藏推理**。独立运行在工作台外的历史不会自动导入。Cursor 的 ACP 使用原生 session ID 关联，不依赖扫描猜测数据库文件。
- 轨迹包与成果包分开；`trainingConsent: false` 明确不表示已经授权用于训练。后续训练数据粒度与用途另行设计。

`.workbench/` 含本地工作记录与临时资料，建议加入业务仓库的 `.gitignore`。程序不会擅自修改业务仓库忽略规则。程序退出或网络中断后，未完成的传输保留为待处理状态，不会自动切换到当前项目继续上传。

## 开发与构建

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts/prepare-runtimes.ps1
npm run check
python -m unittest discover -s tests -p test_admin.py
npm run test:ui
npm run start           # 用户版
npm run start:admin     # 管理员版
npm run package
```

`scripts/build.mjs` 分别编译两个入口，只将所需文件放入 `dist/user`、`dist/admin`。安装包脚本读取这两个目录并使用不同的应用 ID。`scripts/check-providers.ts` 对真实 CLI 做初始化握手，不发送模型任务。

当前验证：TypeScript 编译；SSH/SFTP 回环协议集成测试（管理员验证、子管理员隔离、主机身份绑定、中文传输、权限拒绝、临时上传与路径边界）；CLI 模拟协议测试；Python 命令与身份边界测试；两个真实 Electron 窗口并行启动与用户界面流程；官方 CLI 原生初始化。

尚未完成的外部验证：在公司的目标 Linux 发行版上执行账号创建/停用、实际 sudo/PAM/sshd 配置与目录 ACL；登录个人模型账号后的真实业务任务；另一台电脑安装迁移。请勿将回环协议测试理解为生产服务器已部署。

实现参考：[Codex App Server](https://developers.openai.com/codex/app-server)、[Cursor ACP](https://cursor.com/docs/cli/acp)、[OpenSSH sshd_config](https://man.openbsd.org/sshd_config)、[Linux ACL](https://man7.org/linux/man-pages/man5/acl.5.html)。
