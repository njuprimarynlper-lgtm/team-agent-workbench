import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const root = process.cwd(), out = path.join(root, 'artifacts', 'recommendation-sharing'); await fs.mkdir(out, { recursive: true });
await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ConclusionLibrary} from './src/renderer/conclusions';import {RsiRecommendations} from './src/renderer/project-interactions';
import './src/renderer/styles.css';import './src/renderer/result-card.css';import './src/renderer/project-interactions.css';
function App(){const[inbox,setInbox]=useState(window.inbox);return <main style={{padding:24}}>{location.search.includes('rsi')?<RsiRecommendations inbox={inbox} call={window.workbench.call} reload={async()=>setInbox(structuredClone(window.inbox))}/>:<ConclusionLibrary project={window.project} sessions={[]} notice={text=>window.notice=text} mergeStarted={()=>{}}/>}</main>;}
createRoot(document.getElementById('root')).render(<App/>);` }, bundle: true, format: 'iife', platform: 'browser', outfile: path.join(out, 'ui.js'), logLevel: 'silent' });
await fs.writeFile(path.join(out, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"><div id="root"></div><script src="ui.js"></script></html>');
const browser = await chromium.launch({ channel: 'msedge', headless: true }), page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
 const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'), now = '2026-11-10T00:00:00Z';
 window.project = { id: 'p', name: '验收项目', remoteRoot: '/p', uploadPath: '/p/results' };
 window.personal = { id: id(1), projectId: 'p', title: '边界验证记录', content: '已核对两组边界样本。', category: 'exploration', version: 3, sources: [], derivedFrom: [{ scope: 'personal', projectId: 'p', id: id(2), version: 1 }], updatedAt: now };
 window.inbox = { projectId: 'p', enabled: true, busy: false, queued: false, sessions: [{ id: id(3), title: '正在生成的会话' }], items: [{ id: 'suggestion', projectId: 'p', title: '补齐边界验证', action: '固定开发集并保留独立评估输出。', reason: '只有验收要求，没有评估记录。', conditions: [], evidence: [], evidenceIds: [], createdAt: now, uncertainty: '', review: { decision: 'pending', feedback: '', closed: false } }] };
 window.calls = []; window.fail = false;
 window.workbench = { subscribe: () => () => {}, call: async (action, payload) => {
  window.calls.push({ action, payload: structuredClone(payload) });
  if (action === 'conclusion.list') return [structuredClone(window.personal)];
  if (action === 'content.list') return [];
  if (action === 'team.cache.read') return;
  if (action === 'result.directory.list') return payload.scope === 'team' ? [{ id: id(4), parentId: 'exploration', name: '团队验收', revision: 1 }] : [];
  if (action === 'conclusion.publish') return { id: 'upload' };
  if (action === 'rsi.feedback') {
   if (window.fail) throw Error('参考保存失败，请重试');
   const review = window.inbox.items[0].review;
   if (payload.reaction.kind === 'accepted') Object.assign(review, { decision: 'accepted', decisionEventId: 'decision' });
   if (payload.reaction.kind === 'supplement') Object.assign(review, { closed: true, linkedSessionId: payload.reaction.linkedSessionId, feedback: payload.reaction.text });
   return { id: 'event' };
  }
  throw Error('Unexpected API ' + action);
 } };
});
const url = pathToFileURL(path.join(out, 'index.html')).href;
const share = async () => { await page.locator('.result-more > summary').click(); await page.getByRole('button', { name: '分享至团队', exact: true }).click(); };
try {
 await page.goto(url);
 await share(); await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect.poll(() => page.evaluate(() => window.calls.filter(call => call.action === 'conclusion.publish').length)).toBe(1);
 expect(await page.evaluate(() => window.calls.filter(call => call.action === 'conclusion.publish')[0].payload)).toEqual({ id: '00000000-0000-4000-8000-000000000001', version: 3, disclose: [] });
 const chooseFolder = async () => { await page.locator('.result-more > summary').click(); await page.getByRole('button', { name: '选择目录分享…', exact: true }).click(); };
 await chooseFolder(); const dialog = page.getByRole('dialog', { name: '选择成果保存目录', exact: true });
 await expect(dialog).toBeVisible(); await dialog.getByRole('button', { name: '取消', exact: true }).click();
 expect(await page.evaluate(() => window.calls.filter(call => call.action === 'conclusion.publish').length)).toBe(1);
 await chooseFolder(); await dialog.getByRole('button', { name: '团队验收', exact: true }).click();
 await dialog.getByRole('button', { name: '分享至团队', exact: true }).click(); await expect(dialog).toHaveCount(0);
 expect(await page.evaluate(() => window.calls.filter(call => call.action === 'conclusion.publish').at(-1).payload.folderId)).toBe('00000000-0000-4000-8000-000000000004');
 await chooseFolder(); await dialog.getByText('公开直接来源（选填）', { exact: true }).click();
 await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: '分享至团队', exact: true }).click();
 expect(await page.evaluate(() => window.calls.filter(call => call.action === 'conclusion.publish').at(-1).payload.disclose.length)).toBe(1);
 await chooseFolder(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
 await page.goto(url + '?rsi');
 await page.getByRole('button', { name: '接受', exact: true }).click(); await page.getByRole('combobox', { name: '关联会话' }).selectOption('00000000-0000-4000-8000-000000000003');
 await expect(page.getByText('保存后作为会话的待发送参考，随下一次消息生效。', { exact: true })).toBeVisible();
 expect(await page.evaluate(() => window.calls.filter(call => call.action === 'rsi.feedback').length)).toBe(1);
 await page.getByRole('textbox', { name: '推荐反馈', exact: true }).fill('希望补充更多背景'); await page.evaluate(() => { window.fail = true; });
 await page.getByRole('button', { name: '保存补充', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('参考保存失败');
 await page.evaluate(() => { window.fail = false; }); await page.getByRole('button', { name: '保存补充', exact: true }).click();
 await expect(page.getByRole('status')).toContainText('随下一次发送生效');
 await expect(page.getByRole('status')).toContainText('当前生成不受影响');
 const attempts = await page.evaluate(() => window.calls.filter(call => call.action === 'rsi.feedback' && call.payload.reaction.kind === 'supplement').map(call => call.payload.reaction.requestId));
 expect(attempts[0]).toBe(attempts[1]); expect(attempts.length).toBe(2);
 await page.screenshot({ path: path.join(out, 'recommendation-linked.png') });
 expect(errors).toEqual([]); console.log(JSON.stringify({ passed: true, checks: ['direct share has no confirmation', 'optional directory sharing and cancellation', 'private sources excluded by default with optional disclosure', 'recommendation link explains next-message semantics', 'failed save stays retryable and reuses request id'], out }));
} catch (error) { await page.screenshot({ path: path.join(out, 'failure.png') }); throw error; } finally { await browser.close(); }
