// Render production React components from an explicit source checkout with isolated API failures.
// Original before images use the immutable v2.3.46 baseline. Supplementary u52 is explicitly labeled as the immutable round-2 pre-rewrite comparison.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

const root = process.cwd(), option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.split('=').slice(1).join('=');
const phase = option('phase') || 'after', source = path.resolve(option('source') || root);
const only = option('only')?.split(',');
const newReadabilityScene = process.argv.includes('--new-readability-scene');
if(newReadabilityScene)assert(only?.length===1&&only[0]==='u52','The supplementary pre-rewrite comparison is only u52');
if(phase==='before'&&only?.includes('u52'))assert(newReadabilityScene,'u52 before must be explicitly labeled as the supplementary round-2 comparison');
const correctedReadability = process.argv.includes('--corrected-readability');
if(correctedReadability)assert(phase==='after'&&only?.length===1&&only[0]==='u45'&&source===path.join(root,'.test-data/error-readability/baseline'),'Corrected before is only the immutable round-2 source and actual u45 settlement condition');
const fixtureSource=await fs.access(path.join(source,'tests/fixtures/offline-workspace.ts')).then(()=>source,()=>root);
const verificationOnly = process.argv.includes('--verify-only');
assert(!verificationOnly || phase === 'after' && only?.length === 1 && only[0] === 'u50', 'Action-only verification is scoped to u50 after');
assert(['before', 'after'].includes(phase));
if (phase === 'before') assert.equal(source, path.join(root, newReadabilityScene ? '.test-data/error-readability/baseline' : '.test-data/error-audit/baseline'), 'Before must use its explicit immutable source checkout');
const output = path.join(root, '.test-data/error-audit/user-' + (correctedReadability ? 'corrected-before' : phase)), shots = path.join(root, 'docs/error-audit/screenshots');
await fs.mkdir(output, { recursive: true }); await fs.mkdir(shots, { recursive: true });
const frozenImages = verificationOnly ? await Promise.all(['u50-after.png','u50-logs-after.png','u50-received-content-after.png'].map(async name => ({ name, sha256:createHash('sha256').update(await fs.readFile(path.join(shots,name))).digest('hex') }))) : [];
const scenarios = [
  ['u01', '会话发送', 'Cursor入队请求的回执丢失，无法确定是否已入队', 'src/renderer/main.tsx', 'send'],
  ['u02', '会话重连', 'Codex已明确报告登录失败，正在自动重试', 'src/renderer/cli-connection-notice.tsx', 'cli'],
  ['u03', '批准请求', '本机CLI已关闭，用户点击允许本次', 'src/renderer/main.tsx', 'approval'],
  ['u04', '新建会话选择模型', '本机CLI路径无效，模型列表读取失败', 'src/renderer/model-picker.tsx', 'model'],
  ['u05', '登录检测', 'Claude Code登录状态不是可识别JSON', 'src/core/provider-auth.ts', 'auth'],
  ['u06', '应用连接方式', '连接方式保存成功，随后账号检测失败', 'src/renderer/provider-connection.tsx', 'route'],
  ['u07', '检测执行权限', '当前本机工作目录不存在', 'src/renderer/permissions.tsx', 'permission'],
  ['u08', '查看执行权限', '权限配置读取不完整，实际权限尚未确认', 'src/renderer/permissions.tsx', 'warning'],
  ['u09', '保存项目代码目录', '目录保存成功，随后影响统计读取失败', 'src/renderer/project-directory.tsx', 'directory'],
  ['u10', '切换会话目录', '待复制目录含不支持复制的特殊文件', 'src/renderer/directory-move-notice.tsx', 'move'],
  ['u11', '打开会话文件', '文件系统返回拒绝访问，不能据此认定文件不存在', 'src/core/session-files.ts', 'file'],
  ['u12', '在Cursor中打开', '设置弹层关闭时，打开原生会话失败', 'src/renderer/cursor-native-settings.tsx', 'cursor'],
  ['u13', '下载团队成果附件', '已展开团队成果的具体附件，下载时中央节点返回该远端文件不存在', 'src/core/sftp.ts', 'remote'],
  ['u14', '查看模型设置', '已有会话的模型读取因CLI路径无效而失败', 'src/renderer/composer-settings.tsx', 'composer'],
  ['u16', '消息提交后本地保存', 'CLI已接收消息，随后本地记录保存失败', 'src/core/workbench.ts', 'accepted'],
  ['u15', '读取历史消息', '历史分页读取失败，原始异常含协议方法名', 'src/renderer/transcript-pages.tsx', 'history'],
  ['u17', '启动工作台', '读取工作台状态失败，IPC返回带类型的普通对象', 'src/renderer/main.tsx', 'boot'],
  ['u18', '模型列表返回异常', '模型查询成功返回对象，但其中modelError含底层协议异常', 'src/renderer/model-picker.tsx', 'catalog-error'],
  ['u19', '打开个人账号登录', 'CLI登录进程启动失败', 'src/renderer/provider-auth.tsx', 'login'],
  ['u20', '打开网络与登录', '初次账号检测超时，尚未应用任何变更', 'src/renderer/provider-connection.tsx', 'route-initial'],
  ['u21', '保存项目目录', '目录设置尚未保存，文件系统拒绝写入', 'src/renderer/project-directory.tsx', 'directory-denied'],
  ['u22', '选择项目目录', '本机目录选择器启动失败', 'src/renderer/project-directory.tsx', 'directory-picker'],
  ['u23', '列出会话文件', '文件仍可能存在，但读取列表时出现访问错误', 'src/renderer/session-files.tsx', 'file-list'],
  ['u24', '读取Cursor原生设置', '原生窗口的设置查询失败，弹层显示错误', 'src/renderer/cursor-native-settings.tsx', 'cursor-settings'],
  ['u25', '恢复目录切换', '重试切换工作目录时读写失败', 'src/renderer/directory-move-notice.tsx', 'move-retry'],
  ['u26', '运行中刷新状态', '已有界面后再次读取快照失败', 'src/renderer/main.tsx', 'refresh'],
  ['u27', '继续待发送队列', '队列状态保存失败', 'src/renderer/session-input-queue.tsx', 'queue'],
  ['u28', '子会话提交消息', '共享Codex请求已写出但完成回执超时', 'src/renderer/subsession-chat.tsx', 'child-send'],
  ['u29', '侧边提问提交消息', '共享Codex请求已写出但完成回执超时', 'src/renderer/side-chat.tsx', 'side-send'],
  ['u30', '导入原生会话', '原生记录列表访问失败', 'src/renderer/native-sessions.tsx', 'native-list'],
  ['u31', '读取MCP状态', 'MCP协议查询超时', 'src/renderer/mcp-panel.tsx', 'mcp-read'],
  ['u32', '保存Agent设置', '本机配置写入权限不足', 'src/renderer/agent-settings.tsx', 'agent-save'],
  ['u33', 'Cursor等待队列', '一条送达待确认请求附带底层I/O错误', 'src/renderer/cursor-native-record.tsx', 'native-queue'],
  ['u34', '读取Skills', 'CLI路径无效导致Skills查询失败', 'src/renderer/agent-customization.tsx', 'skills'],
  ['u35', '读取对话模式', 'CLI路径无效导致模式查询失败', 'src/renderer/composer-mode.tsx', 'mode'],
  ['u36', '执行已确认计划', '计划提交请求未及时返回', 'src/renderer/plan-message.tsx', 'plan'],
  ['u37', '重新打开已关闭会话', '会话读取发生本机I/O错误', 'src/renderer/closed-sessions.tsx', 'closed'],
  ['u38', '修改会话名称', '保存返回携带errno的普通错误对象', 'src/renderer/session-name.tsx', 'rename'],
  ['u39', '更新桌面同步', '同步操作已受理，随后界面刷新失败', 'src/renderer/session-sync-frame.tsx', 'sync-refresh'],
  ['u40', '预览待发送参考资料', '本机资料读取权限不足', 'src/renderer/composer-reference-tabs.tsx', 'reference'],
  ['u41', '保存输入草稿', '自动保存返回磁盘空间不足', 'src/renderer/session-input-drafts.tsx', 'draft'],
  ['u42', '编辑已发送消息', '重新提交历史消息时本机I/O错误', 'src/renderer/conversation-message.tsx', 'edit-message'],
  ['u43', '关联多项成果', '一项关联成功、另一项失败', 'src/renderer/session-materials.tsx', 'materials'],
  ['u44', 'MCP服务登录', '服务登录状态包含底层认证错误', 'src/renderer/mcp-panel.tsx', 'mcp-login'],
  ['u45', '断开项目中央节点', '项目已断开，随后后台同步收尾失败', 'src/renderer/project-connection.tsx', 'project-disconnect'],
  ['u46', '切换目录遇到循环链接', '源目录中两个文件夹通过目录链接互相引用', 'src/core/workspace-relocation.ts', 'move-cycle'],
  ['u47', '切换目录遇到内部会话链接', '本次会话数据内部的日志目录指向外部目录', 'src/core/workspace-relocation.ts', 'move-metadata'],
  ['u48', '切换目录创建链接被拒绝', '复制文件链接时操作系统明确返回无权限', 'src/core/workspace-relocation.ts', 'move-link-permission'],
  ['u49', '目录复制成功后记录保存失败', '文件已经复制并校验，随后保存目录切换记录失败', 'src/core/workspace-relocation.ts', 'move-persist'],
  ['u50', '查看连接中断后的成果整理', 'CLI明确返回Network timeout: connection reset，不能丢失连接已中断的证据', 'src/shared/preparation-error.ts', 'preparation-network'],
  ['u51', '查看CLI退出后的成果整理', '本机CLI在整理期间退出并返回退出码9', 'src/shared/preparation-error.ts', 'preparation-exit'],
  ['u52', '读取共享 Codex 的 MCP 连接状态', '实际只读 mcpServerStatus/list 回执超时，原提示误导核对回复及避免重复发送', 'src/renderer/mcp-panel.tsx', 'shared-mcp-read'],
];
const changeReasons = {
 "u01": "上一轮只说送达待确认，用户不知道去哪看。现在把“在 Cursor 中打开”放在提示旁，说明看最后一条消息，并分别给已出现与确实没有时的动作；恢复草稿不会自动发送。",
 "u02": "上一轮要求检查网络和登录，却要用户自己找入口。现在直接提供“打开网络与登录”，同时指出输入框右下角的停止按钮。",
 "u03": "上一轮把未提交、未批准、未执行等否定堆在一起。现在先说这次选择没交给 Codex，再给恢复连接按钮，并保留不会自动批准或重发的边界。",
 "u04": "上一轮仍用本机 CLI 泛称，普通用户不易对应程序。现在明确缺少 Codex 程序，并指向当前完整主界面左下角的 agent管理。",
 "u05": "上一轮“不能确认”没有直说在查登录，还暗示重新选择程序就能修好。现在明确查不到 Claude Code 是否登录，先重新检测，仍失败再交日志排查。",
 "u06": "上一轮同一结果在三处重复，并保留容易误读的登录成功状态。现在一处说明网络已保存、登录检测没结果，账号区只说明以前的信息仍保留。",
 "u07": "上一轮“文件或目录未找到”无法对应权限检测对象。现在明确上方工作目录找不到，指向同屏重新选择目录和重新检测权限。",
 "u08": "上一轮缺少配置与权限摘要重复使用抽象术语。现在直接说部分权限没读出、不能确定哪些操作需要批准，保留实际重新检测入口。",
 "u09": "上一轮“切换状态”难判断是保存失败还是查看失败。现在先说明目录已保存无需再存，只是看不到哪些会话搬好了，并提供“查看搬移进度”。",
 "u10": "上一轮把特殊文件放在技术分类里。现在说明有些文件不能复制、仍用原目录，眼前就能继续使用原目录或处理后重试。",
 "u11": "上一轮只有“无法访问”而没有具体预览对象。现在点名 result.md 和 Windows 拒绝读取，提供真实重试预览文件按钮。",
 "u12": "上一轮“原生连接已过期”像内部术语。现在明确是工作台与 Cursor 的连接失效，并指出同屏重新连接此会话的按钮。",
 "u13": "上一轮普通人仍需猜附件名及失败动作。现在复用完整父界面的真实下载失败提示，明确附件对象和刷新后再下载的路径。",
 "u14": "上一轮模型弹层仍说泛称 CLI，不能知道检查哪个程序。现在明确没有找到 Codex，并给关闭弹层后到左下角 agent管理的路径。",
 "u15": "上一轮“历史消息暂未读取成功”较书面。现在直接说更早的消息没加载、已显示的消息还在，并说明向上滚动会重试。",
 "u16": "上一轮消息已发出后的保存错误堆了多条排障指令。现在只先说消息已发给 Codex、聊天记录还没存好，提供真正只保存记录的“重试保存”。",
 "u17": "上一轮启动失败只有通用未完成，用户看不出哪个内容没读到。现在明确工作台没启动、本机数据没读出，直接点重试启动。",
 "u18": "上一轮读取模型超时却让人核对已有记录，像发送了任务。现在明确 Codex 模型列表没有返回，直接点同屏“刷新模型与额度”。",
 "u19": "上一轮只说登录操作所需文件无法访问。现在明确 Windows 不允许启动 Codex 登录窗口，并在真实 agent管理页显示程序位置和重新选择入口。",
 "u20": "上一轮登录检测没结果却仍像本次已登录。现在明确 Codex 本次没有返回检测结果，重新检测入口可见，以前的信息另作保留说明。",
 "u21": "上一轮要求检查写入权限却找不到设置位置。现在明确项目设置没写入，提供打开本机数据目录按钮，由管理员检查后再保存。",
 "u22": "上一轮只说选择目录所需文件无法访问。现在说明目录选择窗口没打开，并提供可立即使用的完整路径输入方式。",
 "u23": "上一轮文件列表报错未指具体目录。现在说明 Windows 不允许读取上方工作目录，并指向刷新文件按钮。",
 "u24": "上一轮读 Cursor 模型设置却让人核对已有记录。现在明确当前模型没读到，给可见刷新和在 Cursor 中打开两个真实入口。",
 "u25": "上一轮重试失败与旧错误叠加出现两处提示和日志。现在只保留本次切换错误，说明文件对话仍在，可先继续使用原目录。",
 "u26": "上一轮刷新失败混成工作台操作失败。现在明确只是本次状态没更新，已显示消息还在，点重新读取状态即可。",
 "u27": "上一轮只显示通用未完成，并把继续队列藏在无字三角图标里。现在说明消息仍在队列、没有恢复发送，按钮直接显示“继续队列”。",
 "u28": "上一轮共享 Codex 提示只让人泛泛核对回复。现在说明不知道消息是否已发出、查看本子会话最后一条消息，没看到时先别重发。",
 "u29": "上一轮侧聊发送结果未知却只说核对已有回复。现在明确查看本侧聊最后一条消息，恢复按钮只把原稿放回输入框，不会再次发送。",
 "u30": "上一轮让人点右上刷新，实际按钮却在底部。现在准确指向下方刷新，并明确让管理员检查本机会话记录的访问权限。",
 "u31": "上一轮 MCP 只读查询套用发送结果待确认的话。现在说明工具连接情况没读到，点可见刷新重读，读取不会改配置。",
 "u32": "上一轮“所需本机文件或目录”无对象和位置。现在点名本机设置文件未写入，指向同页本机数据旁的打开目录，再由管理员处理写入权限。",
 "u33": "上一轮送达待核对、结束请求等术语难以理解。现在说明去 Cursor 看最后消息，并说明“结束等待”只关闭记录、不撤回也不重发。",
 "u34": "上一轮 Skills 失败只显示通用缺少 CLI。现在明确没有找到 Codex 程序、因此没读到 Skills，给关闭窗口后到 agent管理的路径。",
 "u35": "上一轮模式弹层只说 CLI 路径无效。现在明确 Codex 程序未找到、模式列表没读到，指向左下角 agent管理重新检测。",
 "u36": "上一轮“核对后允许重新提交”没有判断标准。现在说明先刷新执行状态，已有此计划进展就等待，仍不清楚先别再执行；其他任务运行不能解锁此计划。",
 "u37": "上一轮重新打开记录失败只显示未能完成。现在点名会话，说明记录还在已关闭列表，可以点其旁边重新打开。",
 "u38": "上一轮名称没保存却没有说明输入还在或怎么重试。现在明确 Windows 不允许写记录、输入保留，后端失败回滚原名称；日志可交管理员检查，处理好后按回车重试。",
 "u39": "上一轮同步设置受理与刷新错误书面且易诱导反复切开关。现在明确开关已保存，关闭再打开面板查看即可，不需要重复切换。",
 "u40": "上一轮预览错误没有说哪个文件或是否影响选择。现在点名 ref.md，说明仍已选中、实际发送后才尝试读取，并提供真实重试预览按钮。",
 "u41": "上一轮草稿错误重复前缀且只有隔离测试按钮。现在使用真实主界面，说明磁盘已满、先保留窗口，提供保存输入草稿重试；全局页脚同步显示草稿未保存。",
 "u42": "上一轮修改已发送消息失败只给泛话。现在保留修改输入，未知阶段禁用重发（含回车），提供只读刷新状态；未找到发送证据时继续锁住，不诱导重复发送。",
 "u43": "上一轮部分关联成功有重复对象前缀和两个日志入口。现在一处说已关联数量、点名未关联成果，失败选择保留并明确只重试剩余项。",
 "u44": "上一轮登录 MCP 出错像配置读取失败。现在点名文档服务未完成登录，指向实际重试登录按钮和浏览器授权步骤。",
 "u45": "上一轮 fixture 把同步收尾失败当成仍未断开，与真实调用顺序不符。现在按真实已断开结果显示连接按钮，另说明后台同步未收尾；相同真实故障的本轮改前图另存。",
 "u46": "上一轮目录链接循环仍用排障术语，没说由谁处理。现在说明循环阻止搬移，可继续用原目录，需要切换时把循环链接日志交给管理员。",
 "u47": "上一轮会话数据符号链接难懂且只让人看日志。现在说会话记录里有指向别处的文件夹链接，先继续原目录，需要切换时让管理员处理这些链接。",
 "u48": "上一轮笼统说链接权限，容易被当成普通写文件权限。现在说明 Windows 不允许创建文件夹链接，当前未切换，可继续原目录并请管理员处理创建链接的权限。",
 "u49": "上一轮复制与切换设置保存阶段混在长句里。现在先说明文件已复制、切换设置没存好、当前仍用原目录，接着给继续工作和稍后重试按钮。",
 "u50": "上一轮要求勾选核对日志与已有记录，普通人无从判断。现在提供本次真实已收到的整理内容，说明先复制需要的内容，没有可用内容后才允许重新整理。",
 "u51": "上一轮 CLI 进程退出提示把程序术语和排障混在一起。现在点名 Codex 意外停止、成果没整理完成，先重试，再到可见 agent管理检测程序。"
};
changeReasons.u52='新增真实只读共享 Codex 超时变体：旧通用中文要求核对回复、避免重复发送，误导为消息已提交。现在只说明 MCP 工具连接情况没读到，点击刷新重新读取，不更改配置也不发送任务。';
const writeScenarioDefinition = async previous => {
 const oldRound=JSON.parse(await fs.readFile(path.join(root,'docs/error-audit/readability-baseline/user/manifests/user-results.json'),'utf8'));
 const displayMessages=row=>row?.messages?.length?row.messages:(row?.ui||'').split('\n').map(line=>line.trim()).filter(line=>({u17:/工作台没能启动|读取工作台状态|EIO|\[object Object\]/,u27:/没有恢复发送|未能完成|EIO/,u33:/不知道这条消息|结束等待|EIO|送达待核对|消息是否已发出|请点击.*Cursor|此请求不会自动重发/,u38:/名称|EACCES/,u39:/同步开关已经保存|同步设置已受理|EIO/}[row?.id]||/$a/).test(line));
 const definition=path.join(root,'docs/error-audit/user-scenarios.json');await fs.mkdir(path.dirname(definition),{recursive:true});
 await fs.writeFile(definition,JSON.stringify(scenarios.map(([id,entry,condition,file])=>({id,entry,condition,source:file,changeReason:changeReasons[id],readabilityRound:2,readabilityBaselineImage:id==='u52'?'docs/error-audit/screenshots/u52-before.png':'docs/error-audit/readability-baseline/user/screenshots/'+id+'-after.png',readabilityPreviousUI:id==='u52'?previous.before?.find(r=>r.id===id)?.messages:oldRound.after?.find(r=>r.id===id)?.messages,...(id==='u52'?{beforeVersion:'readability-round2-pre-rewrite',beforeSourceRoot:path.join(root,'.test-data/error-readability/baseline'),supplementaryScenario:true,baselineNote:'新增变体使用第二轮改写前冻结源码对照，不冒充v2.3.46原始报错；现有51项d4原图保持原样'}:{}),...(id==='u45'?{conditionChanged:true,oldCondition:'旧fixture注入connection state save EIO并保持connected=true',newCondition:'实际disconnectProject先删除连接，再在settleProject抛EIO；连接已断开',correctedReadabilityBefore:'docs/error-audit/readability-baseline/corrected/u45.png'}:{}),originalUI:displayMessages(previous.before?.find(r=>r.id===id)),...(id==='u26'?{originalUIAbsent:true,originalUIState:'状态刷新失败没有显示错误，界面仍为已加载会话；参见真实before截图'}:{}),currentUI:displayMessages(previous.after?.find(r=>r.id===id)),before:previous.before?.find(r=>r.id===id),after:previous.after?.find(r=>r.id===id)})),null,2));
};
if(process.argv.includes('--metadata-only')){await writeScenarioDefinition(JSON.parse(await fs.readFile(path.join(root,'.test-data/error-audit/user-results.json'),'utf8')));console.log('Updated '+scenarios.length+' specific change reasons without rendering screenshots');process.exit(0);}
const expected = {
 before: {
  u01:/发送失败：Cursor 原生连接不可用/,u02:/正在重试连接模型服务/,u03:/CLI 连接已关闭/,u04:/模型与额度读取失败/,u05:/请更新 CLI 后重试/,
  u06:/initialize 超时/,u07:/ENOENT/,u08:/自定义设置/,u09:/EIO:/,u10:/无法迁移特殊文件/,u11:/文件不存在或已移动/,u12:/Cursor 原生连接已过期/,
  u13:/核对管理员提供的 SFTP 路径/,u14:/模型与额度读取失败/,u15:/thread\/read 超时/,u16:/ENOSPC:/,u17:/\[object Object\]/,u18:/initialize 超时/,
  u19:/spawn EACCES/,u20:/initialize 超时/,u21:/EACCES:/,u22:/EPERM:/,u23:/EACCES:/,u24:/initialize 超时/,u25:/EIO:/,
 },
 after: {
  u01:/送达待确认：尚未确认.*Cursor 等待队列/,u02:/登录验证失败/,u03:/批准或回答未提交/,u04:/CLI 路径无效/,u05:/暂时不能确认是否已登录/,
  u06:/连接方式已保存.*账号可用性暂未确认/,u07:/检测执行权限：本机未找到/,u08:/部分权限设置未能读取/,u09:/代码目录已保存，但暂未读取到会话切换状态/,
  u10:/暂不支持复制的文件/,u11:/无法访问/,u12:/Cursor 原生连接已过期/,u13:/中央节点未找到/,u14:/CLI 路径无效/,
  u15:/历史消息暂未读取成功/,u16:/消息已提交给 CLI，但本地会话记录暂未保存成功/,u17:/读取工作台状态：.*未能完成/,u18:/未能及时确认|超时/,
  u19:/无法访问/,u20:/未能及时确认|超时/,u21:/无法访问/,u22:/无法访问/,u23:/无法访问/,u24:/未能及时确认|超时/,u25:/未能完成/,
 },
};
for(const id of ['u27','u30','u32','u33','u37','u40','u41','u42','u43','u44','u45']) {expected.before[id]=/EACCES|EIO:|ENOSPC/;expected.after[id]=/无法访问|未能完成|磁盘空间不足/;}
Object.assign(expected.before,{u26:/错误提示验收会话/,u28:/恢复未发送消息到输入框/,u29:/恢复未发送消息到输入框/,u31:/MCP 状态读取失败/,u34:/列表读取失败/,u35:/模式读取失败/,u36:/turn\/start 超时/,u38:/名称未保存/,u39:/EIO:/});
Object.assign(expected.after,{u26:/已显示的内容保留，请重新读取状态/,u28:/核对后恢复这条消息到输入框/,u29:/核对后恢复这条消息到输入框/,u31:/未能及时确认|超时/,u34:/CLI 路径无效/,u35:/CLI 路径无效/,u36:/计划提交待确认/,u38:/无法访问/,u39:/同步设置已受理，但暂未刷新状态/});
for(const id of ['u04','u14','u34','u35'])expected.after[id]=/未找到可运行的本机 CLI.*agent管理/;
Object.assign(expected.before,{u46:/目录链接形成循环/,u47:/会话数据内部包含符号链接/,u48:/无法.*保留文件链接/,u49:/disk unavailable/});
Object.assign(expected.after,{u46:/目录链接形成循环/,u47:/会话数据内部包含符号链接/,u48:/本机没有创建文件链接的权限/,u49:/目录切换记录未能保存/});
Object.assign(expected.before,{u50:/网络连接中断/,u51:/CLI 意外停止/});
Object.assign(expected.after,{u50:/网络连接中断，整理结果尚未确认/,u51:/CLI 意外停止，整理尚未完成/});

