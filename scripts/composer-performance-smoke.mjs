// Production renderer, synthetic history, mocked APIs: no personal data or model calls.
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { chromium, expect } from '@playwright/test';
import { makeFixture, installFixture } from './handbook-ui-fixture.mjs';

const counters = {
  'main.tsx': ['function AccountWorkspace({ state, refresh }: { state: Snapshot; refresh: () => Promise<void> }) {', 'workspace'],
  'markdown.tsx': ['export function Markdown({ text, openFile, sessionId, conversation }: { text: string } & MarkdownContext) {', 'markdown'],
  'session-transcript.tsx': ['export const SessionTranscript = React.memo(function SessionTranscript({ session, renderMessage }: { session: AgentSession; renderMessage: (message: Message) => React.ReactNode; active?: boolean }) {', 'transcript'],
};
const bundle = await build({
  entryPoints: ['src/renderer/main.tsx'], outdir: '/diagnostic', bundle: true, write: false,
  splitting: true, format: 'esm', minify: true, platform: 'browser', target: 'chrome130',
  loader: { '.css': 'css', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
  plugins: [{ name: 'render-count-only', setup(api) {
    api.onLoad({ filter: /(?:main|markdown|session-transcript)\.tsx$/ }, async args => {
      const target = counters[path.basename(args.path)]; if (!target) return;
      const source = await fs.readFile(args.path, 'utf8');
      if (!source.includes(target[0])) throw Error('Diagnostic instrumentation target changed: ' + args.path);
      let contents = source.replace(target[0], target[0] + ` globalThis.__renderCounts['${target[1]}']++; `);
      if (path.basename(args.path) === 'markdown.tsx') contents = contents.replace('function MarkdownContent({ text }: { text: string }) {', "function MarkdownContent({ text }: { text: string }) { globalThis.__renderCounts.parsed++; ");
      return { contents, loader: 'tsx' };
    });
  } }],
});
const assets = new Map(bundle.outputFiles.map(file => ['/' + path.basename(file.path), file.contents]));
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.setHeader('content-type', 'text/html'); res.end('<html><head><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>'); return;
  }
  const asset = assets.get(req.url); if (!asset) { res.writeHead(404).end(); return; }
  res.setHeader('content-type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(asset);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const rounds of [10, 100]) {
    const data = makeFixture('input-diagnostic', 1, 0, { actor: 'Bob', screen: '会话', status: '就绪' });
    const messages = Array.from({ length: rounds }, (_, i) => [
      { id: 'u-' + i, role: 'user', text: '请分析第 ' + i + ' 轮的结果。', createdAt: data.at },
      { id: 'a-' + i, role: 'assistant', phase: 'final_answer', text: '## 结果 ' + i + '\n\n**验证通过**，继续比较运行时间。\n\n| 项目 | 结果 |\n| --- | --- |\n| 基线 | 12 ms |\n| 本轮 | 10 ms |\n\n公式：$a^2+b^2=c^2$。\n\n```python\nprint("verified")\n```', createdAt: data.at },
    ]).flat();
    messages.splice(1, 0, { id: 'tool-history', role: 'tool', text: '$ verify\npassed', createdAt: data.at });
    data.session.messages = messages; data.snapshot.sessions = [data.session];
    data.snapshot.selectedProjectId = data.project.id;
    const child = { ...structuredClone(data.session), id: 'child-session', title: '输入诊断子会话', parentId: data.session.id, fork: { parentId: data.session.id, nativeFork: true, workspaceKind: 'shared-directory' } };
    data.snapshot.sessions.push(child);
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.addInitScript(({ source, data }) => {
      window.__renderCounts = { workspace: 0, transcript: 0, markdown: 0, parsed: 0 };
      (0, eval)('(' + source + ')')(data);
      const call = window.workbench.call, subscribe = window.workbench.subscribe, listeners = [];
      window.workbench.subscribe = listener => { listeners.push(listener); const unsubscribe = subscribe(listener); return () => { listeners.splice(listeners.indexOf(listener), 1); unsubscribe(); }; };
      window.__emitSnapshot = () => listeners.forEach(listener => listener({ type: 'state' }));
      window.workbench.call = (action, payload) => {
        const operation = action.replace(/^personal:/, '');
        if (operation === 'session.input.flush') { window.__handbook.calls.push(operation); return Promise.resolve(true); }
        if (['session.send', 'session.enqueue'].includes(operation)) {
          window.__sentInput = structuredClone(payload); window.__handbook.calls.push(operation);
          return new Promise((resolve, reject) => { window.__resolveSend = resolve; window.__rejectSend = () => reject(Error('模拟发送失败')); });
        }
        return call(action, payload);
      };
    }, { source: installFixture.toString(), data });
    await page.goto(origin);
    await page.getByLabel('任务输入', { exact: true }).waitFor({ timeout: 30000 });
    async function sample(label, input, streaming = false) {
      await input.fill('');
      await page.waitForTimeout(100);
      await page.evaluate(() => { window.__renderCounts = { workspace: 0, transcript: 0, markdown: 0, parsed: 0 }; window.__handbook.calls.length = 0; });
      if (streaming) await page.evaluate(() => {
        window.__streamingEvents = 0;
        window.__streamingTimer = setInterval(() => {
          window.__streamingEvents++;
          window.__handbook.data.snapshot.sessions[0].messages.at(-1).text += '.';
          window.__emitSnapshot();
        }, 80);
      });
      const times = [];
      const edits = streaming ? 40 : 12;
      for (let i = 0; i < edits; i++) {
        const elapsed = await input.evaluate(async (el, i) => {
          const start = performance.now();
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, el.value + String.fromCharCode(97 + i));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
          return performance.now() - start;
        }, i);
        times.push(elapsed);
        if (streaming) await page.waitForTimeout(20);
      }
      if (streaming) await page.evaluate(() => clearInterval(window.__streamingTimer));
      times.sort((a, b) => a - b);
      const counts = await page.evaluate(() => ({ renders: window.__renderCounts, inputSaves: window.__handbook.calls.filter(value => value === 'session.input').length, snapshotReads: window.__handbook.calls.filter(value => value === 'snapshot').length, stateEvents: window.__streamingEvents || 0 }));
      if (!streaming) {
        assert.equal(counts.renders.workspace, 0, 'keystrokes must not update the workspace');
        assert.equal(counts.renders.transcript, 0, 'keystrokes must not redraw history');
        assert.equal(counts.renders.markdown, 0, 'keystrokes must not parse historical Markdown');
        assert.equal(counts.renders.parsed, 0);
      } else {
        assert(counts.snapshotReads >= 1, 'streaming must still refresh the conversation');
        assert(counts.snapshotReads < counts.stateEvents / 2, 'streaming must not clone a large snapshot on every state event');
      }
      assert.equal(counts.inputSaves, edits, 'each character must reach the memory draft');
      console.log(JSON.stringify({ rounds, label, medianEditToFrameMs: +times[Math.floor(times.length / 2)].toFixed(1), maxEditToFrameMs: +times.at(-1).toFixed(1), ...counts }));
    }
    await sample('main-before-child-open', page.getByLabel('任务输入', { exact: true }));
    if (rounds === 100) {
      // A real long session can exceed 25 MB while the agent streams updates.
      await page.evaluate(() => { window.__handbook.data.snapshot.sessions[0].diagnosticPadding = 'x'.repeat(24 * 1024 * 1024); });
      await sample('main-with-large-streaming-snapshot', page.getByLabel('任务输入', { exact: true }), true);
      await page.evaluate(() => { delete window.__handbook.data.snapshot.sessions[0].diagnosticPadding; window.__emitSnapshot(); });
    }
    await page.getByRole('button', { name: '展开会话菜单：' + data.session.title, exact: true }).click();
    await page.locator('.session-row[data-session-id="child-session"]').click();
    await page.getByLabel('子会话输入', { exact: true }).waitFor();
    await sample('child-open', page.getByLabel('子会话输入', { exact: true }));
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    await sample('main-with-hidden-child', page.getByLabel('任务输入', { exact: true }));
    await page.getByRole('button', { name: '展开子会话', exact: true }).click();
    const childInput = page.getByLabel('子会话输入', { exact: true });
    await expect(childInput).toHaveValue('abcdefghijkl');
    await childInput.fill('中文草稿'); await childInput.press('ArrowLeft'); await childInput.press('Backspace');
    await expect(childInput).toHaveValue('中文稿');
    const sends = await page.evaluate(() => window.__handbook.calls.filter(value => value === 'session.send').length);
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      await childInput.evaluate((el, init) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })), init);
    }
    assert.equal(await page.evaluate(() => window.__handbook.calls.filter(value => value === 'session.send').length), sends);
    await childInput.fill('刚刚输入的草稿');
    await page.locator('.subsession-chat .conversation-message.assistant').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '添加到会话', exact: true }).click();
    await expect(childInput).toHaveValue(/^刚刚输入的草稿\n\n>/);
    await childInput.fill('最新发送内容'); await childInput.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__sentInput?.text)).toBe('最新发送内容');
    await expect(childInput).toHaveValue('');
    await childInput.fill('失败时也不能覆盖的新稿');
    await page.evaluate(() => window.__rejectSend());
    await expect(childInput).toHaveValue('失败时也不能覆盖的新稿');
    await expect(page.getByRole('button', { name: '恢复未发送消息到输入框', exact: true })).toBeVisible();
    await page.locator('.session-row[data-session-id="work-session"]').click();
    await expect(page.getByLabel('任务输入', { exact: true })).toHaveValue('abcdefghijkl');
    await page.locator('.session-row[data-session-id="child-session"]').click();
    await expect(childInput).toHaveValue('失败时也不能覆盖的新稿');
    // Hidden history pauses rendering, not state delivery. Reopening catches up.
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    await page.evaluate(() => {
      window.__renderCounts = { workspace: 0, transcript: 0, markdown: 0, parsed: 0 };
      window.__handbook.data.snapshot.sessions.find(session => session.id === 'child-session').messages.push({ id: 'hidden-reply', role: 'assistant', phase: 'final_answer', text: 'HIDDEN_NEW_REPLY', createdAt: window.__handbook.data.at });
      window.__emitSnapshot();
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__renderCounts.parsed), 0, 'unchanged main Markdown and hidden new replies must not parse');
    await page.getByRole('button', { name: '展开子会话', exact: true }).click();
    await expect(page.locator('.subsession-chat').getByText('HIDDEN_NEW_REPLY', { exact: true })).toBeVisible();
    await expect(childInput).toHaveValue('失败时也不能覆盖的新稿');
    assert.equal(await page.evaluate(() => window.__renderCounts.parsed), 1, 'only the new message parses on reopening');
    // A visible streaming snapshot must keep the draft and parse only its delta.
    await page.evaluate(() => {
      window.__renderCounts = { workspace: 0, transcript: 0, markdown: 0, parsed: 0 };
      window.__handbook.data.snapshot.sessions.find(session => session.id === 'child-session').messages.at(-1).text += '_STREAMED';
      window.__emitSnapshot();
    });
    await expect(page.locator('.subsession-chat').getByText('HIDDEN_NEW_REPLY_STREAMED', { exact: true })).toBeVisible();
    await expect(childInput).toHaveValue('失败时也不能覆盖的新稿');
    assert.equal(await page.evaluate(() => window.__renderCounts.parsed), 1, 'streaming must not reparse previous messages');
    const activity = page.locator('.subsession-chat .turn-activity-group').first();
    await activity.locator(':scope > summary').click();
    await expect(activity).toHaveAttribute('open', '');
    const scroll = page.locator('.subsession-chat .subsession-messages');
    const position = await scroll.evaluate(el => { el.scrollTop = Math.min(100, el.scrollHeight - el.clientHeight); el.dispatchEvent(new Event('scroll')); return el.scrollTop; });
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    await page.getByRole('button', { name: '展开子会话', exact: true }).click();
    await expect(activity).toHaveAttribute('open', '');
    assert(Math.abs(await scroll.evaluate(el => el.scrollTop) - position) < 2, 'hiding a child must retain its scroll position');
    await expect(childInput).toHaveValue('失败时也不能覆盖的新稿');
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
