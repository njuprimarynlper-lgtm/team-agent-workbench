// Close the original "needs individual change" candidates without equating
// AST counts, source propagation review and independent UI scores.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { publicErrorState } from '../src/main/public-failures.ts';

const root = process.cwd();
const pipeline = JSON.parse(await fs.readFile(path.join(root, 'docs/error-audit/pipeline-review.json'), 'utf8'));
const candidates = pipeline.entries.filter(row => row.disposition === '需单独修改');
const review = JSON.parse(await fs.readFile(path.join(root, 'docs/error-audit/readability-review.json'), 'utf8'));
const preparationEvents = JSON.parse(await fs.readFile(path.join(root, '.test-data/error-audit/preparation-notice-events.json'), 'utf8'));
const definitions = new Map();
const imageChecks = new Map();
for (const item of review.scenarios) {
  const supplied = [item.sourceScreenshot, item.evidence].filter(Boolean).map(file => path.isAbsolute(file) ? file : path.join(root, file.startsWith('screenshots/') ? 'docs/error-audit' : '', file));
  const choices = [...supplied, path.join(root, 'docs/error-audit/screenshots', item.id + '-after.png'), path.join(root, 'docs/error-audit/screenshots', item.id + '-after.jpg')];
  for (const file of choices) {
    const bytes = await fs.readFile(file).catch(() => undefined);
    if (!bytes) continue;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    imageChecks.set(item.id, { file, sha256, matchesIndependentReview: sha256 === item.afterSha256 });
    break;
  }
}
function group(ids, value) { for (const id of ids.split(' ')) { assert(!definitions.has(id)); definitions.set(id, value); } }
const boundary = ['src/main/index.ts#emit', 'src/main/public-failures.ts#publicErrorState', 'src/renderer/main.tsx#notice'];
group('932980b2373588 3948278e78cb96', { category: 'normal-confirmation', status: 'retain-normal-behavior', reason: '首次信任服务器的确认问题，不是异常。地址及首次信任选择需要保留；管理员指纹是连接身份核对数据，不是捕获异常原文。不能把确认框改成失败提示。', proof: ['src/admin/main.ts#connect', 'src/main/index.ts#remote.connect'] });
group('32295ef962e2eb a473f19a27172d', { category: 'shared-native-dialog', reason: '两个管理员启动catch均已改为showStartupFailure；源异常记录诊断日志，现通过共用startupFailureOptions显示中文及真实打开日志文件夹入口。相同界面不重复计数。', scenes: ['native-admin-start'], proof: ['src/admin/main.ts#queueLauncherWindow', 'src/admin/main.ts#app.whenReady.catch', 'src/main/startup-failure.ts'] });
group('7ef4d21ffef0af be92d989e17106', { category: 'shared-native-dialog', reason: '窗口启动及应用启动两个catch均调用showStartupFailure，原始异常不再进入原生主框。属于同一用户端启动提示的两个调用源。', scenes: ['native-user-start'], proof: ['src/main/index.ts#createWindow', 'src/main/index.ts#app.whenReady.catch', 'src/main/startup-failure.ts'] });
group('48a47ab4f496a3', { category: 'shared-native-dialog', reason: '关闭后持久化失败改为showRecordSaveFailure，说明窗口已关闭且最近记录可能未保存，不再附加原技术异常。', scenes: ['native-close-save'], proof: ['src/main/index.ts#reportCloseFailure', 'src/main/startup-failure.ts#showRecordSaveFailure'] });
const normal = [
 ['6b959d73a3c277', '求助已关闭：验收求助', '求助关闭事件通知；标题为用户内容，不是异常。'],
 ['d84d24c995d9c2 6f63878497036f', '自动对话建议结束：排查 ECONNRESET', '结束建议是正常通知。新版先按明确通知前缀保留标题，不能因标题含错误术语而丢失原意。', 'notice-question-ended'],
 ['89de82a7e542d0', '收到求助答复：验收求助', '新求助/答复事件通知，保留实际标题及原通知行为。'],
 ['da9bd48021792a', '求助有后续：修复 EACCES', '求助后续提醒是正常通知；标题包含技术词仍逐字保留。', 'notice-question-follow'],
 ['bfe7fafb4013bb', '定时任务完成：调查 ECONNRESET', '完成/结束通知在运行记录保存后发出。标题是用户内容，不能按其中的技术词再生成一条错误。', 'notice-task-completed'],
 ['a9ae1b3a76158c', '文件已加入下载队列，可在传输记录查看结果', '这是已入队状态，不宣称下载完成；实际结果在传输记录中显示。'],
 ['8f625f918b6411 ca16ed7c21a4bc', '附件已下载', '下载await完成后发送的正常成功提示，不应用失败格式化器重写。'],
];
for (const [ids, sample, reason, scene] of normal) group(ids, { category: 'normal-notice', reason, sample, scenes: scene ? [scene] : [], proof: [...boundary] });
group('66d0048c9453b9 dad9e768ac3c3e 74305ac405e2bc', { category: 'forwarding-call-site', status: 'retain-forwarding-with-boundary', reason: '分别是定时任务/求助/推荐通知接线及sessionNotice转发，不是独立错误。追溯到main emit统一出口；具体失败源单列处理，正常通知/用户标题保留。不能把这三次转发算三张错误截图。', proof: ['src/core/workbench.ts#constructor', 'src/core/workbench.ts#sessionNotice', ...boundary] });
group('5cd3003f3d3c32', { category: 'diagnostic-only', status: 'retain-internal-diagnostic', reason: 'taskbar.update失败只写diagnostic warning，没有MessageBox/notice或renderer显示。无新增用户错误界面，不伪造after错误截图。', proof: ['src/main/index.ts#syncTaskbar'] });
group('b9ebbee568f30e db2a099c6d8733', { category: 'transfer-state', reason: '传输已确认完成与状态未保存分开：completed保持done并提供只保存本机记录的恢复；未完成传输保留原请求/目标及阶段。异常原文分别记录transfer.failed/state_save_failed，UI使用transferFailureMessage。', scenes: ['team-transfer-record-save', 'team-transfer-uncertain'], proof: ['src/core/transfers.ts#pump', 'src/core/transfers.ts#retrySave', 'src/shared/transfer-failure.ts', 'src/renderer/transfer-records.tsx'], tests: ['tests/transfer-recovery.test.ts', 'tests/workflow-states.test.ts'] });
const failures = [
 ['e55d42e9502af8', '定时任务后台：disk unavailable', '后台调度故障必须按已知故障源处理，不能等英文原因碰巧包含errno。', 'notice-scheduled-background'],
 ['f8288c27ab7947', '定时任务执行记录未保存：disk unavailable', '执行记录保存失败的已知对象/阶段必须保留；未知英文尾部只进日志。', 'notice-task-record'],
 ['6ab6efe31226e2 6a6573b5a92d58', '会话记录保存失败：disk unavailable', '两个后台持久化catch现在显式标明会话记录保存失败；统一出口可确定这是错误，不再依赖原文猜测。', 'notice-local-save'],
 ['6718a8785ce9c5', '项目资料引用未加入：disk unavailable', '引用项目资料失败不等同消息发送结果未知，不能把未知技术尾部原样显示。', 'notice-project-reference'],
 ['dbe72786ab9651 12533c3062f4c3 bc47d2966adde9', '个人成果接口暂不可用：disk unavailable', '三个个人成果准备调用源共用一个可读失败模板；保留成果仍在、接口不可用的对象与真实下一步。', 'notice-personal-results'],
 ['bfcf19f13a50f2', '同步请求暂未完成：disk unavailable', '同步请求异常不应泄出英文或暗示原聊天丢失；下一步指向同步连接本身。', 'notice-codex-sync'],
 ['258befb6bfba3e', 'AI 推荐参考暂未恢复：disk unavailable', '推荐引用恢复失败与消息重新发送分开，尾部原文只进日志。', 'notice-rsi-reference'],
 ['a672b1e2fd48e8', '会话自动上传未完成：disk unavailable', '自动上传尚未完成，应指向传输结果，不能宣称本机会话未保存。', 'notice-auto-upload'],
 ['677a812b101168', '会话文件未上传：验收.txt，disk unavailable', '保留具体文件未上传这一事实，剥离其后的未知技术原因。', 'notice-session-file-upload'],
 ['197b9749294f35', '项目说明未更新：disk unavailable', '项目说明更新失败有确定对象，不应原样显示底层英文。', 'notice-project-brief'],
];
for (const [ids, sample, reason, scene] of failures) group(ids, { category: 'known-failure-notice', sample, reason, scenes: [scene], proof: [...boundary], rawProbe: 'disk unavailable' });
const partials = [
 ['3efd9f5922afb2', '会话已迁移，提问关联将在后台继续清理：EIO: cleanup failed', '会话迁移已完成，只有旧求助关联清理未完成。', 'notice-migrated'],
 ['20fabb64364c18 dfd2f95c2fc729', '引导已送达，但本地记录保存失败：EIO: write failed', '补充消息已发给AI，仅本机聊天记录未保存；两个同源catch不能误称消息发送未知。', 'notice-steer-saved'],
 ['8d47a097f45a41', '“验收会话”已关闭。停止后台进程时出现问题：EIO: process close failed', '关闭会话已完成，但AI后台是否停止还没确认。', 'notice-closed'],
 ['4d9f3edbf74d90', '整理记录已删除，临时文件暂未清理：EIO: cleanup failed', '整理记录已删除，仅临时文件未清理；不再诱导重复删除。', 'notice-draft-cleanup'],
];
for (const [ids, sample, reason, scene] of partials) group(ids, { category: 'known-partial-notice', sample, reason, scenes: [scene], proof: [...boundary], rawProbe: 'EIO:' });
group('757dc5acc61cde', { category: 'typed-preparation-notice', reason: '真实failPreparation和onDone错误分支不再固定拼“整理失败”。使用已有generationErrorFailure，结果未知时说成果整理中断，已知未完成则明确未完成，并按全局可用入口指向左侧更多/成果整理。code/outcome/logRef随notice传递；u50静态卡片证据不冒充此事件已验证。', event: preparationEvents.after.event, scenes: ['notice-preparation-interrupted'], proof: ['src/core/workbench.ts#failPreparation', 'src/core/workbench.ts#onDone', 'src/shared/preparation-error.ts#preparationNoticeFailure', ...boundary], sourceGuard: 'preparationNoticeFailure(d.title, failure)', tests: ['tests/error-audit-user.test.ts'], verificationLog: '.test-data/error-audit/preparation-notice-regression.log' });
group('fc49905ad77724', { category: 'typed-send-notice', reason: 'session.send的异步catch现在先publicFailure(error,session.send)，再连同failure传给notice；不再把裸英文消息交给事件出口猜。提交事实继续由原回调/typed outcome决定。', scenes: ['u01', 'u16'], proof: ['src/main/index.ts#session.send', 'src/main/index.ts#notice', 'src/main/public-failures.ts'], sourceGuard: "notice(failure.message, failure)" });
group('759d6e0f1483ae', { category: 'launcher-export-recovery', reason: '实际原始MessageBox残留已修。进度窗与启动失败框都调用同一选择/导出/重试循环；失败日志化，仅用户确认才再次选择位置，取消不生成成功或失败提示。CLI直导出保持原约定。', scenes: ['native-launcher-export'], proof: ['scripts/start-dev-hidden.ps1#Invoke-StartupDiagnosticsExport', 'scripts/startup-failure.ps1#Invoke-StartupDiagnosticsExport', 'scripts/startup-error-dialog.cs#ShowExportFailure'], tests: ['tests/launcher.test.ts'], verificationLog: '.test-data/error-audit/launcher-export-regression.log' });
group('f5c28029527261 d694ad367253da', { category: 'normal-cancellation', status: 'retain-normal-cancellation', reason: '进度窗取消用OperationCanceledException；候选运行环境捕获该类型后继续抛给外层，最终记Cancelled并exit2，不显示启动失败。不是待改报错文案。', proof: ['scripts/start-dev-hidden.ps1#Update-StartupProgress', 'scripts/start-dev-hidden.ps1#OperationCanceledException'] });
group('0fff46a8776763', { category: 'normal-cancellation-restored', status: 'implemented-normal-cancellation', reason: '发现旧目录picker取消抛普通字符串会误进失败框，现已改OperationCanceledException。真实PowerShell AST提取生产throw和外层cancel-if执行，要求exit2且不触达错误框。取消后不存在错误UI，不编造after报错图或9分。', proof: ['scripts/start-dev-hidden.ps1#FolderBrowserDialog', 'tests/launcher.test.ts#actual Node directory picker cancellation'], tests: ['tests/launcher.test.ts'], verificationLog: '.test-data/error-audit/launcher-export-regression.log' });
group('1b91b357929a04', { category: 'normal-setup-question', status: 'retain-normal-behavior', reason: '所有Node候选不可用后询问是否选择离线Node目录，是真实环境补全选择，不是异常原文。保留Yes/No与目录选择动作。', proof: ['scripts/start-dev-hidden.ps1#portable Node choice'] });
group('a65535e64fe7f7', { category: 'configuration-declined', status: 'retain-known-startup-constraint', reason: '已知没有可运行Node时用户选择No，不继续安装/启动。后续通过已知Node配置失败的共用启动提示解释打不开；这与用户取消已打开的目录picker（另项已修）区分。', proof: ['scripts/start-dev-hidden.ps1#portable Node choice', 'scripts/startup-failure.ps1#Get-StartupFailureMessage'] });
group('414f55eda61efb 8cea649874d51f d10c3a1877c1df 86056ac65c2ae5 0d79868b908530 f8e878c3bf8e60 423c8f4c9b62e5 db060ce6a32941 209082b0c29bc0 3706f8f0706417 cf5da37416e326 150f2d4846a478 adeea0081aa1f0 00ba13c0e0e4a8', { category: 'launcher-stage-failure', reason: '保留内部安装/构建/运行环境判定；所有终止错误落入同一顶层catch，先写详细日志，再由Get-StartupFailureMessage按实际stage给简短提示。CLI NoDialogs仍使用明示非UI行为。共用渲染边界不等于每个throw单独复现截图。', scenes: ['native-launcher'], proof: ['scripts/start-dev-hidden.ps1#top-level catch', 'scripts/startup-failure.ps1#Get-StartupFailureMessage', 'scripts/startup-error-dialog.cs#Show'], tests: ['tests/launcher.test.ts'] });
group('9a678349559819 c4c0da79d7526a acd9db849f6436', { category: 'same-native-call-ast-fragments', reason: '三个候选是同一个旧启动失败MessageBox调用的外层/参数片段，当前已改为共用生产WinForms Show；不是三次独立故障。导出失败恢复另列专门候选和场景。', scenes: ['native-launcher'], proof: ['scripts/start-dev-hidden.ps1#WorkbenchStartupFailureDialog.Show', 'scripts/startup-error-dialog.cs#Show'] });
group('7b513416ea26eb 88a761939645f6 3b3db17a703551', { category: 'startup-child-propagation', reason: '停止子进程失败、等待超时及清理后rethrow均是内部原因传播；实际由启动器顶层catch记录原文并经同一个stage提示显示，不直接把英文throw暴露给用户。保留只终止本次启动产生的子进程范围。', scenes: ['native-launcher'], proof: ['scripts/startup-process.ps1#Invoke-StartupProcess', 'scripts/startup-process.ps1#Stop-StartupProcessTree', 'scripts/start-dev-hidden.ps1#top-level catch'], tests: ['tests/launcher.test.ts'] });

