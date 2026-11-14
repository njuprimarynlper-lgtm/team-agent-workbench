# 个人成果 AI 接口

## 在会话中使用

启动新版工作台，在本机工作会话中直接提出保存或维护成果的要求，例如：

> 把本轮已经验证的结论存入当前项目个人成果库的“探索记录”，附上刚生成的评测报告；已有同一项成果就更新，并说明仍未验证的范围。

工作台会在模型下一轮上下文中提供内置 `workbench-results` Skill、调用脚本以及当前会话的配置文件路径。模型读取 Skill 后使用本机终端调用，不需要点击成果库、填写弹窗或选择附件。主会话、子会话和本机侧边提问均可获得该入口，适用于 Codex、Cursor CLI 和 Claude Code。本次不接入远程执行或 Cursor 原生联动会话。

指引按原生会话去重，不逐轮重复注入；配置文件在发送前刷新。工作台重启后恢复未关闭会话的配置路径，脚本每次重新读取文件。已有会话直接在工作台发送下一轮消息即可获得指引；直接在其他原生客户端发送消息不经过此注入流程。

内置 Skill 源码：[skills/workbench-results/SKILL.md](../skills/workbench-results/SKILL.md)。它随构建发布，运行时放入本机账号数据目录，不要求修改用户的 CLI 全局 Skill 配置。

## 服务与授权

- 服务仅监听 `127.0.0.1` 的随机端口，工作台运行时可用，隐藏到托盘后继续可用；完全退出后停止。
- 配置文件位于账号数据目录 `sessions/<会话ID>/results-api.json`。其中包括 `baseUrl`、Bearer Token、项目 ID、Skill 路径和脚本路径。Token 只授予当前账号、当前项目，账号切换后失效。
- 临时侧边提问的配置位于 `local-result-api/temporary/<会话ID>/results-api.json`，关闭侧聊后删除，不进入普通会话目录或账号同步。
- 通过当前工作台会话的指引取得配置，不扫描其他账号目录，也不把 Token 写进正文或分享内容。
- 个人成果操作使用本地存储，不要求中央节点连接，也不使用模型账号或 SFTP 凭据。
- 与界面共用成果、目录、版本和附件处理逻辑。API 操作成功后，成果库同步显示；界面的修改也会让 API 的旧 ETag 失效。

## REST API v1

配置中的 `baseUrl` 格式为：

```text
http://127.0.0.1:<端口>/api/v1/projects/<项目ID>
```

所有请求携带 `Authorization: Bearer <token>`。所有写入需要 `Idempotency-Key`；修改已有成果还需要 `If-Match`，值为读取或上次写入返回的完整 ETag。

| 方法 | 相对路径 | 用途 |
| --- | --- | --- |
| GET | `/context` | 核对当前项目与接口范围 |
| GET | `/openapi.json` | OpenAPI 3.1 文档，包括请求 Schema |
| GET | `/results?q=&offset=0&limit=30&includeArchived=false` | 搜索、分页查询个人成果；每页最多 100 条 |
| GET | `/results/<id>` | 读取正文、版本、ETag 与附件清单 |
| POST | `/results` | 创建 Markdown 成果 |
| PATCH | `/results/<id>` | 局部更新正文、标题、分类、状态和负责人 |
| POST | `/results/<id>/move` | 移动个人目录位置 |
| POST | `/results/<id>/archive` | 移入历史或恢复，JSON 为 `{"archived": true/false}` |
| DELETE | `/results/<id>` | 删除个人成果，保留团队成果和已发送会话引用 |
| POST | `/results/<id>/attachments?name=<文件名>` | 上传原始文件字节，Content-Type 为 `application/octet-stream` |
| GET | `/results/<id>/attachments/<fileId>` | 校验并下载指定附件快照 |
| DELETE | `/results/<id>/attachments/<fileId>` | 从成果移除指定附件 |
| GET | `/directories` | 查询个人库五类一级目录及子目录 |
| POST | `/directories` | 创建、重命名或删除子目录 |