Object.assign(expected.after,{
 u01:/不知道这条消息有没有发到 Cursor/,u02:/Codex.*登录|登录.*Codex/,
 u03:/这次选择还没交给 Codex/,u04:/找不到本机 Codex 程序/,u05:/暂时查不到 Claude Code 是否已登录/,
 u06:/网络选项已保存/,u07:/工作目录找不到/,u08:/有些权限设置没读出来/,u09:/代码目录已保存，不用再保存一次/,
 u10:/有些文件暂时不能复制/,u11:/无法打开“result.md”.*Windows 拒绝读取/,u12:/Cursor.*连接.*失效|Cursor 原生连接已过期/,
 u14:/找不到本机 Codex 程序/,u15:/更早的消息没能加载/,u16:/消息已发给 Codex/,
 u17:/工作台没能启动/,u18:/Codex 的模型列表一直没有返回/,u19:/Codex 登录窗口没有打开/,u20:/Codex.*没有返回|没有.*Codex/,
 u21:/项目设置|代码目录.*保存/,u22:/目录选择窗口没能打开/,u23:/Windows 不允许读取这个工作目录/,u24:/没读到 Cursor 当前的模型/,
 u25:/这次切换目录出了问题/,u26:/这次没能更新会话状态/,u27:/没有恢复发送，消息仍留在队列里/,
 u28:/不知道这条消息有没有发到 Codex/,u29:/不知道这条消息有没有发到 Codex/,u30:/Windows 不允许读取.*会话/,
 u31:/没有读到 MCP 工具的连接情况/,u32:/设置没有保存：Windows 不允许写入本机设置文件/,u33:/不知道这条消息有没有发到 Cursor/,
 u34:/没.*Codex.*程序|找不到.*Codex/,u35:/没.*Codex.*程序|找不到.*Codex/,u36:/还不知道这个计划是否已开始/,
 u37:/没能重新打开|没有重新打开/,u38:/名称没存下来/,u39:/同步开关已经保存/,
 u40:/无法预览“ref.md”/,u41:/草稿没保存：这台电脑的磁盘已满/,u42:/修改内容还在输入框中/,u43:/“待处理成果”没有关联/,
 u44:/“文档服务”没有完成登录/,u45:/本项目已经断开/,u46:/文件夹链接绕成了循环/,u47:/会话记录内部有指向别处的文件夹链接/,
 u48:/Windows 没允许在新目录创建文件夹链接/,u49:/文件已复制到新目录/,u50:/网络断开了，工作台没拿到完整的整理结果/,u51:/Codex 意外停止/,
});

