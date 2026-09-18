# 本地文件系统联调

本地模式让管理员版和用户版直接读写同一个 Windows 目录。管理员版直接打开目录，无需账号密码；用户版的共享操作仍使用模拟成员身份验证权限。模型调用仍通过个人登录的真实 Codex CLI；权限桩不负责模型账户认证。

## 管理员首次设置

1. 创建一个专用空目录，例如 `D:\TeamAgentDemo\shared`。代码工作目录应另选位置。
2. 打开管理员版，在连接框的“共享区类型”选择“本地文件系统（模拟权限）”。
3. 选择共享目录并点击“打开共享目录”，无需填写管理员账号或密码。新目录首次点击“初始化账号管理”；已有共享区直接加载。后续启动自动打开上次保存的本地共享目录。
4. 创建组，例如 `competition`，自动建立 `shared\projects\competition`。本地模式无需配置 SSH。
5. 创建 `alice`、`bob` 两名成员，将两人加入该组，为 Alice 勾选“内容子管理员”。成员密码由管理员设置，可重置、启停或调整分组。
6. 为每个成员生成独立启动器和本机数据目录，启动器预置对应的本地共享区。

成员账号存在于 `.workbench-local/registry.json`，成员密码保存为加盐哈希。不会创建 Windows/Linux 系统账号或修改系统 ACL。本地管理员不设置、不校验密码；旧版本登记的管理员名称和密码哈希保留为历史记录，无需重建共享区。可在“连接设置”更换目录；目录被移动或无法打开时，启动会显示错误并允许重新选择。只有本地模式自动打开，正式 Linux 模式仍需输入服务器账号密码。

## 用户首次设置

1. 使用联调环境为该成员准备的用户版启动器。
2. 只选择“本机工作路径”作为代码和个人工作文件目录。测试共享目录由启动器预置，不在用户工作台中单独选择。
3. 输入成员账号和密码，点击“登录并发现工作组”。左侧按组展示全部授权项目，未分组时提示“还没有加入工作组”，没有工作台，加入组后刷新即可。子管理员在对应组的加号中创建项目；普通成员没有创建入口。成员关系变更后可点击“刷新工作组与项目”，窗口可见时也会每 30 秒自动刷新。
4. 新建会话时选择 Codex。CLI 未登录会显示登录入口；完成个人账号登录后才可发送任务。
5. 左侧浏览共享文件，预览后可加入当前会话。引用保存为本机快照，并记录来源和哈希。
6. 每个会话使用独立的阶段摘要，入口在默认收起的“AI 参考内容”中。AI 生成整理结果后由用户审阅、可选补充并确认上传；返回会话会让整理继续在后台运行，只有“停止整理”会终止任务。成果包只包含**成果说明、可选 GitHub 仓库链接、可选 Git 状态与元数据**，不包含代码。
7. 会话轨迹默认手动上传，也可为指定会话启用自动上传。上传后写入项目的 `trajectories/账号/`，同组成员可读取。

CLI 请求执行命令或修改文件时，会话内显示确认卡片。展开“查看请求详情”可检查命令或文件路径、差异，再选择允许本次或拒绝。文件差异绑定当前原生会话和轮次，不能沿用其他会话或上一轮的内容。

## 文件布局与模拟权限

```text
shared/
  .workbench-local/registry.json
  projects/competition/项目名/
    .workbench-project.json
    submissions/alice/       同组可读；Alice 可修订待整理项
    submissions/bob/         同组可读；Bob 可修订待整理项
    trajectories/alice/      同组可读（用户主动上传后）
    trajectories/bob/        同组可读（用户主动上传后）
```

权限在每次共享操作时重新读取。停用、移除项目组、撤销子管理员都会使后续相应操作被拒绝；改密码后原连接凭据失效，需要重新登录。本地 Agent 的工作进程可以继续运行。

项目外路径、`..`、Windows 保留名称、ADS、符号链接/目录联接及大小写别名被拒绝。已有上传可在公共成果中修订；子管理员整理后原作者不能继续覆盖。任务始终绑定创建时的账号、共享区身份和项目，切换连接不能把待上传成果送到另一个身份下。

这是应用层权限模拟。拥有共享目录操作系统权限的人或 CLI 可直接访问文件，不受权限桩保护；不能据此声称生产权限隔离已经验证。正式部署仍使用 Linux 系统权限。

## 两个用户在同一电脑演练

正常安装使用 `%APPDATA%\TeamAgentUser` 保存本机状态。联调两个成员时，为两个启动进程分别设置 `WORKBENCH_DATA_DIR`；管理员用 `WORKBENCH_ADMIN_DATA_DIR`。不同状态目录保证输入、会话和草稿不串用。

```powershell
$env:WORKBENCH_DATA_DIR = 'D:\TeamAgentDemo\alice-data'
& '安装目录\Team Agent User.exe'
```

另一个启动环境改成 `bob-data`。两人选择同一共享目录，各自选择独立代码工作目录。不同数据目录不等于不同模型账户；同一 Windows 用户默认仍复用此人的 Codex 登录。其他电脑需要各自登录。

## 自动验证

```powershell
npm run check
python -m unittest discover -s tests -p test_admin.py
node scripts/local-admin-access-smoke.mjs
node scripts/local-admin-access-smoke.mjs --packaged
npm run test:local-ui
node scripts/local-smoke.mjs --packaged
npm run test:ui
```

`tests/local-space.test.ts` 使用真实磁盘文件验证管理员操作、密码、角色、撤权、共享成果与公共轨迹、路径边界及重启。`scripts/local-smoke.mjs` 同时启动管理员、Alice、Bob 三个 Electron 窗口，执行界面流程；该回归脚本使用模拟 CLI，不消耗模型调用。

`scripts/competition-pilot.ts` 是需显式 `--run-real-codex` 的真实模型演练，固定两用户各两轮。输入目录需要任务书文字 `task.txt`、`solution-template.py`、`self_check.py`、`environment.md` 和官方 `mini_sample/`。参数 `--input`、`--output`、`--python` 必填，`--model` 可为本次演练单独指定 CLI 模型，不修改个人全局配置。结果包含会话 ID、原生 CLI ID、Git 提交、说明、轨迹和数据哈希。算法版本通过本地 Git 仓库交换，共享区上传每轮说明；不冒充 GitHub 仓库，不自动向比赛平台提交。

中断后可在相同参数后添加 `--resume`，恢复原目录和会话；已经登记的轮次跳过。若 CLI 已完成但提交阶段中断，会同时检查原生完成事件和对应轮次报告，避免仅凭文件存在就误判完成。输入文本校验只容许 Git 的 LF/CRLF 转换，其他内容变化和二进制变化均拒绝。

0.7.0 的内容维护和升级操作详见 [身份与协作说明](identity-content.md)。
