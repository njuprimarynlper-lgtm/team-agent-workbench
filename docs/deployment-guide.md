# 团队工作台部署指导

本文只说明环境准备、部署、启动和迁移。产品内的账号、会话、成果与轨迹操作见 [使用指导](user-guide.md)。

## 当前交付状态

- 当前源码版本为 0.7.0，管理员版与用户版分别构建。
- 本轮只更新开发构建，没有重新生成安装包。
- 仓库统一入口：[start-admin-dev.cmd](../start-admin-dev.cmd)、[start-user-dev.cmd](../start-user-dev.cmd)。这两个文件随代码一起交付，不需要部署者重新编写脚本。
- 首次启动检查 Node.js / npm，按 `package-lock.json` 自动安装依赖，然后构建当前源码。之后依赖清单或 Node.js 主版本变化时重新安装依赖；每次启动仍会重新构建。两个入口同时打开时会排队准备环境，准备完成后应用可同时运行。
- 不会保留后台终端窗口；准备或构建失败会弹窗提示并把日志写入 `.test-data/launcher/`，不会启动旧构建。拉取代码后关闭旧窗口，再双击对应入口即可。已打开的窗口不会自动更新。
- 已发布的 0.6.3 安装产物仍在 `release/0.6.3/admin` 和 `release/0.6.3/user`；它们不包含当前开发版的全部交互更新。

## 选择部署模式

| 模式 | 用途 | 权限来源 |
| --- | --- | --- |
| 本地文件系统 | 功能演示、联调和自动化测试 | 应用层权限桩 |
| Linux SSH/SFTP | 团队正式共享 | 独立 Linux 账号、用户组、ACL 和受限文件操作器 |

本地模式不能证明生产权限隔离。拥有 Windows 共享目录系统权限的人仍可绕过应用直接访问文件。

团队共享与模型网络是两条独立通路。SSH/SFTP 始终用于共享空间；只有部分成员无法直接访问 Codex/Cursor 时，才需要另行部署可选的[管理端网络出口](network-egress.md)。

## 新电脑从源码启动

1. 准备 64 位（x64）Node.js 22 或更高版本。可安装到系统并保留 npm / PATH 选项；也可将官方便携压缩包完整解压到仓库 `.tools/node-v版本号-win-x64/`，该目录中须同时包含 `node.exe` 和 `npm.cmd`。入口按版本顺序逐一验证 Node 和 npm 的可运行性，每次探测最多 10 秒；失败则尝试下一目录、系统 PATH、自定义目录。所有候选不可用时，窗口允许选择解压后的离线 Node 目录，保存在本仓库 `.tools/node-path.txt`，也可通过 `WORKBENCH_NODE_DIR` 指定。无需修改系统环境变量。
2. 拉取或解压完整仓库，保留 `package-lock.json`、`scripts`、`src` 等文件。无需复制其他电脑的 `dist` 或生成新的启动脚本。
3. 双击根目录的 `start-user-dev.cmd` 或 `start-admin-dev.cmd`。首次运行需要下载依赖，等待准备完成；启动日志位于 `.test-data/launcher/`。失败时检查弹窗给出的日志，修复网络或环境后重新双击即可。
4. 用户版按使用指导连接团队账号并登录个人模型账号。Codex CLI 随 npm 依赖安装；使用 Cursor 时可在应用内设置已安装的 Cursor Agent CLI 路径，或运行 `powershell -ExecutionPolicy Bypass -File scripts/prepare-runtimes.ps1` 准备仓库配套的 Cursor 运行文件。

依赖下载发生在应用启动前，使用本机 npm / Electron 的下载和代理配置；工作台中的可选管理端模型出口不负责这一步。无法下载依赖的电脑应由部署人员交付对应版本的完整安装包或免安装目录。

### 核对两台电脑的运行版本

在两台电脑各自的仓库目录运行 `git rev-parse --short HEAD` 和 `git status --short`，同时确认提交和本地修改。关闭旧窗口后使用上述统一入口。启动日志会记录源码目录及实际运行的 `dist/user` 或 `dist/admin`，便于排查启动了另一份目录的情况。打开旧安装包或旧 `dist` 不会自动获得源码里的新功能。

## 本地文件系统部署

1. 准备一个专用空目录作为共享区，例如 `D:\TeamAgentDemo\shared`。业务代码目录与共享区分开。
2. 启动管理员版，在连接设置中选择“本地文件系统（模拟权限）”，选择共享目录并初始化。
3. 创建用户组、成员及组管理员，为各用户启动器预置本地共享区和账号。
4. 用户版只选择自己的本机工作路径；共享区根目录由联调启动器预置，不让用户选择。
5. 多人同机联调时，每个用户进程必须使用不同的 `WORKBENCH_DATA_DIR`；管理员使用 `WORKBENCH_ADMIN_DATA_DIR`。正式使用建议每人使用自己的 Windows 账号。

