import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProviderConnectionSettings } from '../src/renderer/provider-connection';
import { newSessionBlockedReason } from '../src/renderer/new-session-readiness';
import type { UserEgressStatus } from '../src/shared/egress';
import type { ProviderAuth } from '../src/shared/types';

const auth: ProviderAuth = { status: 'authenticated', detail: '已登录', cwd: 'D:/work', checkedAt: '2026-09-28' };
const direct: UserEgressStatus = { enabled: false, configured: false, running: false, detail: '使用本机网络直连', hasAccessCode: false };
const ready: UserEgressStatus = { enabled: true, viaSharedServer: true, configured: true, running: true, available: true, detail: '管理端网络出口可用', hasAccessCode: true };
const render = (egress: UserEgressStatus, routeEditable = true) => renderToStaticMarkup(React.createElement(ProviderConnectionSettings, { provider: 'codex', cwd: 'D:/work', auth, egress, activeTaskCount: 0, routeEditable }));

test('new sessions reuse the selected management route and saved access code without asking again', () => {
  const first = render(direct);
  assert.match(first, /通过管理端访问模型服务/);
  assert.doesNotMatch(first, /管理端接入码已保存/);
  const later = render(ready);
  assert.match(later, /管理端接入码已保存，本次无需再次输入/);
  assert.match(later, /checked=""[^>]*aria-label="通过管理端访问模型服务"|aria-label="通过管理端访问模型服务"[^>]*checked=""/);
  assert.doesNotMatch(later, /<textarea[^>]*aria-label="管理端网络出口接入码"/);
  const existingSession = render(ready, false);
  assert.doesNotMatch(existingSession, /通过管理端访问模型服务|管理端接入码|经共享服务器中转/);
  assert.match(existingSession, /重新检测连接与登录/);
});

test('creation only waits for project selection, an unapplied route choice or its own save', () => {
  const base = { projectId: 'p1', networkPending: false, busy: false };
  assert.equal(newSessionBlockedReason(base), undefined);
  assert.match(newSessionBlockedReason({ ...base, projectId: '' }) || '', /选择项目/);
  assert.match(newSessionBlockedReason({ ...base, networkPending: true }) || '', /网络方式尚未应用/);
  assert.match(newSessionBlockedReason({ ...base, busy: true }) || '', /正在创建/);
  // Login, model catalog, quota, network reachability and a chosen local path are
  // checked when actually needed; none is a prerequisite for saving the session.
  assert.equal(newSessionBlockedReason(base), undefined);
});