assert.equal(definitions.size, candidates.length, 'Every selected candidate needs an explicit resolution');
assert(candidates.every(row => definitions.has(row.id)), 'No selected candidate may be hidden');
const texts = new Map();
for (const file of new Set([...candidates.map(row => row.file), 'src/main/public-failures.ts', 'src/main/startup-failure.ts', 'scripts/startup-failure.ps1', 'scripts/startup-error-dialog.cs'])) texts.set(file, await fs.readFile(path.join(root, file), 'utf8'));
const rows = candidates.map(candidate => {
  const definition = definitions.get(candidate.id);
  const probe = definition.event ? publicErrorState(definition.event, 'session.status') : definition.sample ? publicErrorState({ type: 'notice', message: definition.sample }, 'session.status') : undefined;
  const sourceSafe = definition.sourceGuard ? texts.get(candidate.file).includes(definition.sourceGuard) : true;
  const probeSafe = definition.rawProbe ? !probe.message.includes(definition.rawProbe) && !!probe.failure : definition.category === 'normal-notice' ? probe.message === definition.sample && !probe.failure : definition.category === 'typed-preparation-notice' ? probe.failure?.outcome === 'unknown' && !probe.message.includes('整理失败') : true;
  const scenes = (definition.scenes || []).map(id => { const item = review.scenarios.find(row => row.id === id), image = imageChecks.get(id); return { id, independentlyReviewed: !!item, score: item?.score, pass: item?.pass === true && item.score >= 9 && image?.matchesIndependentReview === true, screenshot: image?.file, sha256: image?.sha256, matchesIndependentReview: image?.matchesIndependentReview === true }; });
  const status = !sourceSafe || !probeSafe ? 'needs-source-fix' : definition.status || (scenes.some(scene => !scene.pass) ? 'source-implemented-ui-review-pending' : definition.category === 'normal-notice' ? scenes.length ? 'normal-content-guard-restored' : 'retain-normal-behavior' : 'implemented-with-shared-evidence');
  return { id: candidate.id, file: candidate.file, baselineLine: candidate.line, baselineSnippet: candidate.snippet, baselineDisposition: candidate.disposition, reviewMethod: 'manual-source-and-caller-followup', category: definition.category, status, conclusion: definition.reason, sourceEvidence: definition.proof, sourceSha256: createHash('sha256').update(texts.get(candidate.file)).digest('hex'), scenes, tests: definition.tests || [], verificationLog: definition.verificationLog, ...(probe ? { replay: { input: definition.event || definition.sample, output: probe, passed: probeSafe } } : {}), note: '同源UI证据只证明所列真实场景及共用显示边界，不声称此AST候选单独做过故障截图。正常行为/内部诊断没有不存在的after错误图。' };
});
const native = texts.get('src/main/startup-failure.ts');
const openLogs = native.slice(native.indexOf('async function openLogs'), native.indexOf('export async function showStartupFailure'));
const openLogsHasOuterCatch = /\btry\s*\{/.test(openLogs) && /\}\s*catch\s*(?:\([^)]*\))?\s*\{/.test(openLogs);
const recoveryLog = await fs.readFile(path.join(root, '.test-data/error-audit/candidate-followup-regression.log'), 'utf8').catch(() => '');
const recoveryTestsPassed = recoveryLog.includes('startup log recovery reports filesystem and shell failures without losing the error window') && /ℹ fail 0\r?\n/.test(recoveryLog);
const nativeUi = review.scenarios.flatMap(row => row.additionalEvidence || []).find(row => row.id === 'native-logs-open-failed');
const nativeUiPath = nativeUi?.evidence ? path.join(root, 'docs/error-audit', nativeUi.evidence) : undefined;
const nativeUiHash = nativeUiPath ? await fs.readFile(nativeUiPath).then(bytes => createHash('sha256').update(bytes).digest('hex'), () => undefined) : undefined;
const nativeUiVerified = !!nativeUi?.pass && nativeUi.score >= 9 && nativeUiHash === nativeUi.afterSha256;
const additionalFindings = [{ id: 'NATIVE-LOGS-OPEN-THROWN', status: openLogsHasOuterCatch && recoveryTestsPassed && nativeUiVerified ? 'verified' : openLogsHasOuterCatch ? 'source-changed-awaiting-recovery-verification' : 'needs-source-fix', source: 'src/main/startup-failure.ts#openLogs', linkedCandidates: ['32295ef962e2eb', 'a473f19a27172d', '7ef4d21ffef0af', 'be92d989e17106', '48a47ab4f496a3'], finding: '原先仅覆盖shell.openPath错误字符串，fs/shell抛错会在主框关闭后逃出；现统一捕获并显示同一个安全二级提示，原始原因尽力记录日志。', evidenceKind: 'actual-production-module-with-controlled-filesystem-and-shell-failures plus independent native GUI evidence', independentlyFaultReproduced: recoveryTestsPassed, verificationLog: '.test-data/error-audit/candidate-followup-regression.log', independentUiEvidence: nativeUi ? { id: nativeUi.id, parentScenario: 'native-user-start', score: nativeUi.score, pass: nativeUiVerified, screenshot: nativeUi.evidence, sha256: nativeUiHash, factualVerification: nativeUi.factualVerification } : undefined }];
const originalReference = { id: 'aaaaaaaa' }, freshReference = { id: 'bbbbbbbb' };
const referenceRoot = path.join(root, '.test-data/error-audit/reference-followup');
const referenceProbe = publicErrorState({ type: 'notice', message: preparationEvents.after.event.message, failure: { ...preparationEvents.after.event.failure, logRef: originalReference } }, 'session.status', { root: referenceRoot, instance: 'isolated-reference-probe', record() { return freshReference; } }, referenceRoot);
additionalFindings.push({ id: 'PUBLIC-TYPED-LOG-REFERENCE', status: referenceProbe.failure?.logRef?.id === originalReference.id && recoveryTestsPassed ? 'source-verified-by-controlled-replay' : 'needs-source-fix', source: 'src/main/public-failures.ts#typed notice and snapshot failure logRef', linkedCandidates: ['757dc5acc61cde', 'fc49905ad77724'], finding: '源头已记录原始技术原因的typed logRef不能被只含安全UI文本的新日志引用覆盖；仍可另记UI事件，但日志入口应优先有效源ref。', evidenceKind: 'actual-publicErrorState-controlled-logger-replay plus real LogService reference resolution test', inputReference: originalReference, extraUiRecordReference: freshReference, outputReference: referenceProbe.failure?.logRef, verificationLog: '.test-data/error-audit/candidate-followup-regression.log', scope: 'notice与snapshot均经with-logger回归，原始Network timeout: connection reset按保留ref可读取' });
const summary = { selectedNeedsIndividualChange: candidates.length, mapped: rows.length, sourceFixOutstanding: rows.filter(row => row.status === 'needs-source-fix').map(row => row.id), uiReviewPending: rows.filter(row => row.status === 'source-implemented-ui-review-pending').map(row => row.id), categories: Object.fromEntries([...new Set(rows.map(row => row.category))].map(category => [category, rows.filter(row => row.category === category).length])), additionalFindingsOutstanding: additionalFindings.filter(row => !['verified', 'source-verified-by-controlled-replay'].includes(row.status)).map(row => row.id) };
const report = { schema: 1, generatedAt: new Date().toISOString(), scope: 'pipeline-review.json中全部需单独修改候选；不是5376个AST候选全部已经实施的证明', sourceReview: 'docs/error-audit/pipeline-review.json', independentUiReview: 'docs/error-audit/readability-review.json', minimumUiScore: 9, noAuthorReadabilityScores: true, summary, entries: rows, additionalFindings };
await fs.writeFile(path.join(root, 'docs/error-audit/candidate-followup.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(summary));