现有联调环境：`D:\agent开发\比赛协同联调\run-20260916-02`。

- `打开管理员.cmd`
- `打开用户A.cmd`
- `打开用户B.cmd`
- `打开用户test1.cmd`

这些联调启动器预置演示账号的数据目录，使用 `D:\agent开发\team-agent-workbench\dist/user` 或 `dist/admin`，保留原共享区登记和历史数据；它们不用于其他电脑的正式部署。使用旧联调脚本前应先在仓库执行 `npm run build`。

## Linux SSH/SFTP 部署

服务器要求：Linux、Python 3.9+、OpenSSH、shadow/passwd 用户管理命令、procps、ACL 支持（setfacl 或 libacl），以及运行中的 systemd 或下文支持的 Supervisor 容器环境。管理员应使用服务器已经存在的 root 或 sudo 账号；Windows 管理员身份不能替代 Linux 管理权限。

1. 规划团队根目录，例如 `/srv/teamspace`，并确认目标路径不存在或为空。
2. 在管理员版填写服务器地址、端口、root/sudo 账号和团队根目录。首次连接时确认服务器地址，本机会记住服务器身份，之后自动校验。
3. 连接后先检查环境提示。缺少 `setfacl` 时自动尝试系统 `libacl.so.1`，保持相同 ACL 权限。两者都不可用时提供安装指引及“准备运行环境”入口；只有管理员点击“开始准备”才安装组件。也可自行安装后点击“重新检查环境”，无需重新登录。环境通过后执行“初始化团队空间”，创建受保护的账号登记、成员组和元数据目录；首次创建成员时再配置 `internal-sftp` 和受限文件服务。
4. 创建工作组并准备目录。服务器需要 `setfacl` 或 `libacl`；项目共享读写最终由 Linux 所有权、组和 ACL 执行。
5. 创建独立成员账号。每个成员使用自己的 SSH 账号和密码，一个账号可加入多个项目组。
6. 向成员交付服务器地址、SSH 端口、成员账号和初始密码。成员不需要管理员配置文件或服务器指纹。

成员 SFTP 接入没有独立配置入口。管理员创建用户时会在同一次可恢复操作中启用 sshd drop-in，并校验、补齐 SSH 登录规则与受限文件操作器；SSH 校验或重载失败会恢复原主配置和团队规则。配置失败时用户不会被标记为创建完成，应在管理员版修正错误后继续该创建操作。

### 在线与离线准备环境

在“服务器环境待完善”中点击“准备运行环境”：

- **在线**：自动安装目前缺少的 `acl`、`supervisor` 及其依赖，使用服务器已配置的软件源。自动安装目前支持 Debian/Ubuntu 的 apt-get；保留已有配置，不自动移除软件包。
- **离线**：在服务器专用目录（例如 `/opt/workbench-packages`）放置匹配发行版、架构的 `.deb` 包和完整依赖，在窗口填写该路径。目录、包及上级目录必须 root 拥有且其他账号不可写。界面会安装目录内的包，只应放本次组件和依赖；apt 使用 `--no-download`，缺包会失败，不会回退外网下载。离线文件内容应来自已核验的软件源，本工具的目录权限检查不替代来源验证。
- 该入口支持团队初始化之前使用，不创建项目组或成员。失败后显示错误，可补齐依赖再重试；已满足条件时不重复安装。
- 环境准备不会因 SSH 或账号管理命令缺失就安装整套 SSH 服务。此类缺失仍显示具体要求。

已有 systemd 或可管理的 Supervisor 会复用。无 systemd 且没有可用 Supervisor 实例时，准备流程会尝试补齐软件包，并创建专用配置 `/etc/team-agent-workbench/supervisord.conf`、`conf.d` 和启动脚本 `start-supervisor.sh`，启动本工具的 Supervisor 实例，不重启托管 SSH 的实例。再次执行会先检查已运行实例；已有专用配置被修改时不会覆盖。

专用实例当前启动成功，不代表容器启动流程已接入。管理员须在现有启动流程中调用 `/etc/team-agent-workbench/start-supervisor.sh`，并持久化 `/etc/team-agent-workbench` 和团队目录；它不会替换容器原有的前台主进程。页面会持续显示此要求。重启后的自动恢复必须在目标环境验收。

ACL 回退仅用于缺少命令，不会在权限拒绝、文件系统不支持 ACL 时更换实现以跳过错误。现有公共文件、用户请求目录和回执使用同一 ACL 实现；不能通过忽略 ACL 失败继续发布。

### 无 systemd 的容器

程序检查 PID 1 是否为 systemd。对于 PID 1 为 bash 等情况，目前支持由 **Supervisor** 托管文件服务，需要：