成果正文创建或修改生成原有的内容版本历史。附件和目录位置使用各自原有规则，不以正文版本递增作为唯一判断；ETag 同时覆盖正文、状态、目录和附件变化，因此不能只凭 `version` 覆盖写入。

上传接口接收文件内容，不接受 `localPath`、远端地址或 SFTP 配置。最多 30 个附件，单个最大 2 GiB；文件名采用普通文件名，不含目录、系统保留名称和 Windows 不支持的字符，最长 120 字符。JSON 请求体最大约 2 MiB。成果附件保存固定副本，与输入框“本地文件”仅关联路径的行为不同。

创建正文和上传附件是独立操作；附件上传失败不会重新创建正文。附件数据不会自动送给模型，模型仍按需下载或读取。

## 并发与重试

每次独立写入使用一个新幂等键。同一次请求因网络中断重试时，复用原键、原正文及原 ETag；服务返回已保存的回执，不重复创建成果或添加附件。请求记录在账号与项目范围内持久化，跨工作台重启仍生效。同一键对应不同内容会返回 409。

更新前先 GET 读取，使用返回的 `etag` 或 HTTP ETag 头。人或其他 AI 在此期间改动成果时，旧 ETag 写入失败；重新读取并按意图合并，再用新键与新 ETag 提交。不要无条件覆盖，也不要为了绕过冲突反复换键。

关键错误：

| 状态／代码 | 含义与后续处理 |
| --- | --- |
| 401 | Token 缺失或格式无效 |
| 403 | 账号／项目授权失效，或请求来自浏览器 Origin；取得当前配置后调用 |
| 404 | 当前项目中不存在成果或附件 |
| 409 | 幂等键冲突、目录冲突或成果状态冲突；读取当前状态核对 |
| 409 `operation_interrupted` | 上次操作可能已执行但未写完回执，保留中断记录，不自动重放；先核对 `resultId` 或目标成果 |
| 412 | ETag 已过期；读取、合并后重新提交 |
| 413 | 正文或附件超过大小限制 |
| 415 | Content-Type 不符合接口要求 |
| 428 | 缺少有效 If-Match |
| 500 | 本机存储等运行故障；按幂等语义核对操作结果 |

错误结构为 `{"error":{"code":"...","message":"..."}}`。成功写入返回成果 ID、正文版本、ETag、目录版本及附件清单等轻量回执；需要正文时再 GET。

## 脚本调用

Skill 提供的 Node 脚本支持 `context`、`schema`、`list`、`get`、`create`、`update`、`move`、`archive`、`restore`、`delete`、`upload`、`download`、`remove-file`、`directories`、`directory`。

```text
node "<clientPath>" --config "<configPath>" list --query "评测"
node "<clientPath>" --config "<configPath>" create --input "<UTF-8 JSON文件>" --request-id "<唯一请求ID>"
node "<clientPath>" --config "<configPath>" get --id "<成果ID>"
node "<clientPath>" --config "<configPath>" update --id "<成果ID>" --input "<更新JSON文件>" --etag-file "<上次get输出的JSON文件>"
node "<clientPath>" --config "<configPath>" upload --id "<成果ID>" --file "<附件路径>" --etag-file "<上次get输出的JSON文件>"
```

脚本直接连接本机接口，绕过机器的 HTTP_PROXY/HTTPS_PROXY。JSON 输入文件保留 Markdown 原文，不需要把正文嵌进 shell 参数。下载使用新文件路径，已有文件不会被覆盖。写入未指定请求 ID 时脚本会生成，并在成功或失败的 JSON 输出中报告，以便重试。

## 当前边界

此接口维护个人成果，不发布、修改或删除团队成果。它不会自动将所有回复存成成果；由用户任务或既定自动化任务决定保存范围，Skill 负责按约定操作。工作台进程是服务宿主，本次没有新增独立常驻或开机服务。