expected.before.u52=/共享 Codex 操作未能确认完成.*核对已有回复/;expected.after.u52=/没有读到 MCP 工具的连接情况/;
const imp = file => JSON.stringify(path.join(source, 'src', file).replaceAll('\\', '/'));
// Run the actual backend classification before injecting its result into the real component.
await build({ stdin: { contents: `import fs from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os'; import {grantTestWorkspace,offlineProjectId} from ${JSON.stringify(path.join(fixtureSource,'tests/fixtures/offline-workspace.ts').replaceAll('\\','/'))}; import {projectDirectoryKey} from ${imp('shared/project-directory.ts')}; import * as preparation from ${imp('shared/preparation-error.ts')}; const {preparationErrorMessage}=preparation; import {claudeAuth} from ${imp('core/provider-auth.ts')}; import {checkedSessionFile} from ${imp('core/session-files.ts')}; import {friendlySftp} from ${imp('core/sftp.ts')}; import {CursorNativeRpc} from ${imp('core/cursor-native-rpc.ts')}; import {Workbench} from ${imp('core/workbench.ts')}; import {logsFor} from ${imp('core/logging.ts')}; import {WebSocketRpc} from ${imp('core/websocket-rpc.ts')}; export async function readUnconfirmed(){const rpc=new WebSocketRpc('ws://127.0.0.1:1');rpc.opening=Promise.resolve();rpc.socket={readyState:1,send(){}};try{await rpc.request('mcpServerStatus/list',{},1);}catch(e){return {message:e.message,code:e.code,failure:e.failure};}} export async function unconfirmed(){const rpc=new WebSocketRpc('ws://127.0.0.1:1');rpc.opening=Promise.resolve();rpc.socket={readyState:1,send(){}};try{await rpc.request('turn/start',{},1);}catch(e){return {message:e.message,code:e.code,failure:e.failure};}} export function approval(){const session={provider:'codex',status:'approval',approvals:[{id:'r'}]};try{Workbench.prototype.answer.call({session:()=>session,runtimes:new Map(),changedSession(){}},'s','r','accept');}catch(e){return {message:e.message,code:e.code,failure:e.failure,status:session.status,error:session.error};}} export async function rename(){const s={id:'rename-audit',title:'验收会话'};let writes=0;try{await Workbench.prototype.renameSession.call({session:()=>s,store:{save:async()=>{writes++;throw Object.assign(Error('EACCES: cannot write session record'),{code:'EACCES'});}},broadcast(){}},s.id,'新的验收名称');}catch(e){return {message:e.message,code:e.code,failure:e.failure,title:s.title,writes};}} export async function expired(){const rpc=new CursorNativeRpc({provider:'cursor',purpose:'work',networkRoute:'direct',cursorNative:{transport:'ide-files-v1'},nativeId:'audit-native'});rpc.descriptor={expiresAt:'2020-01-01T00:00:00Z',endpoint:'http://127.0.0.1:1/native/audit'};try{await rpc.invoke('focus',{});}catch(e){return {message:e.message,code:e.code,failure:e.failure};}} export async function lost(){const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error('fetch failed ECONNRESET');};const rpc=new CursorNativeRpc({provider:'cursor',purpose:'work',networkRoute:'direct',cursorNative:{transport:'ide-files-v1'},nativeId:'audit-native'});rpc.descriptor={expiresAt:'2099-01-01T00:00:00Z',endpoint:'http://127.0.0.1:1/native/audit'};try{await rpc.request('cursor/nativeEnqueue',{id:'audit-submit',text:'test'});}catch(e){return {message:e.message,code:e.code,failure:e.failure};}finally{globalThis.fetch=original;}} export async function accepted(){const notices=[];let saves=0;const session={id:'audit-accepted',provider:'codex',purpose:'work',status:'idle',cwd:'C:/audit',messages:[],sources:[],approvals:[]};const runtime={ensureStarted:async()=>{},resolveCapabilities:async()=>[],prompt:async(_text,options)=>{session.status='running';options.submitted();return true;}};const auditRoot=${JSON.stringify(path.join(output,'accepted-store'))};const host={store:{root:auditRoot,sessions:[session],saveSession:async()=>{if(++saves===2)throw Object.assign(Error('ENOSPC: local record save failed'),{code:'ENOSPC'});}},attachingCodex:new Set(),sending:new Set(),steering:new Set(),stoppingSessions:new Set(),changingSettings:new Set(),runtimeJobs:new Map(),canceledSends:new Set(),questions:{lockedPeer:()=>undefined},assertWorkspace(){},session:()=>session,assertCanWork(){},providerEnvironment(){},changedSession(){},applyDeferredSettings:async()=>{},adoptLatestProjectBrief:async()=>{},requireAuth:async()=>{},runtime:async()=>runtime,openCodexDesktopIfClosed:async()=>{},availableSessionContext:async()=>({text:'audit',context:{},sources:[]}),assertReferencesAvailable(){},sessionNotice:(_s,message)=>notices.push(message)};try{await Workbench.prototype.send.call(host,session.id,'audit',[],[],()=>{});}catch(e){notices.push(e.message);}finally{await logsFor(auditRoot).close();}return {message:notices[0],error:session.error,status:session.status,failure:session.failure};} export async function moveCase(kind){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'error-audit-relocation-'))),from=path.join(root,'source'),to=path.join(root,'target');await fs.mkdir(from);await fs.mkdir(to);const wb=new Workbench(path.join(root,'store'),()=>{},()=>{}),originalLink=fs.symlink;try{await wb.store.init();grantTestWorkspace(wb,from);wb.store.settings.codexRequestGuard=false;const session=await wb.createSession('cursor',from,offlineProjectId,'work',undefined,undefined,'inherit',false),linkType=process.platform==='win32'?'junction':'dir';if(kind==='cycle'){const a=path.join(from,'a'),b=path.join(from,'b');await fs.mkdir(a);await fs.mkdir(b);await fs.symlink(b,path.join(a,'to-b'),linkType);await fs.symlink(a,path.join(b,'to-a'),linkType);}if(kind==='metadata'){const outside=path.join(root,'outside');await fs.mkdir(outside);await fs.symlink(outside,path.join(from,'.workbench','sessions',session.id,'project-journal'),linkType);}if(kind==='link-permission'){const outside=path.join(root,'outside');await fs.mkdir(outside);await fs.symlink(outside,path.join(from,'docs'),linkType);fs.symlink=async(...args)=>{if(args[1]===path.join(to,'docs'))throw Object.assign(Error('EPERM: fixture link creation denied'),{code:'EPERM'});return originalLink(...args);};}if(kind==='persist'){await fs.writeFile(path.join(from,'output.txt'),'kept');const originalSave=wb.store.save.bind(wb.store);let failed=false;wb.store.save=async()=>{if(session.cwd===to&&!failed){failed=true;throw Error('disk unavailable');}return originalSave();};}await wb.saveProjectDirectory(offlineProjectId,to,projectDirectoryKey(wb.store.settings.workspaceSnapshot.profile,offlineProjectId));return {error:session.directoryMove?.error,from,to};}finally{fs.symlink=originalLink;await wb.close();if(!path.basename(root).startsWith('error-audit-relocation-')||path.dirname(root)!==await fs.realpath(os.tmpdir()))throw Error('Unexpected fixture root');await fs.rm(root,{recursive:true,force:true,maxRetries:5});}} export const preparationNetwork=preparationErrorMessage(Error('Network timeout: connection reset'),'codex'); export const preparationExit=preparationErrorMessage(Error('CLI 进程已退出（9）'),'codex'); export const preparationNetworkFailure=preparation.preparationFailure?.(Error('Network timeout: connection reset'),'codex'); export const preparationExitFailure=preparation.preparationFailure?.(Error('CLI 进程已退出（9）'),'codex'); export async function disconnect(){const auditRoot=${JSON.stringify(path.join(output,'disconnect-store'))};const host={store:{root:auditRoot},connectedProjects:new Set(['audit']),disconnectingProjects:new Set(),assertAccountReady(){},broadcast(){},accountSync:{connectionChanged(){},settle:async()=>{}},remote:{settleProject:async()=>{throw Error('EIO: sync settle failed');}},projectSync:{settle:async()=>{}}};try{await Workbench.prototype.disconnectProject.call(host,'audit');}catch(e){return {message:e.message,code:e.code,failure:e.failure,connected:host.connectedProjects.has('audit')};}} export const auth=claudeAuth('not-json',1); export const remote=friendlySftp({code:2,message:'No such file'}).message; export async function denied(){const original=fs.stat;fs.stat=async()=>{throw Object.assign(Error('EACCES: permission denied, stat C:/audit/result.md'),{code:'EACCES'});};try{await checkedSessionFile({cwd:'C:/audit',messages:[],outputFiles:[]},'C:/audit/result.md');}catch(e){return {message:e.message,code:e.code,failure:e.failure};}finally{fs.stat=original;}}`, resolveDir: root }, outfile: path.join(output, 'backend.mjs'), bundle: true, platform: 'node', format: 'esm', define: { __dirname: JSON.stringify(path.join(source,'src/core')) }, packages: 'external', logLevel: 'silent' });
const backend = await import(pathToFileURL(path.join(output, 'backend.mjs')).href + '?phase=' + phase), denied = await backend.denied(), lost = await backend.lost(), approval = backend.approval(), accepted = await backend.accepted(), unconfirmed = await backend.unconfirmed();
const moveErrors={};for(const kind of ['cycle','metadata','link-permission','persist']){const scenario=scenarios.find(row=>row[4]==='move-'+kind);if(!only||only.includes(scenario[0]))moveErrors[kind]=await backend.moveCase(kind);}
const fixture = `
import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
import {ModelPicker} from ${imp('renderer/model-picker.tsx')}; import {ProviderAuthPanel} from ${imp('renderer/provider-auth.tsx')};
import {ProviderConnectionSettings} from ${imp('renderer/provider-connection.tsx')}; import {PermissionPicker,PermissionSummary} from ${imp('renderer/permissions.tsx')};
import {ProjectDirectoryForm} from ${imp('renderer/project-directory.tsx')}; import {DirectoryMoveNotice} from ${imp('renderer/directory-move-notice.tsx')};
import {SessionFilesDialog} from ${imp('renderer/session-files.tsx')}; import {CursorNativeSettingsControls} from ${imp('renderer/cursor-native-settings.tsx')};
import {CliConnectionNotice} from ${imp('renderer/cli-connection-notice.tsx')}; import {CentralConnectionError} from ${imp('renderer/central-connection-error.tsx')};
import {ComposerSettings} from ${imp('renderer/composer-settings.tsx')}; import {SessionTranscript} from ${imp('renderer/session-transcript.tsx')};
import {SubsessionChat} from ${imp('renderer/subsession-chat.tsx')}; import {SideChatPanel} from ${imp('renderer/side-chat.tsx')}; import {SessionInputQueue} from ${imp('renderer/session-input-queue.tsx')};
import {NativeSessionPicker} from ${imp('renderer/native-sessions.tsx')}; import {McpPanel} from ${imp('renderer/mcp-panel.tsx')}; import {AgentSettings} from ${imp('renderer/agent-settings.tsx')};
import {CursorNativeQueue} from ${imp('renderer/cursor-native-record.tsx')}; import {AgentCustomization} from ${imp('renderer/agent-customization.tsx')}; import {ComposerMode} from ${imp('renderer/composer-mode.tsx')};
import {PlanMessage} from ${imp('renderer/plan-message.tsx')}; import {ClosedSessionsDialog} from ${imp('renderer/closed-sessions.tsx')}; import {SessionName} from ${imp('renderer/session-name.tsx')};
import {SessionSyncFrame} from ${imp('renderer/session-sync-frame.tsx')}; import {ComposerReferenceTabs} from ${imp('renderer/composer-reference-tabs.tsx')}; import {SessionInputDrafts,SessionInputDraft} from ${imp('renderer/session-input-drafts.tsx')};
import {ConversationMessage} from ${imp('renderer/conversation-message.tsx')}; import {SessionMaterials} from ${imp('renderer/session-materials.tsx')}; import {ProjectCentralConnection} from ${imp('renderer/project-connection.tsx')};
import {personalBinding,personalWorkspace,PERSONAL_PROJECT_ID} from ${imp('shared/personal-workspace.ts')};
import ${imp('renderer/styles.css')}; import ${imp('renderer/session-transcript.css')}; import ${imp('renderer/session-sync-frame.css')}; import ${imp('renderer/directory-move-notice.css')}; import ${imp('renderer/cli-connection-notice.css')};
const kind=new URLSearchParams(location.search).get('kind'); const calls=[]; window.auditCalls=calls;
const savedAuth={status:'authenticated',detail:'已保存个人登录',cwd:'C:/audit',networkRoute:'direct'};
const session={id:'audit-session',title:'错误提示验收会话',provider:'codex',purpose:'work',cwd:'C:/audit',networkRoute:'direct',status:'idle',createdAt:'2026-11-16T08:00:00Z',sources:[],approvals:[],messages:[],handoffPath:'C:/audit/summary.md',autoUpload:false,binding:personalBinding()};
if(kind==='approval'){session.status='approval';session.approvals=[{id:'approval-audit',method:'item/commandExecution/requestApproval',title:'Codex 请求执行命令',details:'测试命令',options:[{id:'accept',label:'允许本次',kind:'allow'}]}];}
if(kind==='cli')Object.assign(session,{status:'running',cliConnection:{state:'reconnecting',kind:'authentication',httpStatus:401,at:'2026-11-16T08:00:00Z',attempt:2}});
if(kind==='cursor-settings'||kind==='native-queue')Object.assign(session,{provider:'cursor',cursorNative:{managed:true,transport:'ide-files-v1'},nativeId:'native-audit',desktopSyncState:'connected'});
if(kind==='native-queue')session.cursorQueue={paused:false,requests:[{id:'native-queued',text:'待核对的消息',state:'uncertain',error:'EIO: native submission receipt failed'}]};
if(kind==='plan')Object.assign(session,{proposedPlan:{messageId:'audit-plan',ready:true,accepted:false},messages:[{id:'audit-plan',kind:'plan',role:'assistant',text:'核对资料后生成测试报告。',createdAt:'2026-11-16T08:00:00Z'}]});
if(kind==='edit-message')Object.assign(session,{nativeId:'native-audit',messages:[{id:'edit-audit',role:'user',text:'上一次任务',createdAt:'2026-11-16T08:00:00Z',nativeItemId:'native-turn',context:{nativeId:'native-audit'}}]});
if(kind==='reference')session.sources=[{id:'audit-source',name:'验收参考资料',sourcePath:'local:C:/audit/ref.md',localPath:'C:/audit/ref.md',sha256:'a'.repeat(64),size:12,referenceMode:'path'}];
if(kind==='send') Object.assign(session,{provider:'cursor',cursorNative:{managed:true,transport:'ide-files-v1'},nativeId:'native-audit',desktopSyncState:'connected'});
let impact=0,authCalls=0,snapshotCalls=0; const fail=message=>Promise.reject(Error(message));
const listeners=new Set(); window.auditPlanState=value=>{Object.assign(session,value);listeners.forEach(listener=>listener({type:'state'}));}; const api={subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},call:async(action,payload)=>{calls.push({action,payload});action=action.replace(/^personal:/,'');
 if(action==='snapshot'){snapshotCalls++;if(kind==='boot'||kind==='refresh'&&snapshotCalls>1)throw {message:'EIO: failed to read local snapshot',code:'EIO'};if(kind==='refresh')setTimeout(()=>listeners.forEach(listener=>listener({type:'state'})),200);if(kind==='plan')return {...snapshot,sessions:[{...session,...window.auditPlanQuery}]};return snapshot;}
 if(action==='logs.rendererError'||action==='logs.interaction'||action==='logs.userFailure')return true;
 if(action==='logs.status')return {diagnostic:{bytes:0,limit:1024,days:14,files:1},workflow:{bytes:0,limit:1024,days:90,files:0},traces:{bytes:0,sessions:0},queued:0,queueBytes:0,suppressed:0,exporting:false};
 if(action==='logs.query')return {items:[{schema:1,id:'audit-preparation-log',at:'2026-11-16T08:00:00Z',version:'2.3.46',instance:'audit',category:'diagnostic',name:kind==='preparation-network'?'preparation.interrupted':'preparation.failed',level:'error',operationId:'audit-preparation'}],coverage:{malformed:0,missingFiles:0,legacyScopeSkipped:0,scannedBytes:0,truncated:false}};
 if(action==='logs.get')return {record:{schema:1,id:'audit-preparation-log',at:'2026-11-16T08:00:00Z',version:'2.3.46',instance:'audit',category:'diagnostic',name:kind==='preparation-network'?'preparation.interrupted':'preparation.failed',level:'error',operationId:'audit-preparation',detail:kind==='preparation-network'?'Network timeout: connection reset':'CLI 进程已退出（9）'},coverage:{malformed:0,missingFiles:0,legacyScopeSkipped:0,scannedBytes:0,truncated:false}};
 if(action==='session.record.save'){session.failure=undefined;listeners.forEach(listener=>{listener({type:'notice',message:'聊天记录已存好。消息没有重复发送。'});listener({type:'state'});});return true;}
 if(action==='session.send'&&kind==='accepted'){const value=${JSON.stringify(accepted)};Object.assign(session,{status:value.status,error:value.error,failure:value.failure});setTimeout(()=>listeners.forEach(listener=>{listener({type:'notice',message:value.message});listener({type:'state'});}),10);return true;}
 if(action==='session.send'){const value=${JSON.stringify(lost)},uncertain=${JSON.stringify(unconfirmed)};if(kind==='child-send')throw Object.assign(Error(uncertain.message),uncertain);throw Object.assign(Error(value.message),value);}
 if(action==='sidechat.send'){const value=${JSON.stringify(unconfirmed)};throw Object.assign(Error(value.message),value);}
 if(action==='session.editLast')return fail('EIO: edit submission failed');
 if(action==='session.queue.resume')return fail('EIO: queue state save failed');
 if(action==='session.native.list')return fail('EACCES: native history denied');
 if(action==='session.mcp'){if(kind==='shared-mcp-read'){const value=${JSON.stringify(await backend.readUnconfirmed())};throw Object.assign(Error(value.message),value);}if(kind==='mcp-read')return fail('initialize 超时');return {servers:[{name:'audit-mcp',title:'文档服务',state:'failed',enabled:true,tools:[],loginPending:false,authStatus:'unknown',loginError:'EIO: MCP login transport failed'}]};}
 if(action==='settings.agent.save')return fail('EACCES: cannot write CLI settings');
 if(action==='session.capabilities')return fail('CLI 路径无效，请到agent管理选择可运行的CLI文件。');
 if(action==='session.modes')return fail('CLI 路径无效，请到agent管理选择可运行的CLI文件。');
 if(action==='session.plan.execute')return fail('turn/start 超时');
 if(action==='session.codexDesktop.sync')return true;
 if(action==='session.source.preview')return fail('EACCES: source read denied');
 if(['session.input','session.input.flush'].includes(action)&&kind==='draft')return fail('ENOSPC: cannot save draft');
 if(action==='session.attachResults'){candidates[0].linkedVersion=1;return {added:[{reference:candidates[0].reference,source:{id:'added'}}],failed:[{reference:candidates[1].reference,error:'EIO: frozen source read failed'}]};}
 if(action==='session.answer'){const value=${JSON.stringify(approval)};Object.assign(session,{status:value.status,error:value.error,failure:value.failure});listeners.forEach(listener=>listener({type:'state'}));throw Object.assign(Error(value.message),value);}
 if(action==='provider.catalog'){if(kind==='permission')return {models:[],checkedAt:'2026-11-16T08:00:00Z',quota:{windows:[],detail:'额度未读取'}};if(kind==='catalog-error')return {models:[],modelError:'initialize 超时',checkedAt:'2026-11-16T08:00:00Z',quota:{windows:[],detail:'额度暂未读取',url:''}};return fail('CLI 路径无效，请选择可运行的 CLI 文件（Windows 使用 .exe、.cmd 或 .ps1）。');}
 if(action==='provider.login')return fail('spawn EACCES: failed to start CLI');
 if(action==='provider.permissions'){if(kind==='permission')return fail('ENOENT: no such file or directory, stat C:/audit');if(kind==='warning')return report;return {provider:'codex',source:'config',sandbox:'workspace-write',approval:'on-request',reviewer:'user',warnings:[],checkedAt:'2026-11-16T08:00:00Z',allowedModes:['inherit','review','auto','full']};}
 if(action==='provider.auth'){if(kind==='auth'&&payload.provider==='claude')return ${JSON.stringify(backend.auth)};authCalls++; if(kind==='route-initial'||kind==='route'&&authCalls>1)return fail('initialize 超时');return savedAuth;}
 if(action==='session.network')return true;
 if(action==='workspace.research')return 'C:/audit';
 if(action==='project.directory.save'){if(kind==='directory-denied')return fail('EACCES: permission denied writing settings');return 'C:/audit/new-project';}
 if(action==='choose.directory')return fail('spawn EPERM: directory picker unavailable');
 if(action==='session.directory.mode')return fail('EIO: directory move read failed');
 if(action==='project.directory.impact'){impact++;if(impact>1)return fail('EIO: read failed');return {following:1,fixed:0,pending:0,failed:0};}
 if(action==='session.file.preview'){const value=${JSON.stringify(denied)};throw Object.assign(Error(value.message),value);}
 if(action==='session.files')return fail('EACCES: permission denied reading file list');
 if(action==='session.cursorNative.settings')return fail('initialize 超时');
 if(action==='session.cursorNative.focus'){const value=${JSON.stringify(await backend.expired())};throw Object.assign(Error(value.message),value);}
 if(action==='rsi.settings')return {config:{enabled:false,quiet:false}}; if(action==='rsi.inbox')return {items:[],jobs:[]}; if(action==='question.sync')return {items:[],jobs:[]};
 if(action==='session.resultCandidates')return {items:candidates,directories:[],available:true,cached:false};
 if(action==='conclusion.list'||action==='handoff.list'||action==='content.list'||action==='directions.list')return [];
 if(action==='session.input.save'){snapshot.inputs[payload.id]=payload.input||payload;return true;}
 return undefined;
}};window.workbench=api;
const settings={connections:[],providerPaths:{codex:'',cursor:'',claude:''},lastWorkspace:'C:/audit',workspaceSnapshot:personalWorkspace(),codexRequestGuard:false};
const snapshot={workspaceReady:true,selectedProjectId:PERSONAL_PROJECT_ID,settings,sessions:[session],inputs:kind==='reference'?{'audit-session':{text:'',sourceIds:['audit-source'],answers:{}}}:{},transfers:[],drafts:[],providers:[],auth:{codex:savedAuth,cursor:savedAuth,claude:savedAuth},personal:{settings,providers:[],auth:{codex:savedAuth,cursor:savedAuth,claude:savedAuth}},questions:{items:[],jobs:[]}};
if(kind==='auth'||kind==='login'){const providers=['codex','cursor','claude'].map(provider=>({provider,available:true,path:'C:/Programs/'+provider+'.exe',version:'本机程序已检测'}));snapshot.providers=providers;snapshot.personal.providers=providers;if(kind==='auth'){snapshot.auth.claude=${JSON.stringify(backend.auth)};snapshot.personal.auth.claude=snapshot.auth.claude;}else{snapshot.auth.codex={status:'unauthenticated',detail:'尚未登录个人账号'};snapshot.personal.auth.codex=snapshot.auth.codex;}}
if(kind==='preparation-network')window.auditPreparationContent=()=>{const helper={...session,id:'audit-helper',purpose:'prepare',status:'error',closedAt:'2026-11-16T08:00:00Z',messages:[{id:'received-preparation',role:'assistant',text:'已收到的整理内容：本轮已完成目录权限检查，还需要补充验证结果。',createdAt:'2026-11-16T08:00:00Z'}]};snapshot.sessions.push(helper);snapshot.drafts[0].prepareSessionId=helper.id;listeners.forEach(listener=>listener({type:'state'}));};
if(kind==='preparation-network'||kind==='preparation-exit')snapshot.drafts=[{id:'audit-preparation',sessionId:session.id,binding:session.binding,sourceSessionTitle:session.title,title:'本轮成果整理',generation:'error',generationError:kind==='preparation-network'?${JSON.stringify(backend.preparationNetwork)}:${JSON.stringify(backend.preparationExit)},generationErrorFailure:kind==='preparation-network'?${JSON.stringify(backend.preparationNetworkFailure)}:${JSON.stringify(backend.preparationExitFailure)},body:'',files:[],createdAt:'2026-11-16T08:00:00Z',inputDir:'C:/audit/preparation',outputPath:'C:/audit/preparation/output.md'}];
const report={provider:'cursor',source:'config',sandbox:'unknown',approval:'unknown',checkedAt:'2026-11-16T08:00:00Z',warnings:['无法读取 Cursor 权限配置：C:/audit/.cursor/cli.json'],execution:'unknown',allowedModes:['inherit','review','full']};
const candidates=['已关联成果','待处理成果'].map((title,index)=>({reference:{scope:'personal',projectId:PERSONAL_PROJECT_ID,id:'result-'+index,version:1},title,content:'验收成果内容',author:'本机用户',updatedAt:'2026-11-16T08:00:00Z',attachments:[]}));
function Fixture(){const [route,setRoute]=useState('direct'),[draft,setDraft]=useState({text:'请核对本轮结果',sourceIds:[],answers:{}}),[drafts]=useState(()=>new SessionInputDrafts()),[projectConnected,setProjectConnected]=useState(true);let view;
if(kind==='cli')view=<CliConnectionNotice provider="codex" value={{state:'reconnecting',kind:'authentication',httpStatus:401,at:'2026-11-16T08:00:00Z',attempt:2}}/>;
if(kind==='model'||kind==='catalog-error')view=<ModelPicker provider="codex" cwd="C:/audit" ready model="" changed={()=>{}}/>;
if(kind==='composer')view=<ComposerSettings session={session}/>;
if(kind==='auth')view=<ProviderAuthPanel provider="claude" auth={${JSON.stringify(backend.auth)}} autoCheck={false}/>;
if(kind==='login')view=<ProviderAuthPanel provider="codex" auth={{status:'unauthenticated',detail:'尚未登录个人账号。'}} autoCheck={false}/>;
if(kind==='route'||kind==='route-initial')view=<ProviderConnectionSettings provider="codex" cwd="C:/audit" auth={savedAuth} sessionId="audit-session" savedRoute={kind==='route-initial'?'direct':'management'} sessionRoute={route} routeChanged={setRoute} activeTaskCount={0}/>;
if(kind==='permission')view=<PermissionPicker provider="codex" cwd="C:/audit" networkRoute="direct" mode="inherit" changed={()=>{}}/>;
if(kind==='warning')view=<PermissionPicker provider="cursor" cwd="C:/audit" networkRoute="direct" mode="inherit" changed={()=>{}}/>;
if(['directory','directory-denied','directory-picker'].includes(kind))view=<ProjectDirectoryForm projectId="audit-project" projectName="验收项目" contextKey="audit" directory="C:/audit/new-project" saved={async()=>{}}/>;
if(kind==='move'||kind==='move-retry')view=<DirectoryMoveNotice session={{...session,directoryMove:{id:'audit-move',from:'C:/audit',to:'C:/audit-new',error:'无法迁移特殊文件：C:/audit/special'}}} api={api} changed={async()=>{}}/>;
if(['move-cycle','move-metadata','move-link-permission','move-persist'].includes(kind)){const move=${JSON.stringify(moveErrors)}[kind.replace('move-','')];view=<DirectoryMoveNotice session={{...session,cwd:move.from,directoryMove:{id:'audit-move',from:move.from,to:move.to,error:move.error}}} api={api} changed={async()=>{}}/>;}
if(kind==='file')view=<SessionFilesDialog sessionId="audit-session" initialPath="C:/audit/result.md" cwd="C:/audit" close={()=>{}}/>;
if(kind==='file-list')view=<SessionFilesDialog sessionId="audit-session" cwd="C:/audit" close={()=>{}}/>;
if(kind==='cursor')view=<CursorNativeSettingsControls session={{...session,provider:'cursor',cursorNative:{managed:true,transport:'ide-files-v1'},nativeId:'native-audit',desktopSyncState:'disconnected'}}/>;
if(kind==='cursor-settings')view=<CursorNativeSettingsControls session={{...session,provider:'cursor',cursorNative:{managed:true,transport:'ide-files-v1'},nativeId:'native-audit',desktopSyncState:'connected'}}/>;
if(kind==='remote')view=<CentralConnectionError message={${JSON.stringify(backend.remote)}} reconnect={()=>{}}/>;
if(kind==='history')view=<div data-transcript-scroll style={{height:320,overflow:'auto'}}><SessionTranscript session={{...session,messageCount:51,messages:[{id:'latest',role:'assistant',text:'最新回复已保留。',createdAt:'2026-11-16T08:00:00Z'}]}} inherited={{count:50,read:async()=>{throw Error('thread/read 超时')}}} renderMessage={message=><p>{message.text}</p>}/></div>;
if(kind==='queue')view=<SessionInputQueue session={{...session,inputQueue:{paused:true,items:[{id:'queued',state:'queued',input:draft}]}}} api={api} changed={async()=>{}}/>;
if(kind==='child-send')view=<SubsessionChat session={session} sessions={[session]} input={draft} edit={(_id,patch)=>setDraft(value=>({...value,...patch}))} api={api} active open={()=>{}} promote={()=>{}} remove={()=>{}} closed={()=>{}} changed={async()=>{}}/>;
if(kind==='side-send')view=<SideChatPanel chats={[{id:'side-audit',parentId:'parent-audit',parentTitle:'原工作会话',projectId:PERSONAL_PROJECT_ID,session,draft:'请核对本轮结果'}]} selectedId="side-audit" select={()=>{}} api={api} changed={async()=>{}}/>;
if(kind==='native-list')view=<NativeSessionPicker provider="codex" projectId={PERSONAL_PROJECT_ID} close={()=>{}} linked={()=>{}}/>;
if(kind==='mcp-read'||kind==='shared-mcp-read'||kind==='mcp-login')view=<McpPanel session={session} close={()=>{}} manage/>;
if(kind==='agent-save')view=<AgentSettings settings={settings} providers={[]} auth={snapshot.auth} toolSessions={[]} openTools={()=>{}} api={api}/>;
if(kind==='native-queue')view=<CursorNativeQueue session={{...session,provider:'cursor',cursorNative:{transport:'ide-files-v1'},cursorQueue:{paused:false,requests:[{id:'native-queued',text:'待核对的消息',state:'uncertain',error:'EIO: native submission receipt failed'}]}}}/>;
if(kind==='skills')view=<AgentCustomization session={session} close={()=>{}}/>;
if(kind==='mode')view=<ComposerMode session={session}/>;
if(kind==='plan')view=<PlanMessage session={{...session,proposedPlan:{messageId:'audit-plan',ready:true,accepted:false}}} message={{id:'audit-plan',role:'assistant',text:'核对资料后生成测试报告。',createdAt:''}} render={text=><p>{text}</p>}/>;
if(kind==='closed')view=<ClosedSessionsDialog sessions={[{...session,closedAt:'2026-11-16T08:00:00Z'}]} api={api} close={()=>{}} remove={()=>{}} reopen={async()=>{throw Error('EIO: saved session read failed')}}/>;
if(kind==='rename')view=<SessionName title="验收会话" save={async()=>{const value=${JSON.stringify(await backend.rename())};if(value.title!=='验收会话'||value.writes!==1)throw Error('rename rollback failed');throw Object.assign(Error(value.message),value);}}/>;
if(kind==='sync-refresh')view=<div style={{paddingTop:260}}><SessionSyncFrame session={session} api={api} changed={async()=>{throw Error('EIO: snapshot read failed')}}><p>任务输入</p></SessionSyncFrame></div>;
if(kind==='reference')view=<div style={{width:800,display:'flex'}}><ComposerReferenceTabs session={{...session,sources:[{id:'audit-source',name:'验收参考资料',sourcePath:'local:C:/audit/ref.md',localPath:'C:/audit/ref.md',sha256:'a'.repeat(64),size:12,referenceMode:'path'}]}} api={api} controls={{sourceIds:['audit-source'],select:()=>{},detach:async()=>{}}} locked={false} removalLocked={false} syncOpen={false} onOpen={()=>{}}/></div>;
if(kind==='draft')view=<SessionInputDraft drafts={drafts} id="audit-draft">{(input,error)=><><button onClick={()=>drafts.write('audit-draft',draft,()=>api.call('session.input',{id:'audit-draft',input:draft}))}>保存输入草稿</button><p>{input.text}</p>{error&&<p className="inline-error" role="alert">{error}</p>}</>}</SessionInputDraft>;
if(kind==='edit-message')view=<ConversationMessage provider="codex" message={{id:'edit-audit',role:'user',text:'上一次任务',createdAt:''}} editLast={async()=>{throw Error('EIO: edit submission failed')}}/>;
if(kind==='materials')view=<SessionMaterials session={session} opened changed={async()=>{}} close={()=>{}}/>;
if(kind==='project-disconnect')view=<ProjectCentralConnection profile={{...personalWorkspace().profile,host:'central.invalid',username:'audit'}} connected={projectConnected} configure={()=>{}} disconnect={async()=>{const value=${JSON.stringify(await backend.disconnect())};setProjectConnected(value.connected);throw Object.assign(Error(value.message),value);}}/>;
return <main style={{maxWidth:960,margin:'48px auto',padding:28,background:'white',border:'1px solid #dfe5df',borderRadius:12}}><h2>团队工作台 · 错误提示验收</h2><section data-audit-surface>{view}</section></main>;}
if(['send','approval','accepted','boot','refresh','cli','model','composer','mode','skills','reference','cursor-settings','native-queue','agent-save','auth','login','draft','edit-message','permission','plan','preparation-network','preparation-exit'].includes(kind)){void import(${imp('renderer/main.tsx')});}else createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await fs.writeFile(path.join(output, 'fixture.tsx'), fixture);
await build({ entryPoints: [path.join(output, 'fixture.tsx')], outdir: output, bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', nodePaths: [path.join(root, 'node_modules')], logLevel: 'silent', loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } });
await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script></html>');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
 for (const [id,entry,condition,file,kind] of scenarios.filter(([id])=>(!only||only.includes(id))&&!(phase==='before'&&!newReadabilityScene&&id==='u52'))) {
  if (id === 'u13') {
   const evidence = JSON.parse(await fs.readFile(path.join(root,'.test-data/error-audit/admin-results.json'),'utf8'))[phase]?.find(item=>item.id==='team-attachment-remote-missing');
   assert(evidence?.pass, 'u13 requires the passing real shared-attachment scene from error-audit-admin.mjs');
   const screenshot='docs/error-audit/screenshots/u13-'+phase+'.png', originalScreenshot=evidence.screenshot;
   await fs.copyFile(path.join(root,originalScreenshot),path.join(root,screenshot));
   const ui=typeof evidence.visibleText==='string'?evidence.visibleText:evidence.visibleText.join('\n');
   const message=ui.split('\n').find(line=>line.includes(evidence[phase]))||evidence[phase];
   results.push({id,entry:'下载团队成果附件',condition:'已展开团队成果的具体附件，下载时中央节点返回该远端文件不存在',source:file,sourceSha256:createHash('sha256').update(await fs.readFile(path.join(source,file))).digest('hex'),phase,sourceRoot:source,screenshot,derivedFromScreenshot:originalScreenshot,sharedEvidenceId:evidence.id,renderedSource:evidence.file,renderedSourceSha256:evidence.sourceSha256,messages:[message],ui,assertions:evidence.assertions.map(check=>({...check,passed:check.pass})),passed:evidence.pass});
   continue;
  }
  const page=await browser.newPage({viewport:{width:1320,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(pathToFileURL(path.join(output,'index.html')).href+'?kind='+kind);
  if(kind==='send'||kind==='approval'||kind==='accepted') {
   await page.locator('.session-row').first().click();
   if(kind==='send'||kind==='accepted'){await page.getByLabel('任务输入',{exact:true}).fill('请核对本轮结果');await page.getByRole('button',{name:'发送任务',exact:true}).click();}
   else await page.getByRole('button',{name:'允许本次',exact:true}).click();
  }
  if(kind==='model'||kind==='permission'){await page.getByRole('button',{name:'新建会话',exact:true}).click();await page.getByLabel('本地工作目录',{exact:true}).fill('C:/audit');}
  if(kind==='route')await page.getByRole('button',{name:'应用连接方式',exact:true}).click();
  if(kind==='directory')await page.getByRole('button',{name:'保存代码目录',exact:true}).click();
  if(kind==='directory-denied')await page.getByRole('button',{name:'保存代码目录',exact:true}).click();
  if(kind==='directory-picker')await page.getByRole('button',{name:'选择目录',exact:true}).click();
  if(kind==='auth'||kind==='login'){await page.getByRole('button',{name:'agent管理',exact:true}).click();const section=page.locator('.provider-setting').filter({has:page.getByRole('strong',{name:kind==='auth'?'Claude Code':'Codex'})});const providerPanel=page.getByLabel((kind==='auth'?'Claude Code':'Codex')+' 登录状态',{exact:true});await providerPanel.scrollIntoViewIfNeeded();if(kind==='login')await providerPanel.getByRole('button',{name:'登录个人账号',exact:true}).click();}
  if(kind==='cursor-settings')await page.getByRole('button',{name:'Cursor 模型',exact:true}).click();
  if(kind==='move-retry')await page.getByRole('button',{name:'重试切换',exact:true}).click();
  if(kind==='queue')await page.getByRole('button',{name:'继续队列',exact:true}).click();
  if(kind==='child-send'||kind==='side-send')await page.getByRole('button',{name:'发送任务',exact:true}).click();
  if(kind==='agent-save'){await page.getByRole('button',{name:'agent管理',exact:true}).click();await page.getByRole('button',{name:'保存设置',exact:true}).click();}
  if(kind==='skills'){await page.getByRole('button',{name:'更多会话操作',exact:true}).click();await page.getByRole('button',{name:'Codex 设置',exact:true}).click();await page.getByRole('tab',{name:'Skills',exact:true}).click();}
  if(kind==='mode')await page.getByRole('button',{name:'选择对话模式',exact:true}).click();
  if(kind==='plan')await page.getByRole('button',{name:'执行计划',exact:true}).click();
  if(kind==='preparation-network'||kind==='preparation-exit'){await page.getByRole('button',{name:'更多功能',exact:true}).click();await page.getByRole('menuitem',{name:'打开成果整理',exact:true}).click();await page.getByRole('button',{name:'查看整理任务：本轮成果整理',exact:true}).click();}
  if(kind==='closed')await page.getByRole('button',{name:'重新打开',exact:true}).click();
  if(kind==='rename'){await page.getByRole('button',{name:'修改会话名称：验收会话',exact:true}).click();await page.getByLabel('会话名称',{exact:true}).fill('新的验收名称');await page.getByLabel('会话名称',{exact:true}).press('Enter');}
  if(kind==='sync-refresh'){await page.getByRole('button',{name:'非同步会话，调整桌面同步',exact:true}).click();await page.getByRole('switch',{name:'与 Codex 桌面版同步',exact:true}).click();}
  if(kind==='reference')await page.getByRole('button',{name:'查看参考资料：验收参考资料',exact:true}).click();
  if(kind==='draft'){await page.getByLabel('任务输入',{exact:true}).fill('请核对本轮结果');await page.getByLabel('任务输入',{exact:true}).blur();await expect(page.getByRole('button',{name:'保存输入草稿',exact:true})).toBeVisible();}
  if(kind==='edit-message'){await page.getByRole('button',{name:'编辑上一条消息',exact:true}).click();await page.getByLabel('编辑上一条消息',{exact:true}).fill('修改任务');await page.getByRole('button',{name:'重新发送',exact:true}).click();}
  if(kind==='materials'){await page.getByRole('checkbox',{name:'关联成果：已关联成果',exact:true}).check();await page.getByRole('checkbox',{name:'关联成果：待处理成果',exact:true}).check();await page.getByRole('button',{name:'关联 2 项成果',exact:true}).click();}
  if(kind==='project-disconnect')await page.getByRole('button',{name:'断开本项目',exact:true}).click();
  if(kind==='cursor')await page.getByRole('button',{name:'在 Cursor 中打开',exact:true}).click();
  if(kind==='composer')await page.getByRole('button',{name:'选择模型',exact:true}).click();
  if(kind==='permission')await page.locator('.permission-picker').scrollIntoViewIfNeeded();
  if(kind==='history')await page.locator('[data-transcript-scroll]').evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new WheelEvent('wheel',{deltaY:-100}));});
  if(['move','move-cycle','move-metadata','move-link-permission','move-persist'].includes(kind))await page.locator('.directory-move-notice details > summary').click();
  await page.waitForTimeout(650);
  const viewportTargets={u03:'.messages .inline-error',u04:'.model-picker .inline-error',u07:'.permission-picker .inline-error',u08:'.permission-summary .callout',u09:'[role=alert]',u11:'[role=alert]',u14:'.composer-popover .inline-error',u23:'[role=alert]',u24:'.inline-error',u32:'[role=alert]',u35:'.composer-popover .inline-error',u36:'.proposed-plan .inline-error',u40:'.inline-error',u44:'.inline-error',u46:'.directory-move-notice > p',u47:'.directory-move-notice > p',u48:'.directory-move-notice > p',u49:'.directory-move-notice > p',u50:'.preparation-summary [role=alert]',u51:'.preparation-summary [role=alert]'};
  const visibleTarget=phase==='after'?viewportTargets[id]:id==='u32'?'.inline-error':undefined;
  if(visibleTarget){const notice=page.locator(visibleTarget).first();if(await notice.count()){await notice.scrollIntoViewIfNeeded();await expect(notice).toBeInViewport({ratio:1});}else throw Error(id+' missing visible error selector '+visibleTarget);}
  if(phase==='after'&&id==='u41'){await expect(page.locator('.statusbar')).toContainText('输入草稿未保存');await expect(page.locator('.statusbar')).not.toContainText('本机已保存');}
  if(phase==='after'&&id==='u42'){await expect(page.getByRole('button',{name:'发送结果未知，暂不重发',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'刷新会话状态',exact:true})).toBeVisible();}
  if(phase==='after'&&id==='u03'){await expect(page.getByRole('button',{name:'允许本次',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'恢复会话连接',exact:true})).toBeInViewport();assert(!/项操作等待你的授权/.test(await page.locator('body').innerText()));}
  if(phase==='after'&&id==='u50'){await expect(page.getByLabel('整理状态',{exact:true})).toContainText('整理结果待核对');await expect(page.getByRole('button',{name:'重试',exact:true})).toBeDisabled();await expect(page.getByRole('checkbox',{name:'没有可用内容，允许重新整理',exact:true})).not.toBeChecked();}
  if(phase==='after'&&id==='u44')await expect(page.getByRole('button',{name:'重试登录',exact:true})).toBeEnabled();
  if(phase==='after'&&id==='u36'){await expect(page.getByRole('button',{name:'计划提交待确认',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'刷新执行状态',exact:true})).toBeInViewport();}
  if(kind==='materials'){await expect(page.getByRole('checkbox',{name:'关联成果：已关联成果',exact:true})).toBeDisabled();await expect(page.getByRole('checkbox',{name:'关联成果：待处理成果',exact:true})).toBeChecked();}
  const text=await page.locator('body').innerText(),screenshot=correctedReadability?'docs/error-audit/readability-baseline/corrected/u45.png':'docs/error-audit/screenshots/'+id+'-'+phase+'.png';
  if(correctedReadability)await fs.mkdir(path.join(root,'docs/error-audit/readability-baseline/corrected'),{recursive:true});
  const messages=[...new Set((await page.locator('.inline-error,.send-failure,.toast,.cli-connection-notice,.cli-reconnect-line,.transcript-boundary,.provider-auth p,.permission-summary p,.directory-move-notice').allInnerTexts()).map(value=>value.trim()).filter(Boolean))];
  if(!verificationOnly)await page.screenshot({path:path.join(root,screenshot),fullPage:true});
  const substates=[];
  if(phase==='after'&&id==='u52'){await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByRole('alert')).toContainText('没有读到 MCP 工具的连接情况');const calls=await page.evaluate(()=>window.auditCalls);assert.equal(calls.filter(call=>call.action==='session.mcp').length,2);assert(!calls.some(call=>/session\.send|session\.mcp\.login|draft\.retry/.test(call.action)),'read refresh must not submit a message, login, or modify settings');substates.push({condition:'点击真实刷新再次查询相同只读状态',check:'retry only repeats session.mcp and never sends a message or changes settings',passed:true});}
  if(phase==='after'&&id==='u16'){await page.getByRole('button',{name:'重试保存',exact:true}).click();await expect(page.locator('.messages')).not.toContainText('这台电脑还没存好聊天记录');await expect(page.locator('.session-metadata')).toContainText('处理中');const calls=await page.evaluate(()=>window.auditCalls);assert.equal(calls.filter(call=>call.action.replace(/^personal:/,'')==='session.record.save').length,1);assert.equal(calls.filter(call=>call.action.replace(/^personal:/,'')==='session.send').length,1,'record save must never send a second message');substates.push({condition:'点击重试保存后清除警告且保持处理中',check:'save-only recovery clears the warning and never resends the accepted message',passed:true});}
  if(phase==='after'&&id==='u42'){await page.getByLabel('编辑上一条消息',{exact:true}).press('Enter');assert.equal((await page.evaluate(()=>window.auditCalls)).filter(call=>call.action.replace(/^personal:/,'')==='session.editLast').length,1,'Enter must not bypass the uncertain edit lock');await page.getByRole('button',{name:'刷新会话状态',exact:true}).click();await expect(page.getByRole('button',{name:'发送结果未知，暂不重发',exact:true})).toBeDisabled();await expect(page.getByLabel('编辑上一条消息',{exact:true})).toHaveValue('修改任务');assert.equal((await page.evaluate(()=>window.auditCalls)).filter(call=>call.action.replace(/^personal:/,'')==='session.editLast').length,1,'refreshing an uncertain edit must not resubmit');substates.push({condition:'未知编辑结果刷新后仍不能重发且修改原文保留',check:'read-only snapshot never resubmits the edit or unlocks it without evidence',passed:true});}
  if(phase==='after'&&(id==='u50'||id==='u51')) {
   await page.locator('.preparation-summary').getByRole('button',{name:'查看日志',exact:true}).click();
   await expect(page.getByRole('dialog',{name:'日志与分析',exact:true})).toBeVisible();
   await page.getByRole('button',{name:id==='u50'?'查看 成果整理中断 日志':'查看 成果整理出现问题 日志',exact:true}).click();
   await expect(page.getByLabel('技术错误详情',{exact:true})).toContainText(id==='u50'?'Network timeout: connection reset':'CLI 进程已退出（9）');
   const logScreenshot='docs/error-audit/screenshots/'+id+'-logs-after.png';if(!verificationOnly)await page.screenshot({path:path.join(root,logScreenshot),fullPage:true});
   await page.getByRole('button',{name:'关闭日志与分析',exact:true}).click();
   substates.push({condition:'从失败提示点击实际日志入口并展开技术详情',check:'production log viewer displays the original diagnostic only after opening logs',screenshot:logScreenshot,passed:true});
   if(id==='u50') {
    await page.evaluate(()=>window.auditPreparationContent());
    await page.locator('.preparation-received-content summary').click();
    await expect(page.locator('.preparation-received-content')).toContainText('本轮已完成目录权限检查');
    const receivedScreenshot='docs/error-audit/screenshots/u50-received-content-after.png';if(!verificationOnly)await page.screenshot({path:path.join(root,receivedScreenshot),fullPage:true});
    await page.locator('.preparation-received-content').getByRole('button',{name:'复制这条回复',exact:true}).click();
    assert((await page.evaluate(()=>window.auditCalls)).some(call=>call.action==='copy'&&call.payload.includes('本轮已完成目录权限检查')),'received helper content must use the actual Copy button');
    substates.push({condition:'相同中断另有已收到的助手内容，展开并复制保留',check:'the real helper messages and Copy button provide an actionable content recovery path',screenshot:receivedScreenshot,passed:true});
    assert.equal((await page.evaluate(()=>window.auditCalls)).filter(call=>call.action.replace(/^personal:/,'')==='draft.retry').length,0,'an unconfirmed result must not retry before review');
    await page.getByRole('checkbox',{name:'没有可用内容，允许重新整理',exact:true}).check();
    await expect(page.getByRole('button',{name:'重试',exact:true})).toBeEnabled();
    assert.equal((await page.evaluate(()=>window.auditCalls)).filter(call=>call.action.replace(/^personal:/,'')==='draft.retry').length,0,'confirming review only enables retry and must not submit it');
    await page.getByRole('button',{name:'重试',exact:true}).click();
    assert.equal((await page.evaluate(()=>window.auditCalls)).filter(call=>call.action.replace(/^personal:/,'')==='draft.retry').length,1,'only explicit review permits one retry action');
    substates.push({condition:'结果待核对时禁止重试，显式确认只启用按钮，随后点击才提交一次',check:'review confirmation never submits draft.retry; only the subsequent retry click submits once',passed:true});
   }
  }
  if(phase==='after'&&id==='u36') {
   for(const status of ['starting','running','approval']) {
    await page.evaluate(status=>window.auditPlanState({status}),status);
    await expect(page.locator('.session-metadata')).toContainText({starting:'连接 CLI',running:'处理中',approval:'等待操作确认'}[status]);
    await page.getByRole('button',{name:'刷新执行状态',exact:true}).click();
    await expect(page.locator('.proposed-plan [role=alert]')).toContainText('这个会话有任务正在处理，但还不知道是不是这个计划');
    await expect(page.getByRole('button',{name:'计划提交待确认',exact:true})).toBeDisabled();
    await expect(page.getByRole('button',{name:'刷新执行状态',exact:true})).toBeVisible();
    const subScreenshot=status==='running'?'docs/error-audit/screenshots/u36-other-task-running-after.png':undefined;
    if(subScreenshot)await page.screenshot({path:path.join(root,subScreenshot),fullPage:true});
    substates.push({condition:'计划仍待确认，刷新返回会话状态 '+status,check:'unrelated active work never confirms this plan or releases its retry lock',ui:await page.locator('.proposed-plan').innerText(),screenshot:subScreenshot,passed:true});
   }
   await page.evaluate(()=>{window.auditPlanQuery={proposedPlan:{messageId:'different-plan',accepted:true}};});
   await page.getByRole('button',{name:'刷新执行状态',exact:true}).click();
   await expect(page.getByRole('button',{name:'计划提交待确认',exact:true})).toBeDisabled();
   await expect(page.locator('.proposed-plan [role=alert]')).toContainText('还不知道是不是这个计划');
   substates.push({condition:'刷新返回另一条计划的 accepted 记录',check:'acceptance of a different plan never confirms this plan',passed:true});
   await page.evaluate(()=>{window.auditPlanQuery={proposedPlan:{messageId:'audit-plan',accepted:true}};});
   await page.getByRole('button',{name:'刷新执行状态',exact:true}).click();
   await expect(page.locator('.proposed-plan [role=alert]')).toContainText('计划已提交，请在本会话查看执行进展');
   await expect(page.getByRole('button',{name:'刷新执行状态',exact:true})).toHaveCount(0);
   const executeAgain=page.getByRole('button',{name:'执行计划',exact:true});if(await executeAgain.count())await expect(executeAgain).toBeDisabled();
   assert.equal((await page.evaluate(()=>window.auditCalls)).filter(call=>call.action.replace(/^personal:/,'')==='session.plan.execute').length,1,'state verification must not resubmit a plan');
   substates.push({condition:'刷新返回同一条计划的 accepted 记录',check:'only matching plan acceptance confirms submission; all refreshes perform no resend',passed:true});
  }
  assert.deepEqual(errors,[],id+' React runtime errors');
  const semanticMatch=correctedReadability ? /未连接/.test(text) && /断开|未能完成/.test(text) : expected[phase][id].test(text),technicalHidden=phase==='before'||!/(?:ENOENT|EACCES|EPERM|EIO:|ENOSPC|initialize 超时|thread\/read 超时|\[object Object\])/.test(text);
  const outcomeCorrect=phase==='before'||id!=='u16'||!/发送失败|消息未提交|本机已保存/.test(text)&&/重试保存/.test(text);
  results.push({id,entry,condition,source:file,sourceSha256:createHash('sha256').update(await fs.readFile(path.join(source,file))).digest('hex'),phase,sourceRoot:source,screenshot,messages,ui:text,substates,calls:await page.evaluate(()=>window.auditCalls),assertions:[{check:'production React component rendered',passed:true},{check:'no React runtime error',passed:errors.length===0},{check:'critical failure and recovery are in the visible viewport',passed:true,selector:visibleTarget||null},{check:'expected visible failure state',pattern:expected[phase][id].source,passed:semanticMatch},{check:'technical diagnostics only in logs',passed:technicalHidden},{check:'accepted message is never described as unsubmitted or saved',passed:outcomeCorrect},...substates.map(state=>({check:state.check,condition:state.condition,passed:state.passed}))],passed:semanticMatch&&technicalHidden&&outcomeCorrect});
  await page.close();
 }
} finally {await browser.close();}
if(correctedReadability){assert(results.length===1&&results[0].passed);await fs.writeFile(path.join(root,'docs/error-audit/readability-baseline/corrected/u45.json'),JSON.stringify({conditionChanged:true,oldCondition:'旧harness笼统注入connection state save EIO并保持connected=true，与真实disconnectProject先delete后settle的顺序不符',newCondition:'实际Workbench.disconnectProject已删除connectedProjects，remote.settleProject随后EIO，连接应为false',source,sourceRootImmutable:true,result:results[0]},null,2));console.log('PASS corrected actual round-2 before u45');process.exit(0);}
if(verificationOnly){
 assert(results.every(result=>result.passed));
 for(const frozen of frozenImages)assert.equal(createHash('sha256').update(await fs.readFile(path.join(shots,frozen.name))).digest('hex'),frozen.sha256,'Frozen screenshot changed: '+frozen.name);
 await fs.writeFile(path.join(root,'.test-data/error-audit/user-action-verification.json'),JSON.stringify({passed:true,mode:'production UI actions without screenshot writes',frozenImages,results},null,2));
 console.log('PASS u50 log/review/retry actions; frozen screenshot hashes unchanged');process.exit(0);
}
const resultFile=path.join(root,'.test-data/error-audit/user-results.json');let previous={};try{previous=JSON.parse(await fs.readFile(resultFile,'utf8'));}catch{}
previous[phase]=only?scenarios.map(([id])=>results.find(result=>result.id===id)||previous[phase]?.find(result=>result.id===id)).filter(Boolean):results;await fs.writeFile(resultFile,JSON.stringify(previous,null,2));
await writeScenarioDefinition(previous);
assert(results.every(result=>result.passed),'Some user scenarios failed; inspect user-results.json');
console.log('PASS '+results.length+' user error scenarios ('+phase+') from '+source);
