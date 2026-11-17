// Assemble this audit's captured results; never turn a failed run into a pass.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = process.cwd(), local = path.join(root, '.test-data/error-audit'), output = path.join(root, 'docs/error-audit');
const read = name => fs.readFile(path.join(local, name), 'utf8');
function totals(text) {
  const count = name => Number([...text.matchAll(new RegExp('^ℹ ' + name + ' ([0-9.]+)$', 'gm'))].at(-1)?.[1]);
  const result = { tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), canceled: count('cancelled'), durationMs: count('duration_ms') };
  assert(Number.isFinite(result.tests), 'A complete Node test summary is required'); return result;
}
const userFiles = ['materials-rendering','personal-relay','preparation-context','preparation-lifecycle','preparation-oct08','project-directory','project-journal','session-context','session-experience','session-status','session-result-references','team-questions','workflow-states','error-audit-user','error-pipeline-boundary'];
const definitions = [
  ['错误分类、日志、权限与恢复', 'final-targeted.log', ['user-failure','error-pipeline-boundary','error-audit-user','error-audit-admin','log-query','logging','renderer-entry','provider-connection','egress-monitor','central-connection','team-cache','project-connection','transfer-recovery','project-purge']],
  ['用户端与三家 CLI 协议回归', 'user-final-regression.log', userFiles],
  ['传输成功事实、恢复与任务提示', 'admin-final-regression.log', ['submission','error-audit-admin','workflow-states']],
  ['两端 IPC 与窗口生命周期', 'pipeline-final-regression.log', ['account-windows','local-project-windows','admin-reverse-ipc','admin-windows-ipc','codex-mcp']],
  ['SFTP 与多组权限边界', 'final-sftp.log', ['workgroups','sftp']],
  ['真实 PowerShell 启动提示', 'final-launcher.log', ['launcher']],
];
const runs = [];
for (const [name, log, files] of definitions) {
  const text = (await read(log)).replaceAll('\r',''), result = totals(text);
  assert.equal(result.failed, 0, name + ' still has failures'); assert.equal(result.canceled, 0);
  runs.push({ name, files: files.map(file => 'tests/' + file + '.test.ts'), evidence: '.test-data/error-audit/' + log, sha256: createHash('sha256').update(await fs.readFile(path.join(local,log))).digest('hex'), ...result });
}
const fullText = (await read('full-regression.log')).replaceAll('\r',''), baselineText = (await read('baseline-regression.log')).replaceAll('\r','');
const failures = text => [...text.slice(text.indexOf('✖ failing tests:')).matchAll(/^test at ([^\n]+)\n✖ (.*?) \([0-9.]+ms\)$/gm)].map(match => ({ file: match[1].replaceAll('\\','/').replace(/:\d+:\d+$/, ''), name: match[2] }));
const baselineFailures = failures(baselineText), firstFailures = failures(fullText);
assert.equal(baselineFailures.length, 3); assert.equal(firstFailures.length, totals(fullText).failed);
const unresolved = [];
for (const failure of firstFailures) {
  if (baselineFailures.some(item => item.name === failure.name)) { unresolved.push({ ...failure, summary: failure.name.includes('model-first') ? '原生子会话先改模型再改权限：恢复请求中的模型字段未满足原用例预期' : failure.name.includes('permission-first') ? '原生子会话先改权限再改模型：恢复请求中的模型字段未满足原用例预期' : '团队成果更新版本后沿用了旧引用快照标识，未满足原用例要求的新版本独立快照', conclusion: '固定基线和本次分支均未通过；本次报错整改没有把此用例改为通过，也未在本次定位根因。', evidence: '.test-data/error-audit/baseline-regression.log' }); continue; }
  const run = runs.find(item => item.files.includes(failure.file));
  assert(run, 'No final file-level revalidation for: ' + failure.file);
  failure.followUp = { run: run.name, status: '对应完整测试文件定向复验通过；文案断言按新语义更新，协议、权限和防重复提交的断言保留' };
}
assert.equal(unresolved.length, 3);
const python = await read('server-tests.log'), server = /Ran (\d+) tests in ([\d.]+)s[\s\S]*?OK(?: \(skipped=(\d+)\))?/.exec(python);
assert(server, 'Server tests did not finish successfully');
const scope = JSON.parse(await fs.readFile(path.join(output,'log-scope-verification.json'),'utf8'));
const report = JSON.parse(await fs.readFile(path.join(output,'report-smoke-verification.json'),'utf8'));
const actions = JSON.parse(await read('user-action-verification.json'));
const build = JSON.parse(await read('build-verification.json'));
assert.equal(scope.passed,true); assert.equal(report.passed,true); assert.equal(actions.passed,true); assert.equal(build.passed,true);
const result = {
  baseline: 'd4d51bb30d23f03a883867054a893c547e558f9e', baselineVersion: '2.3.46', generatedAt: new Date().toISOString(),
  conclusion: '本次修改的错误处理、界面与恢复动作通过专项回归。整体基础回归仍存在3个可在固定基线复现的未通过用例，不声称整个项目的全量测试全部通过。',
  boundaries: ['全部故障使用隔离数据、临时目录、协议桩或原生测试窗口；不读取真实用户会话或凭据，不连接真实中央节点，不调用付费模型。', 'Codex、Cursor、Claude Code 的会话、授权与恢复走协议夹具；真实账号及真实网关端到端测试未执行。', 'Windows 环境不能替代 Linux 内核 ACL 实测；相关跳过项保留。', '不同定向测试批次存在重叠，不将各批次数相加作为独立用例总量。'],
  firstFullRegression: { ...totals(fullText), command: 'WORKBENCH_BACKGROUND_TESTS=1 node --require ./scripts/background-guard.cjs --require ./scripts/test-css.cjs --import tsx --test --test-concurrency=1 --test-force-exit --test-timeout=90000 <与 scripts/test-background.mjs 相同的后台测试文件集合>', note: '这是整改收尾期间的首轮全量结果，部分测试在最终修正前已执行；force-exit只用于本次记录完整结果，未修改产品测试入口。', sha256: createHash('sha256').update(await fs.readFile(path.join(local,'full-regression.log'))).digest('hex'), failures: firstFailures },
  knownBaselineFailures: unresolved,
  followUpRuns: runs,
  serverTests: { tests: Number(server[1]), passed: Number(server[1])-Number(server[3]||0), skipped: Number(server[3]||0), durationSeconds: Number(server[2]), command: 'npm run test:server' },
  actualElectronLogScope: scope,
  explicitRetryActionVerification: actions,
  typecheckAndBuild: build,
  offlineReport: report,
};
await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({ initialTests: result.firstFullRegression.tests, initialFailures: firstFailures.length, revalidatedFailures: firstFailures.length-unresolved.length, unresolvedBaseline: unresolved.length, successfulTargetedRuns:runs.length }));
