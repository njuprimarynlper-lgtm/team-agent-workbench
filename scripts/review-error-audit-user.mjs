// Review decisions for the user-session domain. Candidate rules are intentionally
// distinguished from the individually traced, rendered scenarios.
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const inventory = JSON.parse(await fs.readFile(path.join(root, 'docs/error-audit/inventory.json'), 'utf8'));
const scenarios = JSON.parse(await fs.readFile(path.join(root, 'docs/error-audit/user-scenarios.json'), 'utf8'));
const renderer = new Set(['main.tsx','composer-settings.tsx','model-picker.tsx','provider-auth.tsx','provider-connection.tsx','provider-connection-check.ts','permissions.tsx','project-directory.tsx','directory-move-notice.tsx','cursor-native-settings.tsx','transcript-pages.tsx','session-files.tsx','cli-connection-notice.tsx','codex-request-guard.tsx']);
for(const filename of ['session-input-queue.tsx','subsession-chat.tsx','side-chat.tsx','native-sessions.tsx','mcp-panel.tsx','session-materials.tsx','agent-settings.tsx','cursor-native-record.tsx','agent-customization.tsx','plan-message.tsx','closed-sessions.tsx','session-name.tsx','session-sync-frame.tsx','conversation-message.tsx','native-desktop-controls.tsx','project-connection.tsx','request-card.tsx','paged-message-text.tsx','subsession-workspace.tsx','capability-chips.tsx','session-input-drafts.tsx','session-status.tsx','session-transcript.tsx','snapshot-refresh.ts'])renderer.add(filename);
for(const entry of inventory.entries)if(entry.file.startsWith('src/renderer/composer-'))renderer.add(path.basename(entry.file));
const core = new Set(['src/core/provider-auth.ts','src/core/session-files.ts','src/core/permissions.ts','src/core/workspace-relocation.ts','src/core/cursor-native-rpc.ts','src/shared/cli-connection.ts']);
const workbenchRanges = [[1180,1362],[1478,1567],[1661,1678],[2243,2360],[2754,2818],[2950,2950]];
const own = entry => entry.file.startsWith('src/renderer/') && renderer.has(path.basename(entry.file)) || core.has(entry.file) || entry.file === 'src/core/workbench.ts' && workbenchRanges.some(([from,to]) => entry.line >= from && entry.line <= to);
const candidates = inventory.entries.filter(own);
const reasons = {
 'state-reset': '清空错误或显示正常加载状态，不是一次故障；保留原行为。',
 'ui-container': 'AST提取的父容器、按钮禁用条件或正常状态，可能嵌套重复。具体错误由子节点及其错误入口处理，不能按候选节点数计算场景数。',
 'local-display-adapter': '显示位置已使用按域的uiErrorMessage或稳定分类状态；原始异常保留给IPC诊断日志。该候选通过规则归类，不能声称单独做过截图。',
 'public-state-boundary': '会话、项目、配置和原生窗口的异步错误由主进程publicErrorState归一化后进入快照；保留底层错误语义以免影响内部控制协议。',
 'internal-control': '底层业务约束或协议错误仍作为内部控制信息保留；UI边界区分已知业务原因和技术异常，技术原因只在日志查看。',
 'diagnostic-or-preserved-draft': '静默catch用于诊断上传、退出清理或草稿刷新；主交互另有保存状态或错误入口。此规则仅说明该catch自身不产生独立报错文案。',
};
const entries = candidates.map(entry => {
 const snippet=entry.snippet;
 let rule;
 if (/^set(?:Error|Status|Notice)\(['"]['"]\)/.test(snippet)) rule='state-reset';
 else if (entry.kind==='ui-state' && !/inline-error|role="alert"|\.error\}|\.message\}|setError\(|setNotice\(|failure/i.test(snippet)) rule='ui-container';
 else if (entry.kind==='throw') rule='internal-control';
 else if (entry.kind==='silent-catch' || /catch\s*\([^)]*\)\s*=>\s*\{\s*\}/.test(snippet)) rule='diagnostic-or-preserved-draft';
 else if (entry.file.startsWith('src/core/') || /session\.error|syncState\.error|\.accessError|\.connectionIssue|desktopSyncError/.test(snippet)) rule='public-state-boundary';
 else rule='local-display-adapter';
 return {id:entry.id,file:entry.file,line:entry.line,kind:entry.kind,reviewMethod:'rule-classification',disposition:rule==='state-reset'||rule==='ui-container'?'not-an-independent-error-scenario':rule==='internal-control'||rule==='diagnostic-or-preserved-draft'?'retain-internal-behavior':'covered-by-reviewed-error-boundary',rule,reason:reasons[rule],representativeScenarios:scenarios.filter(s=>s.source===entry.file).map(s=>s.id)};
});
const manual = scenarios.map(scenario => ({id:scenario.id,entry:scenario.entry,condition:scenario.condition,source:scenario.source,changeReason:scenario.changeReason,reviewMethod:'individual-source-and-render-review',disposition:'reviewed',originalUI:scenario.originalUI,currentUI:scenario.currentUI,before:scenario.before?.screenshot,after:scenario.after?.screenshot,substates:scenario.after?.substates,assertions:scenario.after?.assertions,passed:!!scenario.before?.passed&&!!scenario.after?.passed,
 ...(scenario.id==='u13'?{sharedEvidenceId:scenario.after?.sharedEvidenceId,derivedFromScreenshot:scenario.after?.derivedFromScreenshot,conclusion:'复用admin域完整真实主界面SharedAttachments下载失败证据，SFTP code=2由所选源码实际分类；原孤立连接卡片已替换。'}:{}),
 ...(scenario.id==='u12'?{correction:'基线已包含弹层关闭时的错误回退提示。初审漏读尾部fallback已纠正；本项仅统一显示区、归一化异常及增加日志入口，不声称从无反馈改为有反馈。'}:{})}));
const coverage = [
 {file:'src/renderer/main.tsx',conclusion:'已区分消息未提交、Cursor入队待确认、已提交后本地保存失败；批准错误保留请求选择，失效批准禁用并取消等待授权提醒，提供只恢复连接、不自动批准或重发的入口，队列保持暂停；密码初次修改和服务器身份变化使用稳定code；网络恢复从结构化networkProblem读取；其他异步错误由UI适配器和主进程公共边界处理。',scenarios:['u01','u03','u16','u17']},
 {file:'src/renderer/composer-settings.tsx',conclusion:'模型、思考强度、权限应用失败经过用户错误适配，保留已知业务提示；权限配置不完整显式显示，原生技术详情只在日志。',scenarios:['u08','u14']},
 {file:'src/renderer/provider-connection.tsx',conclusion:'保存连接方式与随后检测分开；保存成功后检测失败不再暗示设置未保存；此前登录信息标记连接待验证，真实重新检测入口可清除此状态。',scenarios:['u06','u20']},
 {file:'src/renderer/project-directory.tsx',conclusion:'目录保存、迁移影响读取、界面刷新分开，保存成功后的统计失败明确提示已保存；目录选择器和保存前错误分别归一化。',scenarios:['u09','u21','u22']},
 {file:'src/core/session-files.ts',conclusion:'只有ENOENT或ENOTDIR视为缺失；EACCES、EPERM和I/O错误不再变成文件丢失或空列表。',scenarios:['u11','u23']},
 {file:'src/core/workspace-relocation.ts',conclusion:'逐项核对本模块及workspace-links已知业务throw；在Workbench迁移边界拆开明确业务原因与路径/errno，保留循环、内部会话链接、创建链接权限、文件变更/冲突等具体原因。复制校验成功后切换记录保存失败按实际save阶段标记，回滚目录使用状态；原始诊断仍记录到日志。',scenarios:['u10','u46','u47','u48','u49']},
 {file:'src/shared/preparation-error.ts',conclusion:'仅在明确connection reset、ECONNRESET或socket hang up证据下保留网络中断，仅核心CLI进程退出格式确认CLI停止；普通timeout仍不推断网络中断或登录失效。仅对明确网络中断赋稳定PREPARATION_CONNECTION_INTERRUPTED/outcome unknown，结果内容通过真实helper消息查看，退出码等原始诊断只在日志。',scenarios:['u50','u51']},
 {file:'src/renderer/draft-editor.tsx',reviewMethod:'manual-source-and-render-review',scope:'generationError display and retry recovery only',conclusion:'所有整理失败提示提供实际日志入口，优先使用generationErrorFailure及原generationError匹配日志。使用源头保存的generationErrorFailure.code/outcome；未知中断的重试默认禁用，用户可查看本次已收到的实际assistant内容并复制，明确没有可用内容后才允许重试；确认本身不调用retry，原始诊断用实际日志入口查看。',scenarios:['u50','u51']},
 {file:'src/renderer/transcript-pages.tsx',conclusion:'历史分页失败说明已有对话保留及正确滚动重试方向，不显示RPC方法名。',scenarios:['u15']},
 {file:'src/renderer/codex-request-guard.tsx',conclusion:'接收结构化networkProblem并兼容旧标记；保持恢复证书/连接动作，移除UI阶段码和协议码详情，仅通过日志查看技术原因。',scenarios:[]},
];
const extraReviews={
 'session-input-queue.tsx':'逐一核对action、编辑草稿、历史编辑恢复和右键队列操作catch；已统一用户错误和日志入口。保留uncertain禁止重试/编辑和明确未送达才能重试的原控制逻辑。',
 'subsession-chat.tsx':'核对完成已读、子会话关闭/重开、排队编辑、发送与刷新、参考资料移除。保留本地typed failure及其networkProblem，避免新本地故障显示旧会话证书动作；恢复按钮不再断言消息未发送。',
 'side-chat.tsx':'核对临时侧聊关闭确认、草稿自动保存、队列编辑、发送和发送后刷新。已提交后刷新失败明确要求核对，恢复按钮不再断言未发送；过期侧聊提示保留已有内容可查看。',
 'native-sessions.tsx':'核对本机/远程列表、类型不匹配、多选上限、导入前去重、导入失败刷新、原生联动启动。catch适配typed对象；当前账号与工作目录缺失等既有中文业务约束保留。',
 'mcp-panel.tsx':'核对列表查询、登录轮询、增删改停用、读取可编辑配置、打开配置文件。列表查询不再隐藏CLI已知原因，loginError按操作域归一化；追溯CodexMcp.list/login证实loginError可能伴随unknown且无canLogin，因此Codex登录失败仍提供真实可用的重试登录；保存成功与后续reload错误仍分开显示。',
 'session-materials.tsx':'核对个人/团队缓存与在线读取、权限撤回、版本变更、部分关联成功、已关联项移出选择与刷新失败。保留逐项added/failed处理；适配warning/unavailable，避免技术原文进入状态区。',
 'agent-settings.tsx':'核对请求保护回滚、CLI路径保存、检测、程序选择、登录前保存路径、官方安装说明和打开数据目录。修复最后两类无catch的点击；不可用CLI detail与所有操作失败归一化。未检测到CLI时不再显示绿色已登录，保留旧登录信息说明；保存错误固定在滚动内容外，避免完全不可见。',
 'cursor-native-record.tsx':'核对原生消息记录和等待队列。任务实际工具/思考/错误记录属于对话证据，按主进程opaque边界保留，不重写用户内容；产品队列error另行归一化，未知送达不自动重发；显式提示打开Cursor核对消息和回复，并保留实际入口。',
 'agent-customization.tsx':'核对MCP/Skills/插件切换、读取、启停、配置目录和说明网页。列表读取保留可执行的CLI原因；已有空列表是成功读取后的正常状态。',
 'composer-actions.tsx':'完整核对send/queue/wait、压缩、运行、停止和自动对话锁。此文件无异步错误输出；disabled的标题说明已给出，保留控制路由。',
 'composer-capabilities.tsx':'仅按cursorNative分流到CodexComposerTools，不生成错误；错误由实际工具面板处理。',
 'composer-codex-tools.tsx':'核对触发符、技能/插件查询、命令切模式、MCP/成果入口以及未找到选项。查询与切换catch已适配；保留只执行本地slash命令、不发送为模型任务的控制。',
 'composer-mode.tsx':'核对读取模式与应用、代际防过期、运行中下轮生效。已区分读取和切换操作，保留已知业务中文错误。',
 'composer-reference-tabs.tsx':'核对预览引用资料、撤销加入、滚动折叠、选择锁。原instanceof Error分支会把typed普通对象显示为[object Object]，已统一适配。',
 'composer-command.ts':'完整核对触发符识别和移除；纯文本解析，不产生用户错误，无独立截图场景。',
 'composer-input.ts':'完整核对冻结输入、乐观清空及仅在草稿未变化时恢复。该层保留重抛原typed错误给主/子/侧会话显示，避免丢失outcome；不在此层改写错误或重发。',
 'composer-resize.ts':'纯尺寸计算、范围限制和拖动方向，无错误输出；保留。',
 'composer-references.ts':'纯资料筛选、去重、自动引用及布局计算，无异步错误输出；保留。',
 'plan-message.tsx':'核对执行计划、提交修订、返回false和抛错。提交超时/结果未知后禁用执行和修改，显示计划提交待确认；提供只读取快照的刷新执行状态；仅同一messageId且accepted可确认此计划已提交，其它任务starting/running/approval或另一计划accepted均保留unknown锁，必须核对后显式解锁才能重提。业务false保留明确未开始提示。',
 'closed-sessions.tsx':'核对重新打开失败、保留历史对话和键盘焦点；catch已适配，读取历史使用统一分页错误；没有把已关闭空记录当成错误。',
 'session-name.tsx':'核对空名称、未变化、输入法、Enter/blur去重和保存失败。typed对象不再被instanceof Error分支丢失；失败保留编辑器及输入名称；后端renameSession保存拒绝会回滚原title，跨账号检查先于写入。',
 'session-sync-frame.tsx':'核对开启/取消/关闭/恢复同步和运行锁。已区分设置受理与刷新失败，保留确认运行状态后才显示同步成功的原逻辑。',
 'conversation-message.tsx':'第二轮未知编辑提交结果既锁住按钮也锁住save/Enter，只读刷新快照不会重发或在没有证据时解锁。修改输入保留。文件/模型已知拒绝与未开始阶段不误加未知锁。右键操作仍由ContextMenu集中处理。',
 'native-desktop-controls.tsx':'完整核对远程、Codex待接入、Cursor旧关联只读、恢复与原生窗口动作。没有独立catch；run来自已审主界面或SessionSyncFrame，状态error由公共快照边界归一化，保留。',
 'project-connection.tsx':'第二轮源链纠正：disconnectProject先删除connectedProjects再settle。后续收尾失败保留PROJECT_DISCONNECTED_WITH_PENDING_SYNC/outcome accepted，显示项目已断开与实际连接按钮，不再宣称连接仍保留。旧fixture错误已标conditionChanged，并从本轮旧源码按真实条件补图。',
 'request-card.tsx':'完整核对审批/提问/计划以及选项映射和输入校验。该组件只保存选择并调用父层onAnswer；错误由主/子/侧聊已审处理器显示；失效/重连中的请求不允许再次提交。保留选择，不自动批准或丢弃答案。',
 'paged-message-text.tsx':'完整核对分页上/下一段、末页截断；纯本地内容分段，没有错误输出或网络请求，保留用户内容。',
 'subsession-workspace.tsx':'完整核对同级分组、父会话切换、键盘导航与溢出滚动；仅组合已审子会话组件，不生成独立错误。',
 'capability-chips.tsx':'纯选择标签移除，无API和错误输出；保留。',
 'session-input-drafts.tsx':'核对write/flush失败、后续修订抑制旧失败、成功清错、内存文本保留。错误说明磁盘/草稿文件及保持窗口，主界面有真实保存输入草稿重试；全局页脚按本账户失败草稿数独立订阅，不再与本机已保存矛盾。原异常重抛给发送屏障，避免错误仍发送。',
 'session-status.tsx':'完整核对等待确认、运行、未读完成、失败和已读持久化重试。tooltip来自已归一化session.error；保留失败不确认新回复和仅前台已读的行为。',
 'session-transcript.tsx':'完整核对折叠已完成轮次、原生记录、分页边界和工具JSON回退。解析失败回退用户原始文本属于内容保真，不是应用错误；历史读取错误由transcript-pages统一处理。',
 'snapshot-refresh.ts':'完整核对批次请求合并、错误释放waiter和后续请求恢复。既有契约规定失败不拒绝waiter，保留；修复App已有state时不呈现failed回调的问题，并提供重试。',
};
for(const [filename,conclusion] of Object.entries(extraReviews))coverage.push({file:'src/renderer/'+filename,reviewMethod:'manual-source-and-caller-review',conclusion,scenarios:scenarios.filter(s=>s.source==='src/renderer/'+filename).map(s=>s.id)});
coverage.push({file:'src/core/websocket-rpc.ts',reviewMethod:'manual-changed-branch-review',scope:'turn/start and turn/steer timeout metadata only; other candidate ownership unchanged',conclusion:'两种写操作超时附SHARED_CODEX_SUBMISSION_UNCONFIRMED/outcome unknown；只读RPC和其他调用保留原协议行为，技术原因由公共IPC边界记录。',scenarios:['u28','u29']});
coverage.push({file:'src/renderer/submission-failure.ts',reviewMethod:'manual-source-and-test-review',conclusion:'按code/outcome/phase与真实已尝试提交分层，明确只读、preflight、not-started、accepted、partial不当作未知发送；兼容旧串，避免文案改动破坏防重发。',scenarios:['u01','u28','u29','u36','u42']});
coverage.push({file:'src/renderer/contextual-error.ts',reviewMethod:'manual-source-and-caller-review',conclusion:'页面按已知code给具体对象与同屏动作，保留failure code/outcome/logRef，显示改写不影响核心控制协议。',scenarios:scenarios.map(row=>row.id)});
const report={readabilityRound:2,readabilityReviewFile:'docs/error-audit/readability-review.json',noteOnReadability:'本文件仅记录源码与场景复核，独立可读性评分由readability-review.json提供；截图断言passed不代表可读性≥9。',baseline:inventory.baseline,owner:'user-session-model-permission-network-directory-desktop',note:'逐项真实截图场景与规则归类候选分开统计。不是每个AST父容器、状态清空或内部throw都代表独立用户错误场景；rule-classification不等同逐项人工截图审查。',manualScenarios:manual,fileCoverage:coverage,entries,summary:{candidateEntries:entries.length,individuallyTracedScenarios:manual.length,pairedScreenshots:manual.filter(s=>s.before&&s.after).length,allRenderedAssertionsPassed:manual.every(s=>s.passed),ruleCounts:Object.fromEntries([...new Set(entries.map(e=>e.rule))].map(rule=>[rule,entries.filter(e=>e.rule===rule).length]))}};
await fs.writeFile(path.join(root,'docs/error-audit/user-review.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report.summary));