- Supervisor 已运行，`supervisorctl` 可用；主配置为 `/etc/supervisor/supervisord.conf` 或 `/etc/supervisord.conf`。
- `[supervisorctl] serverurl` 使用本机 `unix://` socket；配置、socket 和父目录由 root 管理且不允许其他账号写入。支持 root 控制的 `/var/run` → `/run` 等系统链接。
- 主配置的 `[include] files` 加载现有目录中的 `*.conf` 或 `*.ini`，例如 `conf.d/*.conf`。工具只增加本团队的 `team-agent-storage-团队ID` 配置，并只更新、重启这个服务。
- SSH 提供 `service` 和 `/etc/init.d/ssh` 或 `/etc/init.d/sshd`。工具先运行 `sshd -t`，通过后才执行 `service ssh reload` 或对应的 sshd 重载，不自动重启 SSH。
- 容器的 entrypoint 或启动流程必须启动同一 Supervisor，并保留团队目录及 Supervisor 配置。生成的服务设置 `autostart=true`、`autorestart=true`，会随 Supervisor 启动，并在异常退出时重启；单独用 `nohup` 或 `start-stop-daemon` 启动一个进程不视为持久托管。

未找到上述托管方式时会明确显示环境问题并阻止创建，不会误报已就绪。文件服务必须进入 `RUNNING`（systemd 为 active）后才确认接入完成。之前失败的 `user_create` 可在修复环境后，从“待恢复操作”点击“继续完成”，仍须重新输入初始密码；不应手工再次创建同名 Linux 账号。

ACL 工具存在不代表所有挂载点支持 ACL。部署者还应在实际团队目录所在文件系统验证 ACL 可设置；文件系统不支持时应调整挂载/存储配置。容器重启、真实 SSH 新连接和共享文件读写仍须在目标容器验收。

当前成员端采用 TOFU：首次连接由用户确认地址并保存当时的服务器身份，后续变化会被拦截。它消除了管理员分发指纹的步骤，但无法单独识别首次连接时已经存在的中间人攻击。对首次身份也有强验证要求时，应在基础设施中部署 SSH 主机证书，由客户端内置或统一下发企业 SSH CA 公钥。

账号登记位于 `<团队根路径>/.workbench/admin/state.json`，操作记录位于同目录 `audit.jsonl`，受保护的组管理员任命位于 `<团队根路径>/.workbench/roles.json`。

部署后必须在目标 Linux 发行版验证：账号创建与停用、密码重置、组变更、SFTP chroot、ACL 拒绝、旧连接失效、成员跨组隔离和组管理员权限。回环协议测试不能替代这项验收。

## 开发构建

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts/prepare-runtimes.ps1
npm run typecheck
npm test
npm run build
npm run test:ui
npm run test:session-ui
npm run test:local-ui
npm run test:egress-ui
```

开发启动：

```powershell
.\start-admin-dev.cmd
.\start-user-dev.cmd
```

`scripts/build.mjs` 分别生成 `dist/admin` 和 `dist/user`。需要新安装包时运行 `npm run package`；管理员版与用户版使用不同的应用 ID、安装目录和本机数据目录。打包前应完成真实目标机验收并配置企业代码签名。

## 迁移到其他电脑

1. 安装对应的管理员版或用户版，或完整复制免安装目录；不要只复制单个 exe。
2. 用户填写服务器地址、SSH 端口和自己的 SSH 账号密码，并选择新电脑上的本机工作路径。
3. 在新电脑上分别登录个人 Codex 或 Cursor 账号。模型凭据由厂商 CLI 管理，不随工作台配置迁移。
4. 本地会话位于各自的应用数据目录，不会自动上传到团队共享区。需要迁移本地历史时，应在应用关闭后整体迁移对应数据目录。
5. 新电脑首次连接时确认一次服务器地址。身份变化时客户端停止登录；确认服务器确实重装或迁移后，用户在错误提示旁点击“重新确认”。正常登录页不显示指纹或技术信息。

## 部署验收

- 管理员版和用户版可同时启动，数据目录互不覆盖。
- 普通成员不能看到未加入的工作组，也不能写入他人的个人成果目录。
- 一个账号加入多个组后可一次登录发现全部授权组。
- 移出组、停用账号或修改密码后，旧共享访问不再有效。
- 用户只能选择本机工作路径，共享路径由账号权限与配置确定。
- 成果按类别进入项目 `submissions/账号/{experiments,failed-directions,findings,issues,baseline-change-proposals}/`，轨迹上传进入 `trajectories/账号/`。分类子目录由受控文件操作器在首次上传时创建。
- 网络中断和应用重启不会把待上传内容改投其他项目或身份。
- 未启用管理端出口时，CLI 保持原有直连环境；启用后，仅工作台启动的 Codex/Cursor CLI 收到本机代理变量。
- 管理端出口只允许配置中的 Codex/Cursor HTTPS 域名和 443 端口，并由用户端校验接入码中的 TLS 证书指纹。

本地模式的详细目录与权限桩行为见 [本地文件系统联调](local-filesystem.md)，正式身份边界见 [身份与协作说明](identity-content.md)。
