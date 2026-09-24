import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EgressNetworkTests, type EgressTestResult } from '../src/admin/egress-tests';
import type { AdminEgressSnapshot } from '../src/shared/egress';

const snapshot: AdminEgressSnapshot = { config: { enabled: false, listenHost: '127.0.0.1', listenPort: 18443, publicHost: 'localhost', upstreamMode: 'direct', upstreamHost: '', upstreamPort: 0, upstreamUsername: '', codex: true, cursor: false, claude: false }, running: false, fingerprint: '', inviteCode: '', hasUpstreamPassword: false, activeConnections: 0, events: [] };
test('all network tests are available while forwarding is disabled and display the saved permissions separately', () => {
  const render = (busy = false, pendingChanges = false, results: Record<string, EgressTestResult> = {}) => renderToStaticMarkup(React.createElement(EgressNetworkTests, { snapshot, busy, pendingChanges, results, onTest: () => { throw new Error('render must not probe'); } }));
  const html = render();
  assert.equal((html.match(/<button/g) || []).length, 3); assert(!html.includes('disabled'));
  for (const label of ['测试 Codex', '测试 Cursor', '测试 Claude Code', '无需在本机安装或启动', '不改变成员转发权限', '成员的模型登录']) assert(html.includes(label), label);
  assert.equal((html.match(/未允许成员转发/g) || []).length, 2);
  assert.equal((render(true).match(/disabled=""/g) || []).length, 3);
  assert(render(false, true).includes('当前测试仍使用已保存的设置'));
  const failure = render(false, false, { cursor: { ok: false, detail: '上游 HTTP 403' } }); assert(failure.includes('role="alert"')); assert(failure.includes('HTTP 403'));
});
