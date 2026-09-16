// Opt-in integration run: four business rounds through the personal Codex CLI.
// An explicit recovery may add a read-only model turn; actual calls are recorded.
// No competition-platform submissions or GitHub pushes; algorithm revisions use local Git.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { sourceDigest, completedRound, roundAttempts, canRecoverReportedRound } from './pilot-evidence';
import { resolveProvider } from '../src/core/providers';
import { Workbench } from '../src/core/workbench';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberConfig } from '../src/admin/member-config';
import type { AgentSession, Transfer } from '../src/shared/types';

const exec = promisify(execFile), args = process.argv.slice(2);
function arg(name: string) { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error('Missing ' + name); return path.resolve(args[i + 1]); }
const resume = args.includes('--resume');
const recoverReported = args.includes('--recover-reported-round');
if (recoverReported && !resume) throw new Error('--recover-reported-round requires --resume and operator-verified existing reports.');
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined;
if (model && !/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('Invalid model');
const input = arg('--input'), output = arg('--output'), python = arg('--python');
if (!args.includes('--run-real-codex')) throw new Error('Explicit --run-real-codex is required; this makes four real model requests.');
const shared = path.join(output, 'shared'), gitRoot = path.join(output, 'team.git');
const admin = new LocalAdminConnection(() => {}), workbenches: Workbench[] = [];
const records: any[] = [], sourceHashes: Record<string, string> = {};
const hash = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function git(cwd: string, ...args: string[]) { return (await exec('git', args, { cwd, windowsHide: true, timeout: 60000 })).stdout.trim(); }
async function waitTransfer(t: Transfer) { const deadline = Date.now() + 60000; while (t.status === 'queued' || t.status === 'running') { if (Date.now() > deadline) throw new Error('transfer timeout'); await new Promise(r => setTimeout(r, 100)); } if (t.status !== 'done') throw new Error(t.error); }
async function shareNotes(wb: Workbench, session: AgentSession, file: string) {
  const before = new Set(wb.store.transfers.map(t => t.id)); await wb.uploadFiles(session.binding!, session.binding!.project.uploadPath, [file]);
  const t = wb.store.transfers.find(t => !before.has(t.id))!; await waitTransfer(t); return t;
}
async function reference(wb: Workbench, session: AgentSession, projectId: string, remotePath: string) {
  const b = session.binding!, sourcePath = `${b.username}@${b.host}:${b.port}${remotePath}`;
  const existing = session.sources.find(s => s.sourcePath === sourcePath);
  if (existing) { if (await hash(existing.localPath) !== existing.sha256) throw new Error('Frozen source changed: ' + existing.localPath); return existing; }
  return wb.attachRemote(session.id, projectId, remotePath);
}
async function runTurn(wb: Workbench, session: AgentSession, round: number, task: string, sources: string[] = []) {
  const existing = records.find(r => r.user === session.binding!.username && r.round === round); if (existing) return existing;
  const report = path.join(session.cwd, 'reports', `${session.binding!.username}-round${round}.md`);
  const events = await fs.readFile(path.join(wb.store.sessionDir(session.id), 'events.jsonl'), 'utf8').then(s => s.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), () => []);
  const alreadyCompleted = resume && !!(await fs.stat(report).catch(() => false)) && completedRound(session.messages, events, round);
  const recovery = resume && recoverReported && !alreadyCompleted && !!(await fs.stat(report).catch(() => false)) && canRecoverReportedRound(session.messages, round);
  const startedAt = events.find(e => e.event?.direction === 'user' && e.event.text?.includes(`这是你的第 ${round}/2 轮`))?.at || new Date().toISOString(), before = session.messages.length;
  const envInfo = `你是离线协同验证中的参赛用户 ${wb.remote.profile!.username}，这是你的第 ${round}/2 轮。比赛为 NVFP4→HiF4。仅在当前工作目录中开发，不联网、不访问原项目、不提交比赛平台、不操作 Git（测试驱动负责提交）。只读 inputs/ 下的原始任务书摘录、接口模板、自检器和小样本；不得修改它们。候选 solution.py 必须实现全部六个 API，不可在候选代码内执行文件 I/O。测试与报告可以读写文件。使用 Python：${python}，torch 已安装；把 CPU 线程数限为 4，单个本地实验控制在 90 秒内。官方标准量化器未提供，报告绝对 MSE 或明确的本地对照，不得称为官方得分。校准集选参，测试集仅用于比较。该副本从官方接口模板起步，是工作台联调候选，不冒充原项目最优算法。最终必须写 reports/${session.binding!.username}-round${round}.md 和 .json，包含改动、实际执行命令与结果、来源、限制、下轮建议；更新本会话交接文件。不要只给方案，请实际写代码并验证。\n\n`;
  console.log(`START ${session.binding!.username} round ${round}`);
  if (!alreadyCompleted) await wb.send(session.id, recovery ? `你是 ${session.binding!.username}，这是你的第 ${round}/2 轮。这是同一业务轮在连接中断后的收尾，不是第三轮算法迭代。当前代码、reports/${session.binding!.username}-round${round}.md/.json 及本轮实验日志已经生成。仅在当前目录只读核对这两份报告存在且内容自洽，然后给一句简短的完成说明；不重新运行实验、不修改代码/报告/交接、不联网、不操作 Git、不扩大任务。若报告不完整或存在矛盾，明确指出。` : envInfo + task, sources);
  const deadline = Date.now() + 28 * 60 * 1000; let last = 0;
  while (!alreadyCompleted && (!['idle', 'error'].includes(session.status) || session.messages.length === before)) {
    if (Date.now() > deadline) { await wb.stop(session.id); throw new Error('model turn timed out'); }
    if (Date.now() - last > 20000) {
      last = Date.now(); console.log(JSON.stringify({ user: session.binding!.username, round, status: session.status, messages: session.messages.length, approvals: session.approvals.map(a => ({ id: a.id, method: a.method, details: a.details.slice(0, 600) })) }));
      await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify({ user: session.binding!.username, round, status: session.status, nativeId: session.nativeId, approvals: session.approvals, lastMessages: session.messages.slice(-3) }, null, 2));
    }
    // Approvals are intentionally reviewed by the supervising operator, never accepted wholesale.
    for (const approval of [...session.approvals]) {
      const file = path.join(output, `approval-${session.id}-${approval.id}.json`);
      try { const answer = JSON.parse(await fs.readFile(file, 'utf8')); wb.answer(session.id, approval.id, answer.option, answer.answers); await fs.rename(file, file + '.used'); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (session.status === 'error') throw new Error(session.error || 'Codex error');
  const completionDeadline = Date.now() + 5000;
  while (!completedRound(session.messages, await fs.readFile(path.join(wb.store.sessionDir(session.id), 'events.jsonl'), 'utf8').then(s => s.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))), round)) {
    if (Date.now() > completionDeadline) throw new Error('Native turn did not complete successfully; reports alone are insufficient.');
    await new Promise(r => setTimeout(r, 100));
  }
  const json = report.replace(/\.md$/, '.json'); JSON.parse(await fs.readFile(json, 'utf8')); await fs.access(report);
  for (const name of Object.keys(sourceHashes)) {
    const actual = await fs.readFile(path.join(session.cwd, 'inputs', name)), expected = await fs.readFile(path.join(input, name));
    if (sourceDigest(actual, name) !== sourceDigest(expected, name)) throw new Error('Model changed source: ' + name);
  }
  await git(session.cwd, 'add', 'solution.py', 'reports');
  for (const dir of ['tests', 'scripts', 'evaluate.py', 'baseline.py']) if (await fs.stat(path.join(session.cwd, dir)).catch(() => false)) await git(session.cwd, 'add', dir);
  await git(session.cwd, 'commit', '-m', `${session.binding!.username}: competition iteration ${round}`);
  const revision = await git(session.cwd, 'rev-parse', 'HEAD'); await git(session.cwd, 'push', 'origin', 'HEAD:refs/heads/' + session.binding!.username);
  const notes = await shareNotes(wb, session, report), history = await wb.archive(session.id); await waitTransfer(history);
  const record = { user: session.binding!.username, round, startedAt, completedAt: new Date().toISOString(), sessionId: session.id, nativeId: session.nativeId, nativePath: session.nativePath, revision, localGitRepository: gitRoot, report, reportJson: json, notesPath: notes.target, historyPath: history.target, handoff: session.handoffPath, modelCalls: roundAttempts(session.messages, round), recoveredAfterDisconnect: recovery };
  records.push(record); await fs.writeFile(path.join(output, 'rounds.json'), JSON.stringify(records, null, 2)); console.log('DONE', record.user, round, revision); return record;
}
async function main() {
  if (!resume) { await fs.mkdir(output); await fs.mkdir(shared); }
  else { try { records.push(...JSON.parse(await fs.readFile(path.join(output, 'rounds.json'), 'utf8'))); } catch (e: any) { if (e.code !== 'ENOENT') throw e; } }
  const seed = path.join(output, 'seed'); if (!resume) { await fs.mkdir(seed); await fs.cp(input, path.join(seed, 'inputs'), { recursive: true });
  await fs.copyFile(path.join(input, 'solution-template.py'), path.join(seed, 'solution.py'));
  await fs.writeFile(path.join(seed, '.gitignore'), 'inputs/mini_sample/*.pt\n.workbench/\n__pycache__/\n*.pyc\n');
  await git(seed, 'init', '-b', 'main'); await git(seed, 'config', 'user.name', 'Competition Pilot'); await git(seed, 'config', 'user.email', 'pilot@local.invalid');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'seed: official interface and immutable competition references');
  await git(output, 'clone', '--bare', seed, gitRoot); }
  for (const name of ['task.txt', 'solution-template.py', 'self_check.py', 'environment.md', 'mini_sample/manifest.json', 'mini_sample/linear.pt', 'mini_sample/attn.pt']) sourceHashes[name] = await hash(path.join(input, name));
  await admin.connect({ mode: 'local', localRoot: shared, host: 'local', port: 22, username: 'admin', fingerprint: '', root: '/srv/teamspace' }, 'pilot-admin-2026', '', async () => false);
  if (!resume) { await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: 'competition' });
  for (const username of ['alice', 'bob']) await admin.operation({ op: 'user_create', username, name: username === 'alice' ? '用户 A · 算法实现' : '用户 B · 验证评估', password: 'pilot-member-2026', groups: ['local_competition'], contentAdminGroups: username === 'alice' ? ['local_competition'] : [] });
  await fs.mkdir(path.join(output, 'admin-data')); } await fs.writeFile(path.join(output, 'admin-data', 'connection.json'), JSON.stringify(admin.snapshot.profile, null, 2));
  const clients: Record<string, { wb: Workbench; session: AgentSession }> = {}; let projectId = '';
  for (const username of ['alice', 'bob']) {
    const cwd = path.join(output, username); if (!resume) { await git(output, 'clone', gitRoot, cwd); await git(cwd, 'checkout', '-b', username);
    await git(cwd, 'config', 'user.name', username); await git(cwd, 'config', 'user.email', username + '@local.invalid');
    await fs.cp(path.join(input, 'mini_sample'), path.join(cwd, 'inputs', 'mini_sample'), { recursive: true });
    }
    const wb = new Workbench(path.join(output, username + '-data'), () => {}, message => console.log(username, message)); workbenches.push(wb); await wb.init();
    if (model) { const exe = await resolveProvider('codex'); const launcher = path.join(output, 'codex-' + username + '.ps1'); const quote = (v: string) => "'" + v.replace(/'/g, "''") + "'"; await fs.writeFile(launcher, '\uFEFF& ' + quote(exe) + ' -c ' + quote('model="' + model + '"') + ' -c ' + quote('model_reasoning_effort="high"') + ' @args\n', 'utf8'); wb.store.settings.providerPaths.codex = launcher; await wb.store.save(); }
    const config = resume ? wb.store.settings.connections[0] : memberConfig(admin.snapshot.profile!, admin.snapshot.state!, username, 'local_competition'); await wb.configureWorkspace(config, 'pilot-member-2026', cwd, async () => false);
    await fs.writeFile(path.join(output, username + '-connection.json'), JSON.stringify(config, null, 2));
    if (username === 'alice') projectId = resume ? wb.store.sessions[0].binding!.project.id : (await wb.createProject('华为算法大赛 NVFP4 到 HiF4')).id;
    await wb.remote.loadManifest(); await wb.requireAuth('codex', cwd);
    const session = resume ? wb.store.sessions[0] : await wb.createSession('codex', cwd, projectId); session.title = (username === 'alice' ? '用户 A 算法实现' : '用户 B 验证评估') + ' · 两轮比赛迭代'; clients[username] = { wb, session }; await wb.store.save();
  }
  await fs.writeFile(path.join(output, 'source-manifest.json'), JSON.stringify({ input, sourceHashes, credentials: '本地测试账号：admin / pilot-admin-2026；alice、bob / pilot-member-2026。CLI 使用当前 Windows 用户已有的个人登录。', git: gitRoot, officialSubmission: false }, null, 2));
  const { alice: a, bob: b } = clients;
  const a1 = await runTurn(a.wb, a.session, 1, '实现可运行的朴素 HiF4 基线，保留六个接口签名。可以先用 max-abs 选择合法 E6M2 scale，并以固定二三级 scale、round/clamp mant 构造合法参数；不要使用原项目成熟方案。建立 tests/test_solution.py，用 unittest 验证全零、正负、不同 shape、六接口以及状态合法性。使用 inputs/self_check.py 的校验器并至少执行一次完整公开 mini_sample 自检。无需优化官方分数，先得到真实可用基线。');
  await git(b.session.cwd, 'fetch', 'origin'); await git(b.session.cwd, 'merge', '--ff-only', 'origin/alice');
  const aNotes = await reference(b.wb, b.session, projectId, a1.notesPath);
  const b1 = await runTurn(b.wb, b.session, 1, '已通过本地 Git 合入用户 A 第一轮代码，所选共享报告是 A 的交接。你负责验证评估：阅读实际 solution.py、官方 self_check.py 和 inputs/mini_sample/manifest.json。实现 evaluate.py，支持 --solution PATH --output PATH，使用全部公开测试用例计算 Linear 与 Attention 的 FP32 输出 MSE/NMSE 和分阶段本机耗时。数据必须用 weights_only=True 读取；GQA 按 q_heads/kv_heads 扩展，明确假设 causal 与 scaled softmax，不把该假设当官方判题器已验证语义。不要改 solution.py，不对 test 调参。增加至少一个手算/小矩阵验证的 evaluator 单元测试，运行全部自检、单元测试和一次基线评估，报告实际结果及 A 第二轮一个低成本改进建议。', [aNotes.id]);
  await git(a.session.cwd, 'fetch', 'origin'); await git(a.session.cwd, 'merge', '--ff-only', 'origin/bob');
  const bNotes = await reference(a.wb, a.session, projectId, b1.notesPath);
  const a2 = await runTurn(a.wb, a.session, 2, '已合入用户 B 的评估工具，所选共享报告是 B 的第一轮反馈。保留 baseline.py 为第一轮 solution.py 原样副本，然后实现一个小而明确的改进：在每个 block 的合法层级 scale 上选择二三级尺度，以张量重构误差选择且保留基线候选；若更适合则使用有限相邻合法 E6M2 候选，必须保持所有参数合法及输入不变，不在 test 上拟合阈值。用相同 evaluator 分别测 baseline.py 和 solution.py；先写合成用例确认候选选择包含原点和全零稳定，跑 unittest 与官方自检。报告实际输出误差、耗时及回退样本；张量误差下降不能保证最终输出下降，诚实记录。', [bNotes.id]);
  await git(b.session.cwd, 'fetch', 'origin'); await git(b.session.cwd, 'merge', '--ff-only', 'origin/alice');
  const a2Notes = await reference(b.wb, b.session, projectId, a2.notesPath);
  await runTurn(b.wb, b.session, 2, '已合入 A 第二轮算法与对照。你完成独立复核：禁止调算法或按测试数据选参。重新执行完整 self_check、所有单元测试以及同环境 baseline.py/solution.py 两次评估，检查报告可复现、逐例 MSE、state 合法与最大深度、输入是否被修改；补充至少一项关键边界测试，必要时修复 evaluator 本身明确的正确性错误并重测两个方案。在 reports/bob-round2.md/.json 给出推荐采用/保留对照/尚不能下结论及理由，明确这里没有官方 Score 和目标鲲鹏服务器耗时。更新交接，完成第 2 轮后停止，不扩展更多轮。', [a2Notes.id]);
  if (a.session.nativeId === b.session.nativeId || records.length !== 4) throw new Error('session/round isolation failure');
  await assertPrivateHistory(b.wb, projectId, a1.historyPath);
  await admin.operation({ op: 'user_enabled', username: 'bob', enabled: false });
  let denied = false; try { await b.wb.remote.list(b.wb.remote.binding(projectId), b.session.binding!.project.remoteRoot); } catch { denied = true; }
  if (!denied) throw new Error('disabled user could still read'); await admin.operation({ op: 'user_enabled', username: 'bob', enabled: true });
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, rounds: records, sourceHashes, independentSessions: true, localPermissionStub: true, actualCodex: true, model: model || 'personal-default', accountScope: 'one existing personal Codex login; two simulated team users', permissionRevocationVerified: true, officialScore: null, officialSubmission: false }, null, 2));
  console.log('FOUR ROUND COMPETITION PILOT PASSED', output);
}
async function assertPrivateHistory(wb: Workbench, projectId: string, target: string) {
  try { await wb.remote.preview(wb.remote.binding(projectId), target); } catch (e: any) { if (/模拟权限拒绝/.test(e.message)) return; throw e; } throw new Error('private history visible to teammate');
}
main().catch(async error => { await fs.writeFile(path.join(output, 'failure.txt'), error.stack || error.message).catch(() => {}); console.error(error.message); process.exitCode = 1; }).finally(async () => { for (const wb of workbenches) await wb.close(); admin.disconnect(); });
