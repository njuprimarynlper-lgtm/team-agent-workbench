import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { conclusionSimilarity, rankConclusions } from '../src/core/conclusion-matcher';
import { Workbench } from '../src/core/workbench';
import { sessionContext } from '../src/core/session-context';
import { attachedConclusion, conclusionTitle } from '../src/shared/conclusion-context';
import type { ProjectConclusion } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Shared fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

const conclusion = (id: string, title: string, content: string): ProjectConclusion => ({ id, projectId: offlineProjectId, title, content, sources: [], version: 1, updatedAt: '2026-09-20T00:00:00.000Z' });
const until = async (fn: () => boolean) => { const end = Date.now() + 20000; while (!fn()) { if (Date.now() > end) throw new Error('conclusion merge timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };

test('deleting a conclusion differs from reversible history and preserves existing session references', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-conclusion-delete-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const item = await wb.createConclusion(offlineProjectId, '待删除的本地结论', '保留会话引用的依据');
    const session = await wb.createSession('codex', root, offlineProjectId), source = await wb.attachConclusion(session.id, item.id);
    await wb.archiveConclusion(item.id, true);
    assert.equal(wb.conclusions(offlineProjectId).length, 0); assert.equal(wb.conclusions(offlineProjectId, true).length, 1);
    await wb.archiveConclusion(item.id, false); assert.equal(wb.conclusions(offlineProjectId).length, 1);
    const version = item.version; await wb.saveConclusion(item.id, item.title, '已有新证据');
    await assert.rejects(wb.deleteConclusion(item.id, version), /已更新/);
    assert.equal(wb.conclusions(offlineProjectId).length, 1);
    await wb.deleteConclusion(item.id, item.version);
    assert.equal(wb.conclusions(offlineProjectId, true).length, 0);
    await assert.rejects(wb.archiveConclusion(item.id, false), /不存在/);
    const archived = await wb.createConclusion(offlineProjectId, '旧历史结论', '也允许删除历史记录'); await wb.archiveConclusion(archived.id, true);
    await wb.deleteConclusion(archived.id, archived.version); assert.equal(wb.conclusions(offlineProjectId, true).length, 0);
    assert.match(await fs.readFile(source.localPath, 'utf8'), /保留会话引用的依据/);
    await wb.close();
    const restored = new Workbench(wb.store.root, () => {}, () => {}); await restored.store.init();
    assert.equal(restored.conclusions(offlineProjectId, true).length, 0);
    assert.equal(restored.session(session.id).sources[0].id, source.id); await restored.close();
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('bulk conclusion deletion validates the entire batch and preserves unselected history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-conclusion-bulk-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const a = await wb.createConclusion(offlineProjectId, '第一条', '第一份依据');
    const b = await wb.createConclusion(offlineProjectId, '第二条', '第二份依据');
    const keep = await wb.createConclusion(offlineProjectId, '未选择的历史', '继续保留'); await wb.archiveConclusion(keep.id, true);
    const selections = [a, b].map(item => ({ id: item.id, version: item.version }));
    await wb.saveConclusion(b.id, b.title, '修改后的依据');
    await assert.rejects(wb.deleteConclusions(selections), /已更新/);
    assert.equal(wb.conclusions(offlineProjectId, true).length, 3, 'a stale last item must not partially delete the batch');
    await assert.rejects(wb.deleteConclusions([{ id: a.id, version: a.version }, { id: 'missing', version: 1 }]), /不存在/);
    assert.equal(wb.conclusions(offlineProjectId, true).length, 3);
    await wb.deleteConclusions([a, b].map(item => ({ id: item.id, version: item.version })));
    assert.deepEqual(wb.conclusions(offlineProjectId, true).map(item => item.id), [keep.id]);
    await wb.close();
    const restored = new Workbench(wb.store.root, () => {}, () => {}); await restored.store.init();
    assert.deepEqual(restored.conclusions(offlineProjectId, true).map(item => item.id), [keep.id]); await restored.close();
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('conclusion aliases persist without revising content or frozen session references', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-conclusion-alias-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const item = await wb.createConclusion(offlineProjectId, '【结论与发现】内部编号 abc-314', '扫描件样本覆盖仍然不足。');
    item.automatic = true;
    const before = structuredClone(item);
    await wb.saveConclusionAlias(item.id, '  OCR验收约束  ');
    assert.equal(conclusionTitle(item), 'OCR验收约束');
    assert.deepEqual({ ...item, titleAlias: undefined }, { ...before, titleAlias: undefined });
    assert.equal(wb.matchConclusions(offlineProjectId, 'OCR验收约束')[0].conclusion.id, item.id);
    assert.equal(conclusionSimilarity([item], 'OCR验收约束', '独立的内容'), undefined, 'aliases must not cause unrelated knowledge to be grouped');
    const session = await wb.createSession('codex', root, offlineProjectId);
    const source = await wb.attachConclusion(session.id, item.id), frozen = await fs.readFile(source.localPath, 'utf8');
    assert.match(source.name, /^OCR验收约束/);
    await wb.saveConclusionAlias(item.id, '扫描件验收');
    assert.equal((await wb.attachConclusion(session.id, item.id)).id, source.id);
    assert.match(source.name, /^OCR验收约束/); assert.equal(await fs.readFile(source.localPath, 'utf8'), frozen);
    await assert.rejects(wb.saveConclusionAlias(item.id, 'x'.repeat(201)), /200/);
    await wb.close();
    const restored = new Workbench(wb.store.root, () => {}, () => {}); await restored.store.init();
    assert.equal(conclusionTitle(restored.conclusions(offlineProjectId)[0]), '扫描件验收');
    await restored.saveConclusionAlias(item.id, '  ');
    assert.equal(conclusionTitle(restored.conclusions(offlineProjectId)[0]), before.title);
    assert.equal(restored.conclusions(offlineProjectId)[0].version, before.version);
    await restored.close();
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('BM25 and fixed rules rank relevant local conclusions without AI', () => {
  const items = [
    conclusion('a', 'Windows 启动器终端隐藏', '启动 Electron 时使用 hidden 窗口，避免出现命令行窗口。'),
    conclusion('b', 'OCR 数据覆盖风险', '训练样本没有覆盖低清晰度扫描件，需要补充回归数据。'),
    conclusion('c', 'SFTP 权限规则', '项目目录使用 Linux 用户组控制读取和写入权限。'),
  ];
  const matches = rankConclusions(items, 'Windows 的 Electron 启动器为什么还会出现终端？');
  assert.equal(matches[0].conclusion.id, 'a');
  assert(matches[0].reasons.some(reason => reason.includes('标题命中') || reason.includes('精确词')));
  assert(!matches.some(match => match.conclusion.id === 'b'));
});

test('local conclusions persist, can be edited and freeze an exact session source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-conclusions-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const first = await wb.createConclusion(offlineProjectId, '部署入口', 'Windows 启动时不显示额外终端。');
    assert.equal(wb.matchConclusions(offlineProjectId, 'Windows 启动终端')[0].conclusion.id, first.id);
    await wb.saveConclusion(first.id, '部署入口', 'Windows 启动时使用隐藏窗口，不显示额外终端。');
    assert.equal(first.version, 2);
    const session = await wb.createSession('codex', root, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
    const source = await wb.attachConclusion(session.id, first.id);
    assert.match(source.name, /本地结论 v2/); assert.match(await fs.readFile(source.localPath, 'utf8'), /隐藏窗口/);
    await wb.archiveConclusion(first.id, true); assert.equal(wb.matchConclusions(offlineProjectId, 'Windows 启动终端').length, 0);
    await wb.close();
    const restored = new Workbench(path.join(root, 'data'), () => {}, () => {}); await restored.store.init();
    assert.equal(restored.conclusions(offlineProjectId, true)[0].version, 2); await restored.close();
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('personal conclusion processing follows directions and archives sources only after confirmation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-conclusion-merge-')), fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success' }), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = fixture.launcher;
    const session = await wb.createSession('codex', root, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
    const first = await wb.createConclusion(offlineProjectId, '部署约束', '启动程序时隐藏终端窗口。'), second = await wb.createConclusion(offlineProjectId, '启动验证', 'Windows 启动器已通过回归测试。');
    const draft = await wb.prepareConclusionMerge(offlineProjectId, session.id, [first.id, second.id], '保留 Windows 约束，不要补造测试结果。');
    await until(() => draft.generation === 'ready'); assert.match(draft.body, /预处理结果/); assert.equal(draft.conclusionMergeInstruction, '保留 Windows 约束，不要补造测试结果。');
    assert.equal(wb.conclusions(offlineProjectId).length, 2, 'AI draft does not alter the source conclusions');
    await wb.saveContentMerge(draft.id, '统一部署结论', draft.body); const merged = await wb.commitConclusionMerge(draft.id);
    assert.equal(wb.conclusions(offlineProjectId).length, 1); assert.equal(merged.title, '统一部署结论'); assert(wb.conclusions(offlineProjectId, true).filter(item => item.archived).length === 2);
    const single = await wb.createConclusion(offlineProjectId, '独立约束', '窗口启动应隐藏终端，人工验证范围未知。');
    const instruction = '只改写为新人的检查清单，不需要合并。';
    const processed = await wb.prepareConclusionMerge(offlineProjectId, session.id, [single.id], instruction);
    await until(() => processed.generation === 'ready');
    const calls = (await fs.readFile(path.join(root, 'cli/rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const prompt = calls.filter(call => call.method === 'turn/start').at(-1).params.input[0].text;
    assert(prompt.includes(instruction)); assert(prompt.includes('任务类型：conclusionProcessing'));
    assert(!prompt.includes('这不是拼接或摘要任务')); assert(!prompt.includes('请去重并形成统一结论'));
    assert.equal(single.archived, undefined, 'a single-source preview also leaves originals intact');
    await wb.saveContentMerge(processed.id, '新人检查清单', '人工修订后的检查步骤');
    const saved = await wb.commitConclusionMerge(processed.id);
    assert.equal(saved.title, '新人检查清单'); assert.equal(saved.content, '人工修订后的检查步骤');
    assert.equal(single.archived, true); assert.equal(saved.sources[0].id, single.id);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('conclusion selection is permanent per session, concurrent-safe and automatically sent once per native context', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-conclusion-attach-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const item = await wb.createConclusion(offlineProjectId, '验证边界', '只完成静态编译，性能未知。');
    const first = await wb.createSession('codex', root, offlineProjectId), second = await wb.createSession('codex', root, offlineProjectId);
    const [a, duplicate] = await Promise.all([wb.attachConclusion(first.id, item.id), wb.attachConclusion(first.id, item.id)]);
    assert.equal(a.id, duplicate.id); assert.equal(first.sources.length, 1); assert.equal(second.sources.length, 0);
    const initial = sessionContext(first, '继续', []); assert.equal(initial.sources[0].id, a.id);
    first.nativeId = 'native-context';
    first.messages.push({ id: 'accepted', role: 'user', text: initial.text, createdAt: new Date().toISOString(), context: { ...initial.context, nativeId: first.nativeId, accepted: true } });
    assert.equal(sessionContext(first, '再次继续', []).text, '再次继续');
    await wb.saveConclusion(item.id, '新版验证边界', '新增内容不能悄悄改写旧会话快照。');
    assert.equal((await wb.attachConclusion(first.id, item.id)).id, a.id);
    assert.match(await fs.readFile(a.localPath, 'utf8'), /性能未知/);
    const b = await wb.attachConclusion(second.id, item.id); assert.notEqual(b.id, a.id); assert.match(b.name, /v2/);
    second.closedAt = new Date().toISOString(); await assert.rejects(wb.attachConclusion(second.id, item.id), /未关闭/);
    first.nativeId = 'new-native-context'; assert.equal(sessionContext(first, '重新建立上下文', []).sources[0].id, a.id);
    await wb.close();
    const restored = new Workbench(wb.store.root, () => {}, () => {}); await restored.store.init();
    assert.equal(attachedConclusion(restored.session(first.id), item.id)?.id, a.id);
    await restored.close();
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});
