import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventory = JSON.parse(await fs.readFile(path.join(root, 'docs/error-audit/inventory.json'), 'utf8'));
const supplemental = new Set(['src/admin/main.ts', 'src/admin/preload.ts', 'src/renderer/logs-panel.tsx', 'src/renderer/central-connection-error.tsx']);
const selected = inventory.entries.filter(row => /^(src\/(core|shared|main)\/|server\/)/.test(row.file) || row.kind === 'startup-exception' || supplemental.has(row.file));
const rules = {
  'operation-boundary': { disposition: '边界归一化', basis: '源异常保持原有权限与失败语义；沿 main dispatch/publicFailure 或快照公开错误字段转换用户文案，原文先记诊断日志。规则判断不代表逐条文案已人工验收。' },
  'state-boundary': { disposition: '边界归一化', basis: '这是错误状态传播候选，需在 IPC 返回和 session-delta/sidechat-delta 等即时事件的同一公开边界处理；仅包装 dispatch 返回不能证明覆盖。' },
  'internal-propagation': { disposition: '内部诊断', basis: 'catch/清理/回滚候选本身不是用户界面；保留控制语义并由最终失败出口记录，避免把全部 catch 机械改成弹窗。动态调用者仍以传播链审查为准。' },
  'direct-ui': { disposition: '需单独修改', basis: 'notice/原生对话框等可直接到达用户，可能绕过操作失败与快照边界；需按成功通知和失败通知分别处理，不能一律当作失败。' },
  'protocol-rejection': { disposition: '边界归一化', basis: 'reject 是 RPC/Promise 协议传播，不等于直接用户展示；保留内部 code/data，最终用户出口转换，禁止翻译后破坏 CLI/服务器控制协议。' },
  'server-raise': { disposition: '边界归一化', basis: '服务端 raise 经 admin.py JSON 或 content.py 回执字符串返回；客户端须保留执行阶段与不确定结果，再归一化并记录技术详情。' },
  'server-catch': { disposition: '内部诊断', basis: '服务端 except 包含回滚、可选能力探测与守护进程循环；它不是独立用户场景。只有最终失败应进入回执/管理结果，原始诊断不可直接拼进 UI。' },
  'startup-native': { disposition: '需单独修改', basis: 'Electron 尚未启动时不经过 preload 或 React；启动器必须独立保留原始日志、显示简洁原因并提供日志定位。' },
  'diagnostic-only': { disposition: '内部诊断', basis: '日志存储、导出、轨迹或运行诊断内部错误；日志详情允许脱敏技术文本。日志自身故障应局部显示，不能递归记录或反复触发查看日志。' }
};
const manuallyRead = new Set(['src/core/rpc.ts', 'src/core/storage-requests.ts', 'src/core/transfers.ts', 'src/core/store.ts', 'src/core/preparation.ts', 'src/core/claude-runtime.ts', 'src/core/logging.ts', 'src/core/log-storage.cjs', 'src/core/log-export.ts', 'src/main/logging.ts', ...supplemental]);
const manual = row => {
  if (row.file === 'src/admin/main.ts') return { disposition: row.kind === 'error-sink' ? '需单独修改' : ['catch','silent-catch'].includes(row.kind) ? '内部诊断' : '边界归一化', basis: '完整补审管理员IPC来源验证、窗口路由、失败引用私有scope映射与200条回收、启动原生框、代理回调。当前首次/重复连接失败定位和跨窗口拒读已用真实Electron验证；egress.connection与central.close已补账号/节点scope。服务身份指纹是确认连接所需信息，应保留在信任确认中。' };
  if (row.file === 'src/admin/preload.ts') return { disposition: '边界归一化', basis: '已核对preload只抛可序列化公开DTO并宣布failure元数据；真实Electron已证明plain对象保留code/logRef，不能改回会丢自定义属性的Error对象。主进程来源校验仍为权限边界。' };
  if (row.file === 'src/renderer/logs-panel.tsx') return { disposition: '保留', basis: '日志面板属于允许查看脱敏技术详情的专用界面。已实现并验证初始id/op定位、最近故障分页、详情、缺失引用与日志自身故障局部显示；普通导出与清理回归通过。此源链判断不替代无源码背景的整体可理解性盲审。' };
  if (row.file === 'src/renderer/central-connection-error.tsx') return { disposition: '保留', basis: '组件仅展示上游公开message及查看连接动作，不在此重新翻译技术原文。既有断开文案/非中央连接分流测试通过；输入归一化由IPC/事件边界负责，组件本身不扩权。' };
  if (row.file === 'src/core/transfers.ts') return { disposition: row.line >= 15 && row.line <= 18 || row.line >= 115 && row.line <= 119 ? '需单独修改' : '保留', basis: '已读完整传输队列：保留原请求回执、不可变快照与校验拒绝语义；仅失败消息拼接处需分离用户原因和技术日志，不得改成无条件重新提交。' };
  if (row.file === 'src/core/store.ts') return { disposition: row.kind === 'throw' ? '边界归一化' : '内部诊断', basis: '已核对原子写入、缺失索引停止保存、增量版本与删除保护。保护行为必须保留；含绝对路径、文件格式、底层 cause 的说明仅在日志展示，UI 保留未覆盖旧资料与恢复含义。' };
  if (row.file === 'src/core/preparation.ts') return { disposition: row.kind === 'throw' ? '边界归一化' : '内部诊断', basis: '已核对 AI JSON 解析、未选择类别、超过项数、目标目录与旧格式兼容。格式/规则错误不等于网络或登录失败，整理层不能用通用网络建议覆盖精确原因。' };
  if (row.file === 'src/core/claude-runtime.ts') return { disposition: row.kind === 'throw' ? '边界归一化' : '内部诊断', basis: '已核对启动、stderr、权限回答及流式事件。运行错误与工具/模型返回内容必须分开；不可翻译工具正文。已有stderr分类避免把凭据原文放进UI，应保留该约束。' };
  if (row.file === 'src/core/rpc.ts') return { disposition: '边界归一化', basis: '已核对 JSON-RPC code/data/method、进程退出、写入关闭和请求超时。原始协议字段保持，UI 按请求阶段解释；turn/start 超时不证明任务未执行。' };
  if (row.file === 'src/core/storage-requests.ts') return { disposition: row.kind === 'catch' ? '内部诊断' : '边界归一化', basis: '已核对先读旧回执、requestHash、staging、awaiting_receipt 和 rejection。超时/丢回执时必须提示结果未确认，保持原请求恢复，禁止提示盲目重复创建。' };
  if (/^src\/(core\/(logging|log-storage|log-export)|main\/logging)\./.test(row.file)) return { disposition: '内部诊断', basis: '已读日志存储/脱敏/导出/查询链。详情和导出保留脱敏技术错误；查询/get必须由main派生scope、分页和解压有界，清理后引用和日志自身失败不能循环。确认对话框业务文案保留。' };
  if (row.file === 'src/core/sftp.ts' && (row.line <= 106 || row.line >= 122 && row.line <= 203)) return { disposition: row.line === 38 || row.line === 39 ? '需单独修改' : '边界归一化', basis: row.line === 38 ? '已认证但未启用SFTP不应直接建议重建成员账号；先说明管理员需修复成员登录配置，避免诱导破坏性操作。' : '已核对SSH认证/身份确认、SFTP code 2/3、成员记录和项目发现。登录成功与项目读取失败分开，保留缓存/撤权控制；界面不能把所有网络错误误归到CLI模型服务。' };
  if (row.file === 'src/main/index.ts' && row.line >= 835 && row.line <= 867) return { disposition: '需单独修改', basis: '已追踪createDataContext.emit/notice/session-delta：它们直接发送事件，必须独立核对事件归一化，dispatch结果包装不能覆盖此路径。' };
  return undefined;
};
const entries = selected.map(row => {
  let rule = row.kind === 'startup-exception' ? 'startup-native' : row.file.startsWith('server/') ? /\braise\b/.test(row.snippet) ? 'server-raise' : 'server-catch' : /\b(?:notice|showErrorBox|showMessageBox)\s*\(/.test(row.snippet) && row.kind === 'error-sink' ? 'direct-ui' : row.kind === 'ui-state' ? 'state-boundary' : row.kind === 'error-sink' ? 'protocol-rejection' : ['catch', 'silent-catch'].includes(row.kind) ? 'internal-propagation' : 'operation-boundary';
  if (/^src\/(core\/(logging|log-storage|log-export)|main\/logging)\./.test(row.file)) rule = 'diagnostic-only';
  const specific = manual(row);
  return { id: row.id, file: row.file, line: row.line, kind: row.kind, snippet: row.snippet, ...rules[rule], ...(specific || {}), judgment: specific ? 'manual-path-review' : 'propagation-rule-review', rule,
    verifiedUiScreenshot: false, note: 'disposition是对基线候选的处置建议，实施验证见findings.resolution。AST候选可能嵌套重复；本条不是独立场景计数，不据此声称所有界面已故障复现或通过整体可理解性验收。' };
});
const findings = [
  { id: 'PIPE-01', priority: 1, area: '即时事件', evidence: ['src/main/index.ts:840', 'src/main/index.ts:856', 'src/main/index.ts:862', 'src/core/scheduled-tasks.ts:82', 'src/core/scheduled-tasks.ts:163'], concern: '普通IPC返回归一化无法覆盖notice和session-delta中的原始错误。', requestedChange: '在事件出口处理公开错误字段；失败通知先日志化再展示。成功通知与用户/模型正文不可一律归一化。' },
  { id: 'PIPE-02', priority: 1, area: '管理员节点日志范围', evidence: ['src/admin/main.ts:180', 'src/admin/main.ts:185', 'src/admin/main.ts:269'], concern: '首次连接失败按尝试节点写日志，但后续日志读取按旧或空profile派生节点，引用无法读取。', requestedChange: '由main保存当前窗口产生的失败引用到可信节点scope映射，或维护目标窗口内存attempt scope；不得允许renderer任意传centralId。' },
  { id: 'PIPE-03', priority: 1, area: '业务文案信任', evidence: ['src/shared/user-failure.ts', 'src/core/store.ts:39', 'src/core/store.ts:41', 'src/core/store.ts:252', 'server/admin.py:420'], concern: '含中文并不代表可直接公开，绝对路径、Errno、工具stderr可混在中文说明中；未知对象自带failure也不应无条件信任。', requestedChange: '审查业务文案/code白名单和已有failure来源；保留人类所需状态说明，技术路径/底层命令只进日志。' },
  { id: 'PIPE-04', priority: 1, area: '结果不确定性', evidence: ['src/core/rpc.ts:83', 'src/core/storage-requests.ts:25', 'src/core/storage-requests.ts:30', 'src/core/transfers.ts:15', 'src/admin/connection.ts:101'], concern: '超时、回执丢失与已完成校验失败不能被压成同一个“失败，请重试”。', requestedChange: '保留阶段、原请求ID与已接收/可能部分执行/结果未知语义；禁止自动重发，截图与集成测试验收。' },
  { id: 'PIPE-05', priority: 2, area: '场景上下文', evidence: ['src/main/public-failures.ts', 'src/core/sftp.ts:194', 'src/core/transfers.ts:36', 'src/core/transfers.ts:89'], concern: 'snapshot默认local会把中央节点访问错误归为模型连接；transfer的本地ENOENT也不能一律说中央文件缺失。', requestedChange: '按真实实体和错误来源派生domain；来源不明时用中性描述，不猜端点或让用户修改错误的网络设置。' },
  { id: 'PIPE-06', priority: 2, area: '结构化控制协议', evidence: ['src/renderer/main.tsx:817', 'src/shared/team-cache.ts:18', 'src/shared/guard-network.ts:24', 'src/admin/member-sync.ts:102', 'src/admin/member-recovery.ts:3'], concern: 'PASSWORD_CHANGE_REQUIRED、WB_NET、MEMBER前缀及中文旧文案参与控制。', requestedChange: '消费新code元数据后再改显示字符串；兼容旧持久化状态；不能仅验证新错误直接调用。' },
  { id: 'PIPE-07', priority: 2, area: '日志定位', evidence: ['src/main/public-failures.ts', 'src/main/logging.ts', 'src/core/logging.ts'], concern: '背景operationId为32位hex；query不应只接受UUID。重复合并可能使用首条日志id，因此只传当前operationId会丢定位。', requestedChange: 'query接受受限标识符；使用record返回的logRef，finishLog保留实际日志id。前者已在本分支修复，后者由主线程核对。' },
  { id: 'PIPE-08', priority: 2, area: '动态状态字段清单', evidence: ['src/main/public-failures.ts', 'src/core/agents.ts:129', 'src/core/provider-auth.ts:10', 'src/core/egress.ts'], concern: '通用递归仅认识少数error键，desktopSyncError和确实承载故障的detail/message可能遗漏；反之所有同名字段不必都是应用错误。', requestedChange: '建立按实体类型的公开字段映射，保留模型/工具正文与普通状态说明，不依赖全局键名兜底宣称全覆盖。' }
];
const resolutions = {
  'PIPE-01': { change: 'main emit边界归一化session/sidechat delta；publicErrorState识别失败notice，成功notice与模型/工具正文保留。', verification: 'tests/error-pipeline-boundary.test.ts：快照/delta、失败与成功notice、原正文不变均通过；复核main emit实际调用。' },
  'PIPE-02': { change: '管理员main保存窗口私有reference→centralId映射，有界200条并在窗口关闭时清除；查询条目id继续登记同scope。egress与close日志补main派生scope。', verification: 'scripts/error-audit-log-scope.mjs真实Electron四项通过；docs/error-audit/log-scope-verification.json。另log-query测试验证旧scope不冒充当前节点。' },
  'PIPE-03': { change: '公开文案过滤Errno、绝对路径、EIO等技术特征；existing failure只重建已校验字段；日志查询/详情/导出使用白名单并再次脱敏quoted/Basic凭据。', verification: 'error-pipeline-boundary技术混合文本/伪failure反例、log-query历史磁盘脱敏与越权详情、logging diagnostic cause导出测试通过。' },
  'PIPE-04': { change: '未知请求超时保留确认结果措辞；传输公开状态保留awaiting_receipt/streaming/verifying/rejected/queued阶段与outcome；原队列恢复机制不变。', verification: 'error-pipeline-boundary三种传输状态反例及tests/transfer-recovery.test.ts六项通过。' },
  'PIPE-05': { change: '状态错误按connection/workspace/transfer/provider实体选上下文；ENOENT/ENOSPC/EACCES来源不明时不猜本机或中央端点。', verification: 'error-pipeline-boundary中央连接与transfer本机路径/未知存储反例通过；user-failure/error-audit-admin场景反例通过。' },
  'PIPE-06': { change: '改密/服务器身份/成员恢复使用结构化code并保留旧文案；guard使用networkProblem并兼容旧WB_NET。主会话和子会话/侧聊均传入相应元数据，本地失败优先。', verification: '中央连接/项目连接/团队缓存/管理员恢复回归通过；error-pipeline-boundary现代元数据与旧marker均有企业证书/重新检测动作；已复核subsession-chat实际prop。' },
  'PIPE-07': { change: 'query operationId接受LogScope受限标识符；logOperation与publicErrorState使用record返回的实际id/op；两端catch传实际logRef，管理员Map同时登记id/op。', verification: '连续相同connect失败被合并后仍定位首条记录的真实Electron反例已通过；快照重复ref与详情单测通过。' },
  'PIPE-08': { change: '补desktopSyncError/syncError/cleanupError及notice失败；明确跳过模型正文。管理员非error键detail在对应展示组件归一化，并将后台原文按节点scope记录。', verification: 'error-pipeline-boundary桌面同步原文泄露反例通过；补审admin main/preload、日志面板和中央连接展示组件完成。' }
};
for (const finding of findings) { finding.status = 'resolved-and-verified'; finding.resolution = resolutions[finding.id]; }
const by = key => Object.fromEntries([...new Set(entries.map(row => row[key]))].map(value => [value, entries.filter(row => row[key] === value).length]));
const reviewedSources = [];
for (const file of [...manuallyRead, 'src/main/public-failures.ts', 'src/shared/user-failure.ts']) { const text = await fs.readFile(path.join(root, file)); reviewedSources.push({ file, sha256: createHash('sha256').update(text).digest('hex') }); }
const output = { schema: 1, reviewer: 'error_pipeline_audit subagent', generatedAt: new Date().toISOString(), baseline: inventory.baseline, sourceInventory: 'inventory.json', scope: 'src/core、src/shared、src/main、server、全部启动器候选及补审admin main/preload、LogsPanel、CentralConnectionError；其它renderer由另两位代理独立审查',
  result: '所选AST候选均有基线处置与依据，8项独立设计发现已修复并验证。只有manual-path-review属于直接阅读传播路径的独立人工判断；其余为明示传播规则判断。源链覆盖、运行故障验证、整体UI可理解性盲审是不同证据，不互相替代。',
  verification: { boundaryAndLogging: { command: 'node scripts/test-background.mjs tests/error-pipeline-boundary.test.ts tests/log-query.test.ts tests/logging.test.ts', passed: 19 }, controlAndRecovery: { command: 'node scripts/test-background.mjs tests/error-pipeline-boundary.test.ts tests/user-failure.test.ts tests/error-audit-admin.test.ts tests/error-audit-user.test.ts tests/central-connection.test.ts tests/team-cache.test.ts tests/project-connection.test.ts tests/transfer-recovery.test.ts', passed: 49, note: '此运行之后新增了整理与guard回归，两项已在boundaryAndLogging的19项中通过。' }, typecheck: 'npm run typecheck passed', desktopScope: 'log-scope-verification.json', screenshots: 'logs-scenarios.json：两端五个场景的20张真实前后截图', compatibilityUi: 'scripts/logging-smoke.mjs passed: 两端入口、导出、清理', additionalPreparationFix: 'preparation helper保留超过5项/未选择类别，timeout不猜网络或登录过期；failPreparation/result_failed转换前诊断日志已由主线程补齐，反例通过。' },
  counts: { candidates: entries.length, dispositions: by('disposition'), judgments: by('judgment'), independentManualPaths: manuallyRead.size }, rules, reviewedSources, findings, entries };
await fs.writeFile(path.join(root, 'docs/error-audit/pipeline-review.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output.counts));
