import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd(), dir = path.join(root, 'docs/error-audit');
const read = async file => JSON.parse(await fs.readFile(path.join(dir, file), 'utf8').catch(() => 'null'));
const source = {};
for (const name of ['user','admin','logs','boundary','native']) { const value = await read(name + '-scenarios.json'); source[name] = Array.isArray(value) ? value : value?.scenarios || []; }
source.user.push(...(await read('notice-scenarios.json') || []));
source.native.push(...(await read('native-export-scenarios.json') || []));
const launcher = await read('launcher-observations.json');
if (launcher?.length) for (const id of [...new Set(launcher.map(r=>r.id))]) { const before=launcher.find(r=>r.id===id&&r.phase==='before'), after=launcher.find(r=>r.id===id&&r.phase==='after'); source.native.push({id,entry:'启动器准备本机运行环境',condition:'运行文件检查异常，仅由隔离合成错误触发',source:after?.source,beforeScreenshot:before?.screenshot,afterScreenshot:after?.screenshot,beforeUI:before?.observed,afterUI:after?.observed,pass:!!before&&!!after,capture:after?.capture,readabilityRound:after?.readabilityRound}); }
const cleanPath = file => file?.replace(/^docs\/error-audit\//, '');
const rowMetadata = new Map([...source.user, ...source.admin, ...source.native].map(row => [row.id, row]));
const logEntries = { browse: '查看故障记录', reference: '从提示定位故障日志', missing: '日志已清理或不在当前范围', pagination: '继续读取故障记录', unavailable: '故障记录读取失败' };
const reasons = {
  'boundary-ssh-auth': '原提示是 SSH 底层英文，未说明是哪一处账号验证失败。现在明确为中央节点账号或密码被拒绝，并保留登录修改入口。',
  'boundary-central-refused': '原提示直接展示内部地址和系统错误码。现在说明中央节点暂时无法连接，指向服务器地址、端口和网络检查。',
  'boundary-central-dns': '原提示是域名解析技术异常。现在保留连接失败事实，提醒核对服务器地址，具体技术原因进入日志。',
  'boundary-central-timeout': '握手超时不能证明账号错误或登录失败。现在说明连接结果尚未确认，通过本次日志排查，不诱导重复提交其他操作。',
  'boundary-reset': '连接中断时不能把未知结果当作确定失败。现在说明登录验证结果待确认，并提供对应连接日志。',
  'boundary-password': '原界面依赖技术标记识别改密要求。现在先按稳定错误码选择改密流程，再展示服务器要求设置新密码的用户说明。',
  'boundary-unknown': '未分类异常不应展示堆栈，也不能猜测权限、登录或升级问题。现在说明原因尚未确认，并保留本次日志定位。',
  'boundary-prep-count': '成果数量校验不通过不等于网络错误。现在保留实际数量约束，用户可以重新精简整理。',
  'boundary-prep-category': '类别校验失败曾被统称网络或登录问题。现在保留用户未选中类别的实际原因，避免无关的网络恢复操作。',
  'boundary-prep-timeout': 'CLI 初始化发生在整理开始前。现在明确本次整理尚未开始，不再把超时断言成网络中断或登录过期。',
  'native-user-start': '原启动弹窗把原始路径和读取异常直接展示。现在说明本机会话资料未能读取，要求保留目录，并提供日志目录入口。',
  'native-admin-start': '原启动弹窗未区分本机资料与远端问题。现在明确本机资料读取失败，保留数据和日志排查入口。',
  'native-close-save': '窗口已关闭与记录保存未完成是两个不同结果。现在同时说明这两个事实，提醒保留原数据目录，避免误以为记录已保存。',
  'native-launcher': '启动准备异常曾直接显示 PowerShell 异常。现在说明本机启动准备未完成和可执行的日志排查方式，技术原文留在启动日志。',
  'logs-user-source-path': 'Windows 短路径与 Chromium 的规范路径不一致，导致合法来源被拒绝。现在使用同一规范路径加载和校验，保留对其他页面来源的拒绝。',
};
const reasonFor = row => row.changeReason || reasons[row.id] || (row.id.startsWith('logs-') ? (row.id.endsWith('browse') ? '原界面仅支持日志状态、导出与清理，不能阅读故障。现在增加受账号和中央节点范围限制的故障列表及详情。' : row.id.endsWith('reference') ? '原界面不能定位报错对应的日志。现在按主进程签发的引用打开故障详情，避免查到其他操作的记录。' : row.id.endsWith('missing') ? '日志可能已清理或不在授权范围，不能显示假详情。现在如实说明未找到，并允许查看当前范围的其他记录。' : row.id.endsWith('pagination') ? '原界面没有可阅读的故障列表。现在提供有界分页，继续读取时保留范围和稳定游标。' : '读取失败不能伪装成暂无记录。现在保留查询失败和旧列表状态，提供重新读取操作。') : '');
const scenes = [];
for (const name of ['user','admin','native']) for (const row of source[name]) scenes.push({
  id: row.id, domain: name, role: row.role || (name === 'admin' && !row.id.startsWith('team-') ? '管理员' : name === 'native' && row.id.includes('admin') ? '管理员' : '用户'), entry: row.entry, condition: row.condition, source: row.source || row.file, changeReason: reasonFor(row), codeLocation: row.codeLocation,
  before: { screenshot: cleanPath(row.beforeScreenshot || row.before?.screenshot), text: row.beforeUI || row.before?.ui || row.originalUI || '' },
  after: { screenshot: cleanPath(row.afterScreenshot || row.after?.screenshot), text: row.afterUI || row.after?.ui || row.currentUI || '' },
  pass: (row.pass ?? row.after?.passed ?? false) && (row.before?.passed ?? true), assertions: row.after?.assertions || row.afterAssertions || row.validation || [], capture: row.capture || 'production-react-components with isolated failure fixture'
});
for (const name of ['logs','boundary']) for (const id of [...new Set(source[name].map(r => r.id))]) {
  const before = source[name].find(r => r.id === id && r.phase === 'before'), after = source[name].find(r => r.id === id && r.phase === 'after');
  scenes.push({ id, domain: name, role: after?.edition === 'admin' ? '管理员' : '用户', entry: after?.entry || before?.entry || (id === 'logs-user-source-path' ? '用户端启动：路径别名校验' : logEntries[id.split('-').at(-1)]) || id, condition: after?.condition || before?.condition || after?.observed || '日志浏览、定位或缺失处理', source: name === 'logs' ? (id === 'logs-user-source-path' ? 'src/main/renderer-entry.ts → src/main/index.ts' : 'src/renderer/logs-panel.tsx → logs.query / logs.get → src/core/log-storage.cjs') : after?.source, changeReason: reasonFor({ ...after, id }), before: { screenshot: cleanPath(before?.screenshot), text: before?.ui || before?.observed || '' }, after: { screenshot: cleanPath(after?.screenshot), text: after?.ui || after?.observed || '' }, pass: !!before && !!after && (after?.pass ?? true) && after?.viewportVerified !== false && after?.entryPathVerified !== false, assertions: after?.assertions || after?.observed || '', capture: after?.fixture || 'production UI with isolated fixture' });
}
const inventory = await read('inventory.json'), reviews = [];
for (const name of ['user','admin','pipeline']) { const review = await read(name + '-review.json'); for (const row of review?.entries || []) reviews.push({ ...row, reviewer: name, candidateId: row.candidateId || row.id }); }
const reviewed = new Map(); for(const row of reviews){const list=reviewed.get(row.candidateId)||[];list.push(row);reviewed.set(row.candidateId,list);}
const candidates = inventory.entries.map(row => {const list=reviewed.get(row.legacyCandidateId||row.id)||[];const specific=list.find(r=>r.representativeScenarios?.length||r.evidence?.scenarioIds?.length), review=specific||list.at(-1)||null;return { ...row, scanDisposition: row.disposition, disposition: review?.disposition || row.disposition, review, reviews:list };});
const candidateFollowup = await read('candidate-followup.json');
for (const candidate of candidates) candidate.followup = candidateFollowup?.entries?.find(row => row.id === (candidate.legacyCandidateId || candidate.id)) || null;
const previous = await read('readability-baseline/report-data.json');
const initial = await read('initial-readability-review.json');
for (const scene of scenes) {
  const row = rowMetadata.get(scene.id), previousScene = previous?.scenes?.find(value => value.id === scene.id);
  scene.initialReview = initial?.scenarios?.find(value => value.id === scene.id) || null;
  scene.originalChangeReason = scene.changeReason;
  scene.changeReason = scene.initialReview?.issues?.length ? scene.initialReview.issues.join('；') : scene.initialReview ? '原提示已经清晰，本轮核对操作和结果边界，保留可用提示。' : row?.changeReason || scene.changeReason;
  scene.originalBaseline = scene.before;
  scene.beforeVersion = row?.beforeVersion || (previousScene ? 'readability-round2-pre-rewrite' : 'original-baseline');
  if (previousScene) scene.before = { screenshot: 'readability-baseline/' + previousScene.after.screenshot, text: previousScene.after.text };
  if (row?.conditionChanged) {
    scene.conditionChanged = true; scene.oldCondition = row.oldCondition; scene.newCondition = row.newCondition;
    const corrected = cleanPath(row.correctedReadabilityBefore || row.readabilityBaselineScreenshot);
    if (corrected) {
      const observation = JSON.parse(await fs.readFile(path.join(dir,corrected.replace(/\.png$/,'.json')),'utf8'));
      scene.before = { screenshot: corrected, text: row.correctedBeforeUI || observation.result?.ui || observation.ui || observation.observed || '' };
      scene.beforeCorrectionEvidence = corrected.replace(/\.png$/,'.json');
    }
  }
  scene.baselineNote = row?.baselineNote || (!previousScene && row?.beforeVersion === 'readability-round2-pre-rewrite' ? '本场景为本轮新增补查；原 UI 从第二轮修订前冻结源码重新运行取得，不冒充最初 Git 基线截图。' : null);
  for (const phase of ['before','after','originalBaseline']) { const picture = scene[phase].screenshot; scene[phase].exists = !!picture && await fs.stat(path.join(dir, picture)).then(s => s.isFile() && s.size > 0, () => false); if (scene[phase].exists) scene[phase].sha256 = createHash('sha256').update(await fs.readFile(path.join(dir,picture))).digest('hex'); }
  scene.pass = scene.pass && scene.before.exists && scene.after.exists;
  if (scene.domain === 'native' && row?.readabilityRound !== 2) {
    scene.capturePending = 'Windows 锁屏，尚未取得本轮原生窗口截图；当前所附仍是上一轮画面。';
    scene.pass = false;
  }
}
const blind = await read('readability-review.json');
for (const scene of scenes) {
  scene.review = blind?.scenarios?.find(r => r.id === scene.id) || null;
  scene.notApplicable = scene.review?.errorReadability === 'not_applicable' && scene.review.score === null;
  scene.supplements = [];
  for (const extra of scene.review?.additionalEvidence || []) {
    const screenshot = extra.evidence.startsWith('screenshots/') ? extra.evidence : 'screenshots/' + extra.evidence;
    const bytes = await fs.readFile(path.join(dir,screenshot)).catch(()=>null);
    scene.supplements.push({ ...extra, screenshot, exists: !!bytes, sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null });
  }
  scene.reviewCurrent = !scene.capturePending && scene.review?.pass === true && (scene.notApplicable || scene.review.score >= 9) && scene.review.afterSha256 === scene.after.sha256 && scene.supplements.every(extra => extra.pass === true && extra.score >= 9 && extra.afterSha256 === extra.sha256);
}
const verification = await read('verification.json');
const readabilityVerification = await read('readability-verification.json');
const scores = scenes.filter(scene => !scene.notApplicable && Number.isFinite(scene.review?.score)).map(scene => scene.review.score);
const result = { baseline: inventory.baseline, version: inventory.baselineVersion, readabilityRound: 2, rubric: blind?.rubric, subjectiveEvaluation: true, generatedAt: new Date().toISOString(), scenes, candidates, verification, summary: { scenes: scenes.length, pairedAndVerified: scenes.filter(s=>s.pass).length, reviewedCandidates: candidates.filter(c=>c.review).length, candidates: candidates.length, pendingCandidates: candidates.filter(c=>!c.review).length, visualReviewed: scenes.filter(s=>s.review).length, visualPassed: scenes.filter(s=>s.reviewCurrent).length, visualFailed: scenes.filter(s=>!s.reviewCurrent).length, scored: scores.length, scoreAtLeastNine: scores.filter(score=>score>=9).length, notApplicable: scenes.filter(scene=>scene.notApplicable).length, minimumScore: scores.length ? Math.min(...scores) : null, initialScored: initial?.scenarios?.filter(scene=>Number.isFinite(scene.score)).length || 0, initialAtLeastNine: initial?.scenarios?.filter(scene=>scene.score>=9).length || 0 } };
result.coveragePending = blind?.coveragePending || [];
result.candidateFollowup = candidateFollowup;
result.summary.pendingFollowup = candidateFollowup ? candidateFollowup.summary.sourceFixOutstanding.length + candidateFollowup.summary.uiReviewPending.length + candidateFollowup.summary.additionalFindingsOutstanding.length : 1;
result.summary.releaseReady = result.summary.visualFailed === 0 && result.summary.pendingCandidates === 0 && result.summary.pendingFollowup === 0 && result.summary.pairedAndVerified === result.summary.scenes && result.coveragePending.length === 0;
result.readabilityVerification = readabilityVerification;
await fs.writeFile(path.join(dir, 'report-data.json'), JSON.stringify(result,null,2));
await fs.writeFile(path.join(dir, 'review-input.json'), JSON.stringify(scenes.map(s=>({id:s.id,entry:s.entry,before:path.resolve(dir,s.before.screenshot||''),after:path.resolve(dir,s.after.screenshot||'')})),null,2));
import { renderErrorAuditReport } from './error-audit-report-page.mjs';
await fs.writeFile(path.join(dir, '报错整改报告.html'), renderErrorAuditReport(result));
console.log(JSON.stringify(result.summary));
