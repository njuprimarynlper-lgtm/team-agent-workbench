# Session 主动关联成果

输入框「＋ → 关联成果」可选择当前项目的个人或团队成果。Claude 输入框沿用原有的成果入口。目录和分类分别沿用两份成果库；搜索覆盖当前来源的所有目录。跨目录、跨来源保留选择。团队列表先读本机缓存，后台刷新期间可以继续选择。

确认关联只保存版本快照，不发消息。成果自动随下一轮消息引用；生成中新增的关联不会加入当前轮或本轮引导。未发送的引用可以在输入框参考资料中撤销。历史分页时保留轻量引用回执，早期已发送成果不会重新显示为可撤销的待发送项。已关联的相同版本不重复加入；新版需要显式更新，旧正文快照和已发送历史保留。旧的成果库「加入会话」入口使用同一服务，携带用户看到的版本号，版本发生变化会要求重新选择。

## 附件按需取件

每份正文快照记录该版本全部附件的文件名、类型、大小和 SHA256，不读取附件内容。发送时把固定的会话附件索引路径补充给模型。索引包含成果、版本、独立索引路径以及实际取件链接。模型按需用本机终端访问链接，工作台校验并缓存后返回本地文件路径 JSON，再由模型读取需要的范围；接口不把二进制或文本正文塞进对话。

- `sessions/<sessionId>/result-attachments.json`：当前引用及已发送旧版的成果索引；`active=false` 的旧版只供追溯。
- `sessions/<sessionId>/result-indexes/<sourceId>.json`：该版本全部附件的元数据和链接。
- `sessions/<sessionId>/result-files/`：实际请求后校验过的附件副本。
- `result-attachment-cache/<sha256>`：可离线复用的本机缓存。

索引路径固定，启动时重建已发送引用的实际链接。历史中的旧链接失效时，模型可以重新读取固定索引。子会话拥有自己的索引和取件授权，父会话的快照不会被改写。

取件接口只监听 `127.0.0.1`，采用启动期密钥签发的会话授权链接；仅允许 GET，拒绝跨站来源、错误 Host、未知会话或附件，不接收任意本地／远端路径。每次请求验证当前账号、项目及关联状态。个人附件来自已记录的本地副本，团队附件由工作台使用现有连接代取，模型不持有中央节点凭据。版本及内容哈希固定，下载前后校验大小和哈希；缺失、权限失效和内容变化明确失败，绝不读取新版替代。

关闭窗口进入托盘后取件继续运行；明确退出时服务关闭。已缓存的附件可以离线取件，未缓存的团队附件需要连接所属项目的中央节点。支持现有本机 Codex、Cursor CLI 和 Claude 工作会话及子会话；远程 Codex 与 Cursor 原生联动不在本次扩展范围。

## 接口与验证

- `session.resultCandidates({id, scope, refresh?})`：当前项目的候选、目录、关联版本、缓存状态。
- `session.attachResults({id, references})`：按范围、项目、ID、版本逐项关联，分别返回 `added` 和 `failed`；重试去重，部分成功保留。
- `session.attachContent` / `session.attachConclusion`：兼容原入口，支持 `expectedRevision` / `expectedVersion`。

验证：`npm run test:session-results`、`npm run test:session-results-ui`。真实 Electron 托盘和重启验证：先 `npm run build:check`，再 `node scripts/session-results-desktop-smoke.mjs <本次构建的 user 目录>`。
