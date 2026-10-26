// Exercise production React renderers with an isolated IPC fixture. No account,
// shared server, real conversation or model request is used.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { makeFixture, installFixture } from './handbook-ui-fixture.mjs';

const root = process.cwd(), output = path.join(root, 'artifacts', 'desktop-interactions');
const temp = path.join(root, '.test-data', 'desktop-interactions-' + Date.now());
await fs.mkdir(output, { recursive: true });
for (const [edition, entry] of Object.entries({ user: 'src/renderer/main.tsx', admin: 'src/admin/renderer.tsx' })) {
  const dir = path.join(temp, edition); await fs.mkdir(dir, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: [entry], outfile: path.join(dir, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', loader: { '.css': 'css', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, logLevel: 'silent' });
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script></html>');
}
const fixture = makeFixture('desktop-interactions', 10, 1, { actor: 'Alice', screen: '工作会话', rows: [] });
fixture.snapshot.selectedProjectId = fixture.project.id;
fixture.snapshot.settings.contentUpdates = []; fixture.updates = [];
fixture.session.model = 'gpt-fixture'; fixture.session.title = '比较量化方案的精度与速度';
fixture.session.messages = [
  { id: 'u', role: 'user', text: '请核对精度达标的方案，再比较速度。保留实验依据。', createdAt: fixture.at },
  { id: 'c', role: 'assistant', phase: 'commentary', text: '先确认两组实验使用相同的数据和设备。', createdAt: fixture.at },
  { id: 't', role: 'tool', text: '读取 experiment/results.json\n{"baseline": 0.98, "candidate": 0.99}', createdAt: fixture.at },
  { id: 'a', role: 'assistant', phase: 'final_answer', text: '两种方案都满足当前精度要求，可以进入同条件的速度比较。\n\n**下一步**\n\n- 固定设备和输入规模，再测量执行时间。\n- 保留误差分布，避免平均值掩盖边界样本。\n\n| 方案 | 精度 | 速度 |\n| --- | --- | --- |\n| 基线 | 已达标 | 待复测 |\n| 候选方案 | 已达标 | 待复测 |\n\n```python\ncompare(baseline, candidate, dataset="validation")\n```\n\n当前记录见 `experiments/quantization/validation/results.json`。', createdAt: fixture.at },
];
fixture.snapshot.sessions = [fixture.session];
fixture.snapshot.inputs[fixture.session.id] = { text: '', sourceIds: [], answers: {} };
fixture.snapshot.activeTurns = {};

function installControls() {
  const original = window.workbench.call, listeners = [];
  window.workbench.subscribe = listener => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); };
  const emit = () => listeners.forEach(listener => listener({ type: 'state' }));
  window.__presentation = { emit, actions: [], pending: [], finish(ok = true) { const request = this.pending.shift(); if (!request) throw new Error('No pending send'); request.finish(ok); } };
  window.workbench.call = async (action, payload = {}) => {
    const name = action.replace(/^personal:/, ''), data = window.__handbook.data;
    const session = data.snapshot.sessions.find(item => item.id === payload.id) || data.session;
    window.__presentation.actions.push({ name, payload });
    if (name === 'provider.catalog') return { models: [{ id: 'gpt-fixture', name: 'GPT · 测试模型', reasoningEfforts: [{ id: 'high', description: '' }, { id: 'medium', description: '' }], defaultReasoningEffort: 'high' }, { id: 'gpt-other', name: 'GPT · 另一模型' }], quota: { windows: [{ name: '5 小时', usedPercent: 23 }], detail: '' }, checkedAt: data.at };
    if (name === 'session.capabilities') return { skills: [{ id: 'skill:test', kind: 'skill', name: '研究复核', invocation: '$review', enabled: true, description: '检查实验条件与证据', source: '个人' }], plugins: [], provider: 'codex', checkedAt: data.at };
    if (name === 'session.modes') return { modes: [{ id: 'default', name: 'Agent', description: '执行任务' }, { id: 'plan', name: 'Plan', description: '先制定计划' }] };
    if (name === 'copy') return;
    if (name === 'session.rename') { session.title = payload.title; emit(); return; }
    if (name === 'session.send' || name === 'session.enqueue') return new Promise((resolve, reject) => {
      window.__presentation.pending.push({ finish(ok) {
        if (!ok) { reject(new Error('测试网络不可用')); return; }
        if (name === 'session.enqueue') { session.inputQueue ||= { paused: false, items: [] }; session.inputQueue.items.push({ id: 'q' + Date.now(), state: 'queued', input: { ...payload, answers: {} } }); }
        else session.messages.push({ id: 'sent' + Date.now(), role: 'user', text: payload.text, createdAt: data.at });
        emit(); resolve(true);
      } });
    });
    if (name === 'session.queue.move') { const items = session.inputQueue.items, item = items.find(i => i.id === payload.itemId); session.inputQueue.items = items.filter(i => i !== item); session.inputQueue.items.splice(payload.beforeId ? session.inputQueue.items.findIndex(i => i.id === payload.beforeId) : session.inputQueue.items.length, 0, item); emit(); return; }
    if (name === 'session.queue.pause' || name === 'session.queue.resume') { session.inputQueue.paused = name.endsWith('pause'); emit(); return; }
    if (name === 'session.queue.edit') { session.inputQueue.items.find(i => i.id === payload.itemId).input.text = payload.text; emit(); return; }
    if (name === 'session.model') { session.model = payload.model; emit(); return; }
    if (name === 'session.mode') { session.mode = payload.mode; emit(); return; }
    if (name === 'session.permissions') { session.permissionMode = payload.mode; emit(); return; }
    if (name === 'session.reasoningEffort') { session.reasoningEffort = payload.effort; emit(); return; }
    if (name === 'session.answer') { session.approvals = []; session.status = 'idle'; emit(); return; }
    if (name === 'session.completion.read' || name === 'session.read') return;
    if (name === 'provider.auth') return { ...data.snapshot.auth[payload.provider], cwd: payload.cwd, networkRoute: payload.networkRoute };
    if (name === 'session.queue.remove') { session.inputQueue.items = session.inputQueue.items.filter(item => item.id !== payload.itemId); emit(); return; }
    if (name === 'project.directory.impact') return { sessions: [] };
    return original(action, payload);
  };
}
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' }); };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(installFixture, fixture); await page.addInitScript(installControls);
  await page.context().setOffline(true);
  await page.goto(pathToFileURL(path.join(temp, 'user/index.html')).href);
  const row = page.locator(`.session-row[data-session-id="${fixture.session.id}"]`);
  await row.click();
  const input = page.getByLabel('任务输入', { exact: true });
  await expect(input).toBeVisible(); await expect(page.locator('.rail')).toBeVisible();
  await expect(page.locator('.turn-activity-group')).not.toHaveAttribute('open', '');

  // Context menus use the clicked item, support keyboard dismissal, and rename in place.
  await row.click({ button: 'right' });
  const sessionMenu = page.getByRole('menu', { name: '会话操作', exact: true });
  await expect(sessionMenu.getByRole('menuitem', { name: '重命名', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(sessionMenu.getByRole('menuitem', { name: '移动到项目或分组' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(row).toBeFocused();
  await row.click({ button: 'right' }); await sessionMenu.getByRole('menuitem', { name: '重命名' }).click();
  await page.getByLabel('会话名称', { exact: true }).fill('原地修改名称');
  await page.getByLabel('会话名称', { exact: true }).press('Enter');
  await expect(row).toContainText('原地修改名称');
  await expect(input).toBeVisible();
  await page.evaluate(() => {
    const d = window.__handbook.data, second = { ...structuredClone(d.snapshot.sessions[0]), id: 'other', title: '另一条会话' };
    d.snapshot.sessions.push(second); window.__presentation.emit();
  });
  const other = page.locator('.session-row[data-session-id="other"]');
  await other.click({ button: 'right' });
  await expect(row).toHaveClass(/selected/); await expect(other).not.toHaveClass(/selected/);
  await sessionMenu.getByRole('menuitem', { name: '重命名' }).click();
  await page.getByLabel('会话名称', { exact: true }).fill('另一条会话改名'); await page.getByLabel('会话名称', { exact: true }).press('Enter');
  await expect(other).toContainText('另一条会话改名'); await expect(row).toContainText('原地修改名称');
  await expect(row).toHaveClass(/selected/);
  await row.click({ button: 'right' }); await shot(page, 'session-context'); await page.keyboard.press('Escape');

  // Message actions copy the visible original; quotation only edits the composer.
  const reply = page.getByRole('article', { name: 'Codex的消息', exact: true }).filter({ hasText: '两种方案都满足' });
  await reply.locator('p').first().click({ button: 'right' });
  const messageMenu = page.getByRole('menu', { name: '消息操作', exact: true });
  await messageMenu.getByRole('menuitem', { name: '复制消息', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__presentation.actions.findLast(a => a.name === 'copy').payload), fixture.session.messages.at(-1).text);
  await reply.locator('p').first().click({ button: 'right' });
  await messageMenu.getByRole('menuitem', { name: '添加到会话' }).click();
  assert((await input.inputValue()).includes('两种方案都满足'));
  assert.equal(await page.evaluate(() => window.__presentation.actions.filter(a => a.name === 'session.send').length), 0);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.conversation-message.assistant p')].find(el => el.textContent.includes('两种方案都满足'));
    const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 600, clientY: 300 }));
  });
  await messageMenu.getByRole('menuitem', { name: '复制所选文本' }).click();
  assert.equal(await page.evaluate(() => window.__presentation.actions.findLast(a => a.name === 'copy').payload), '两种方案都满足当前精度要求，可以进入同条件的速度比较。');
  await page.evaluate(() => getSelection().removeAllRanges());
  await input.fill(''); await input.press('ArrowUp');
  await expect(input).toHaveValue(fixture.session.messages[0].text); await input.fill('');

  // Immediately show the outgoing message while IPC is still pending, without erasing the next draft.
  await input.fill('发送后立即显示'); await input.press('Enter');
  await expect(page.getByLabel('消息正在提交', { exact: true })).toContainText('发送后立即显示');
  await expect(input).toHaveValue(''); await input.fill('下一条草稿');
  await shot(page, 'sending');
  await page.evaluate(() => window.__presentation.finish());
  await expect(page.getByLabel('消息正在提交', { exact: true })).toHaveCount(0);
  await expect(input).toHaveValue('下一条草稿');
  await expect(page.locator('.conversation-message.user').filter({ hasText: '发送后立即显示' })).toHaveCount(1);
  await input.fill('失败时恢复原稿'); await input.press('Enter');
  await expect(input).toHaveValue(''); await page.evaluate(() => window.__presentation.finish(false));
  await expect(input).toHaveValue('失败时恢复原稿'); await expect(page.locator('.send-failure')).toContainText('测试网络不可用');
  await input.press('Enter'); await expect(input).toHaveValue(''); await input.fill('失败期间的新草稿');
  await page.evaluate(() => window.__presentation.finish(false));
  await expect(page.locator('.send-failure')).toBeVisible(); await expect(input).toHaveValue('失败期间的新草稿');
  await page.getByRole('button', { name: '恢复到输入框', exact: true }).click();
  await expect(input).toHaveValue('失败期间的新草稿');
  await input.fill(''); await page.getByRole('button', { name: '恢复到输入框', exact: true }).click();
  await expect(input).toHaveValue('失败时恢复原稿'); await input.fill('');

  // Long queues stay single-line; view full text, reorder, edit and remove without sending.
  await page.evaluate(() => {
    const d = window.__handbook.data, s = d.snapshot.sessions[0]; s.status = 'running';
    s.inputQueue = { paused: false, items: [1, 2, 3].map(n => ({ id: 'q' + n, state: 'queued', input: { text: '第 ' + n + ' 条待发送消息\n' + '长内容不换行，超出显示省略号。'.repeat(12), sourceIds: [], answers: {} } })) };
    d.snapshot.activeTurns[s.id] = 'active'; window.__presentation.emit();
  });
  await expect(page.locator('.queue-row')).toHaveCount(3);
  for (const queued of await page.locator('.queue-row').all()) {
    assert((await queued.boundingBox()).height <= 32);
    assert.equal(await queued.locator('.queue-text').evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap');
  }
  await page.getByLabel('查看第 1 条待发送消息').click();
  await expect(page.getByRole('dialog', { name: '待发送消息全文' })).toContainText('长内容不换行');
  await page.keyboard.press('Tab'); await expect(page.getByLabel('关闭消息预览')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: '待发送消息全文' })).toHaveCount(0);
  await expect(page.getByLabel('查看第 1 条待发送消息')).toBeFocused();
  await page.locator('[data-queue-id="q3"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '提前一条' }).click();
  await expect(page.locator('.queue-row').nth(1)).toHaveAttribute('data-queue-id', 'q3');
  await page.locator('[data-queue-id="q2"]').dragTo(page.locator('[data-queue-id="q1"]'));
  await expect(page.locator('.queue-row').first()).toHaveAttribute('data-queue-id', 'q2');
  await page.getByLabel('编辑第 1 条待发送消息').click();
  await page.getByLabel('编辑待发送消息').fill('编辑后的完整内容'); await page.getByLabel('保存待发送消息').click();
  await expect(page.locator('.queue-row').first()).toContainText('编辑后的完整内容');
  await page.getByLabel('移除第 1 条待发送消息').click(); await expect(page.locator('.queue-row')).toHaveCount(2);
  await input.fill('正在排队的新消息'); await input.press('Enter');
  await expect(page.getByLabel('正在加入待发送队列')).toBeVisible();
  await expect(page.getByLabel('消息正在提交', { exact: true })).toHaveCount(0);
  await expect(input).toHaveValue(''); await page.evaluate(() => window.__presentation.finish());
  await expect(page.locator('.queue-row')).toHaveCount(3); await expect(page.getByLabel('正在加入待发送队列')).toHaveCount(0);
  await shot(page, 'queue');

  // Streaming follows only at the bottom; reading earlier turns keeps the current position.
  await page.evaluate(() => {
    const d = window.__handbook.data, s = d.snapshot.sessions[0]; s.inputQueue.items = [];
    s.messages.push({ id: 'long', role: 'assistant', text: Array.from({ length: 60 }, (_, i) => '第 ' + i + ' 段：用于验证阅读历史时保持位置。').join('\n\n'), createdAt: d.at }); window.__presentation.emit();
  });
  const messages = page.locator('.messages');
  await expect(reply).toBeAttached();
  await expect.poll(() => messages.evaluate(el => el.scrollHeight)).toBeGreaterThan(2500);
  await messages.evaluate(el => { el.scrollTop = 160; el.dispatchEvent(new Event('scroll')); });
  await expect(page.getByRole('button', { name: '↓ 回到最新消息', exact: true })).toBeAttached();
  const before = await messages.evaluate(el => el.scrollTop);
  await page.evaluate(() => { const s = window.__handbook.data.snapshot.sessions[0]; s.messages.at(-1).text += '\n\n新增流式内容'; window.__presentation.emit(); });
  await expect(page.locator('.messages')).toContainText('新增流式内容');
  assert(Math.abs(await messages.evaluate(el => el.scrollTop) - before) < 4, 'new output must not pull a reader away from history');
  // The return control must stay visible even when its DOM position is at the bottom.
  await page.getByRole('button', { name: '↓ 回到最新消息', exact: true }).click();
  await expect.poll(() => messages.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(64);

  await page.evaluate(() => {
    const d = window.__handbook.data, s = d.snapshot.sessions[0]; s.status = 'approval'; s.messages.splice(4); d.snapshot.activeTurns = {};
    s.approvals = [{ id: 'question', method: 'item/tool/requestUserInput', title: '确认下一步', details: '', questions: [{ id: 'next', text: '接下来优先验证哪一项？', options: [{ id: 'a', label: '同条件测量速度（推荐）' }, { id: 'b', label: '继续检查边界样本' }] }], options: [{ id: 'answer', label: '提交回答', kind: 'allow' }, { id: 'skip', label: '跳过', kind: 'deny' }] }]; window.__presentation.emit();
  });
  const card = page.locator('.question-request');
  await expect(card.getByRole('button', { name: '提交回答' })).toBeDisabled();
  await card.getByRole('radio', { name: '同条件测量速度（推荐）' }).check();
  await expect(card.getByRole('button', { name: '提交回答' })).toBeEnabled();
  await shot(page, 'question');
  await card.getByRole('textbox').fill('先补充实验背景');
  await expect(card.getByRole('radio', { name: '同条件测量速度（推荐）' })).not.toBeChecked();
  await card.getByRole('button', { name: '提交回答' }).click();
  assert.deepEqual(await page.evaluate(() => window.__presentation.actions.findLast(a => a.name === 'session.answer').payload.answers), { next: '先补充实验背景' });
  for (const width of [1100, 860]) {
    await page.setViewportSize({ width, height: 800 }); await row.click({ button: 'right' });
    const box = await sessionMenu.boundingBox(); assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= width);
    await page.keyboard.press('Escape');
    assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth));
  }
  await page.getByRole('button', { name: 'agent管理', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'agent管理', exact: true });
  await settings.locator('footer').getByRole('button').focus(); await page.keyboard.press('Tab');
  await expect(settings.getByRole('button', { name: '关闭窗口', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(settings).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'agent管理', exact: true })).toBeFocused();
  assert.deepEqual(errors, []);
  console.log('Desktop interactions passed: session/message context actions, rename, copy/quote, empty-input history, immediate send, acceptance deduplication, failure/draft protection, queue preview/reorder/drag/edit/remove/pending state, history scroll, structured questions, 3 viewport sizes.');
  console.log('Screenshots: ' + output);
} finally { await browser.close(); }
