// Record this pass separately; keep the first audit's full/baseline evidence intact.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = process.cwd(), local = path.join(root,'.test-data/error-audit'), output = path.join(root,'docs/error-audit');
const definitions = [
  ['用户端与三家 CLI 状态恢复', 'readability-user-complete-tests.log', 'node scripts/test-background.mjs tests/error-audit-user.test.ts tests/session-input-autosave.test.ts tests/workspace-relocation.test.ts tests/provider-auth.test.ts tests/provider-auth-recovery.test.ts tests/provider-connection.test.ts tests/project-directory.test.ts tests/session-files.test.ts tests/new-session-network.test.ts tests/preparation-context.test.ts tests/error-pipeline-boundary.test.ts'],
  ['管理、任务、传输与本机同步异常', 'admin-readability-final-regression.log', 'node --import tsx --test --test-concurrency=1 tests/error-audit-admin.test.ts tests/submission.test.ts tests/workflow-states.test.ts tests/assignments.test.ts'],
  ['结构化错误、IPC、日志与来源隔离', 'readability-root-final-tests.log', 'node scripts/test-background.mjs tests/user-failure.test.ts tests/error-pipeline-boundary.test.ts tests/log-query.test.ts tests/logging.test.ts tests/central-connection.test.ts tests/provider-connection.test.ts tests/renderer-entry.test.ts tests/startup-failure.test.ts'],
  ['两端窗口与 IPC', 'readability-ipc-complete-tests.log', 'node scripts/test-background.mjs tests/account-windows.test.ts tests/local-project-windows.test.ts tests/admin-reverse-ipc.test.ts tests/admin-windows-ipc.test.ts tests/codex-mcp.test.ts'],
  ['后台保存、账号隔离与未知状态徽标', 'readability-save-and-badges-tests.log', 'node scripts/test-background.mjs tests/background-record-save.test.ts tests/preparation-review.test.ts'],
  ['真实保存与引导协议完整文件回归', 'background-record-save-regression.log', 'node --import tsx --test --test-concurrency=1 tests/background-record-save.test.ts tests/session-steering.test.ts tests/session-delta.test.ts tests/workflow-states.test.ts'],
  ['新增日志标题回归', 'readability-final-log-title-tests.log', 'node scripts/test-background.mjs tests/log-query.test.ts'],
  ['Windows 启动、取消与导出恢复', 'launcher-export-regression.log', 'node --import tsx --test --test-concurrency=1 tests/launcher.test.ts'],
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const runs=[];
for(const [name,log,command] of definitions){
  const bytes=await fs.readFile(path.join(local,log)), text=bytes.toString('utf8').replaceAll('\r','');
  const count=key=>Number([...text.matchAll(new RegExp('^ℹ '+key+' ([0-9.]+)$','gm'))].at(-1)?.[1]);
  const tests=count('tests'),failed=count('fail');assert(Number.isFinite(tests),'No completed test summary: '+log);assert.equal(failed,0,log);assert.equal(count('cancelled'),0,log);
  runs.push({name,command,evidence:'.test-data/error-audit/'+log,sha256:digest(bytes),tests,passed:count('pass'),failed,skipped:count('skipped'),durationMs:count('duration_ms')});
}
const build=await fs.readFile(path.join(local,'readability-final-build.log')), typecheck=await fs.readFile(path.join(local,'readability-final-typecheck.log')), logs=await fs.readFile(path.join(local,'readability-final-logs-smoke.log'));
assert.match(build.toString(),/Build verified in .*running application files were not changed/);
assert.match(typecheck.toString(),/tsc --noEmit/);assert.doesNotMatch(typecheck.toString(),/error TS\d+/);
assert.match(logs.toString(),/Logging desktop smoke passed: user\/admin entry, renderer errors, exports, budgets, cleanup/);
const report=JSON.parse(await fs.readFile(path.join(output,'report-smoke-verification.json'),'utf8'));assert.equal(report.passed,true);
const old=JSON.parse(await fs.readFile(path.join(output,'verification.json'),'utf8'));
// This related full-file run intentionally retains the unchanged baseline failure.
// Verify its identity rather than suppressing a failing exit or calling the run green.
const relatedLog='readability-shared-status-regression.log';
const relatedBytes=await fs.readFile(path.join(local,relatedLog)), relatedText=relatedBytes.toString('utf8').replaceAll('\r','');
const relatedCount=key=>Number([...relatedText.matchAll(new RegExp('^ℹ '+key+' ([0-9.]+)$','gm'))].at(-1)?.[1]);
assert.equal(relatedCount('tests'),21);assert.equal(relatedCount('pass'),20);assert.equal(relatedCount('fail'),1);assert.equal(relatedCount('cancelled'),0);
const failingSection=relatedText.split('✖ failing tests:')[1];assert(failingSection,'Missing related regression failure details');
const relatedFailureNames=[...failingSection.matchAll(/^✖ (.+?) \([\d.]+ms\)$/gm)].map(match=>match[1]);
assert.equal(relatedFailureNames.length,1);
const baselineMatch=old.knownBaselineFailures.find(row=>row.file==='tests/collaboration-lifecycle.test.ts'&&row.name===relatedFailureNames[0]);
assert(baselineMatch,'Related regression has a failure that was not reproduced in the fixed baseline');
assert.match(failingSection,/new versions must not be collapsed with legacy snapshots/);
assert.match(relatedText,/✔ concurrent revisions have one winner; lost upload acknowledgement retries without duplicate content/);
const relatedRegression={name:'共享状态与成果生命周期完整文件回归',command:'node scripts/test-background.mjs tests/collaboration-lifecycle.test.ts tests/materials-rendering.test.ts',evidence:'.test-data/error-audit/'+relatedLog,sha256:digest(relatedBytes),tests:relatedCount('tests'),passed:relatedCount('pass'),failed:relatedCount('fail'),skipped:relatedCount('skipped'),durationMs:relatedCount('duration_ms'),allPassed:false,newFailures:0,knownBaselineFailures:[baselineMatch],conclusion:'20 项通过；1 项旧版本快照标识用例仍未通过，与固定基线相同。丢失上传回执后的核对、显式重试及不重复提交验证通过；没有把遗留失败改为跳过或通过。'};
const current=JSON.parse(await fs.readFile(path.join(output,'report-data.json'),'utf8'));
const result={generatedAt:new Date().toISOString(),round:2,targetedTestsPassed:true,fullProjectRegressionPassed:false,releaseReady:current.summary.releaseReady,runs,relatedRegression,note:'8 组专项回归通过。额外完整文件回归仍有 1 个固定基线遗留失败；全库遗留 3 项未冒充通过。各批次有重叠，不把通过数相加成独立测试数量。测试结果与可读性逐图门禁分开。',
 typecheck:{passed:true,command:'npm run typecheck',exitCode:0,evidence:'.test-data/error-audit/readability-final-typecheck.log',sha256:digest(typecheck),basis:'实际执行返回 exit_code=0，并核对日志无 TypeScript 错误'},
 build:{passed:true,command:'npm run build:check',evidence:'.test-data/error-audit/readability-final-build.log',sha256:digest(build),runtimeFilesUnchanged:true},
 logsDesktopSmoke:{passed:true,evidence:'.test-data/error-audit/readability-final-logs-smoke.log',sha256:digest(logs),checks:['两端实际日志入口','主进程日志定位及渲染异常','导出与脱敏','存储预算','清理','取消不显示成功']},
 actualLogScope:JSON.parse(await fs.readFile(path.join(output,'readability-log-scope-verification.json'),'utf8')),
 offlineReport:report,knownBaselineFailures:old.knownBaselineFailures,readability:current.summary,
 boundaries:['全部注入数据隔离；没有读取真实用户会话或登录凭据，没有真实中央节点写入，也没有付费模型调用。','原生窗口受 Windows 锁屏影响而未重拍时，维持未放行；不以自动化测试替代实际截图。','可读性分数来自独立 agent，不代表真实用户研究。',...old.boundaries]};
await fs.writeFile(path.join(output,'readability-verification.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({targetedTestsPassed:true,runs:runs.map(({name,tests,passed})=>({name,tests,passed})),relatedRegression:{tests:relatedRegression.tests,passed:relatedRegression.passed,failed:relatedRegression.failed,newFailures:0},releaseReady:result.releaseReady}));
