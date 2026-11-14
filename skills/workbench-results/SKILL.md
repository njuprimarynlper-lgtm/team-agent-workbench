---
name: workbench-results
description: 查询、创建、更新工作台当前项目的个人成果，管理成果目录并上传或读取附件。用于用户要求保存或维护本地成果，以及任务已约定自动沉淀成果的场景。
---

# 工作台个人成果

通过工作台提供的本机 API 操作当前账号、当前项目的个人成果，不操作界面，也不直接修改工作台数据库。

## 连接与范围

工作台会在会话上下文提供 `configPath`、`clientPath` 和本 Skill 的路径。调用脚本时传入 `--config`；也可使用 `WORKBENCH_RESULTS_CONFIG` 环境变量。脚本每次读取配置，工作台重启后仍使用原配置路径。缺少配置时需要先取得当前工作台会话的配置路径，不猜测其他账号或项目。

使用本机终端执行 Node 脚本。接口仅监听 127.0.0.1，直接访问本机，不能通过云端浏览器访问。配置包含本机授权 Token，不把它放进成果、聊天回复或上传资料。

首次使用可调用 `context` 确认项目，`directories` 查看目录，`list --query` 查找已有成果。应更新已有成果时先读取对应 ID，避免重复新建；仅标题相同不代表是同一成果。

## 常用调用

下面的 `<client>`、`<config>` 替换为工作台给出的绝对路径。写入正文使用 UTF-8 JSON 文件，避免 shell 转义破坏 Markdown。

```text
node "<client>" --config "<config>" context
node "<client>" --config "<config>" list --query "关键词" --limit 30 --offset 0
node "<client>" --config "<config>" directories
node "<client>" --config "<config>" get --id "<成果ID>"
node "<client>" --config "<config>" create --input "<创建JSON路径>" --request-id "<本次操作唯一ID>"
node "<client>" --config "<config>" update --id "<成果ID>" --input "<更新JSON路径>" --if-match '"<ETag值>"' --request-id "<本次操作唯一ID>"
node "<client>" --config "<config>" upload --id "<成果ID>" --file "<附件绝对路径>" --if-match '"<ETag值>"' --request-id "<本次操作唯一ID>"
node "<client>" --config "<config>" download --id "<成果ID>" --file-id "<附件ID>" --output "<新的本地文件路径>"
```

创建 JSON 示例：

```json
{
  "title": "批量输入优化的验证结论",
  "content": "## 结论\n在本次验证条件下……\n\n## 依据与限制\n记录环境、输入、指标及尚未验证范围。",
  "category": "exploration",
  "folderId": "exploration"
}
```

五类 `category`：`project_goal`（项目目标）、`project_material`（项目资料）、`capability`（已有能力）、`exploration`（探索记录）、`todo`（待办事项）。`folderId` 可以是一级分类 ID，也可以是 `directories` 返回的子目录 ID，目录位置与成果分类分开维护。不要把假设、计划或 AI 建议写成已验证结论或已确认的项目要求。

更新 JSON 只需填写要改的 `title`、`content`、`category`、`resultStatus`、`resultOwner`。不填写的字段保持原值。可用状态及完整接口结构通过 `schema` 获取。

其他命令：

```text
node "<client>" --config "<config>" move --id "<成果ID>" --folder-id "<目录ID>" --if-match '"<ETag值>"'
node "<client>" --config "<config>" archive --id "<成果ID>" --if-match '"<ETag值>"'
node "<client>" --config "<config>" restore --id "<成果ID>" --if-match '"<ETag值>"'
node "<client>" --config "<config>" remove-file --id "<成果ID>" --file-id "<附件ID>" --if-match '"<ETag值>"'
node "<client>" --config "<config>" delete --id "<成果ID>" --if-match '"<ETag值>"'
node "<client>" --config "<config>" directory --input "<目录命令JSON路径>"
node "<client>" --config "<config>" schema
```

目录命令使用 `action=create|rename|delete`。创建提供新的 UUID `id`、`parentId`、`name`；重命名提供 `id`、当前 `revision`、`name`；删除提供 `id`、当前 `revision`。删除目录会沿用工作台对子目录和成果位置的处理规则。

## 写入、重试与附件

- 修改前读取成果，使用读取结果中的完整 `etag` 作为 `--if-match`，包括值两侧的双引号。正文版本、目录或附件改变都会使旧 ETag 失效。可以把读取命令的 JSON 输出保存为文件，再使用 `--etag-file`，脚本会提取其中的 ETag，避免命令行引号问题。
- 每次独立写入使用新的 `--request-id`；同一次操作因连接中断而重试时，复用同一个 ID 和原始参数。脚本未指定时会生成 ID，并在成功或失败输出中报告。不要为了绕过冲突换 ID 反复提交。
- 遇到 409/412，重新读取最新内容，按用户意图合并后用新 ETag 和新请求 ID 提交。`operation_interrupted` 表示上次可能已执行，先查询返回的 `resultId` 或目标成果核对，不自动重放。
- `upload` 把文件字节流上传为成果附件，工作台保存固定副本；这不同于输入框里只关联原路径的“本地文件”。每项成果最多 30 个附件，单个最大 2 GiB。创建成果与上传附件是独立操作；附件失败后保留已创建的成果，修正后继续上传，不重新创建成果。
- 在用户要求的范围内创建、修改、归档或删除。删除仅影响个人成果；已有会话引用保持原样，团队成果不随之删除。本接口不提供团队分享或团队成果修改。
- 用回执确认成功，并在回复中给出成果名称、ID、版本和附件处理结果。不要把 HTTP 连接成功当成写入成功。
