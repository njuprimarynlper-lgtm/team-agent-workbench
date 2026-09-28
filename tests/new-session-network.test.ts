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

test('a direct session remains selectable while another management task runs', () => {
  const page = renderToStaticMarkup(React.createElement(ProviderConnectionSettings, { provider: 'codex', cwd: 'D:/work', auth, egress: ready, sessionRoute: 'direct', activeTaskCount: 1 }));
  assert.match(page, /本机网络/);
  assert.match(page, /重新检测连接与登录/);
  assert.doesNotMatch(page, /当前有 1 个任务使用管理端出口/);
});

test('direct creation tolerates missing optional checks; management access waits for a successful account check', () => {
  const base = { projectId: 'p1', networkPending: false, networkBusy: false, busy: false, managementRoute: false, provider: 'codex' as const, cwd: 'D:/work' };
  assert.equal(newSessionBlockedReason(base), undefined);
  assert.match(newSessionBlockedReason({ ...base, projectId: '' }) || '', /选择项目/);
  assert.match(newSessionBlockedReason({ ...base, networkPending: true }) || '', /网络方式尚未应用/);
  assert.match(newSessionBlockedReason({ ...base, busy: true }) || '', /正在创建/);
  // Direct access can save a session before CLI login; sending still checks it.
  assert.equal(newSessionBlockedReason(base), undefined);
  const relay = { ...base, managementRoute: true };
  assert.match(newSessionBlockedReason(relay) || '', /尚未检测成功/);
  assert.match(newSessionBlockedReason({ ...relay, cwd: '' }) || '', /工作目录尚未就绪/);
  assert.match(newSessionBlockedReason({ ...relay, networkBusy: true, checked: { provider: 'codex' as const, cwd: 'D:/work', auth } }) || '', /正在检测/);
  assert.match(newSessionBlockedReason({ ...relay, checked: { provider: 'cursor' as const, cwd: 'D:/work', auth } }) || '', /尚未检测成功/);
  assert.match(newSessionBlockedReason({ ...relay, checked: { provider: 'codex' as const, cwd: 'D:/other', auth } }) || '', /尚未检测成功/);
  assert.match(newSessionBlockedReason({ ...relay, checked: { provider: 'codex' as const, cwd: 'D:/work', auth: { ...auth, status: 'unauthenticated' as const } } }) || '', /尚未检测成功/);
  assert.match(newSessionBlockedReason({ ...relay, checked: { provider: 'codex' as const, cwd: 'D:/work', auth: { ...auth, status: 'error' as const } } }) || '', /尚未检测成功/);
  assert.equal(newSessionBlockedReason({ ...relay, checked: { provider: 'codex', cwd: 'D:/work', auth } }), undefined);
  assert.equal(newSessionBlockedReason({ ...relay, checked: { provider: 'codex', cwd: 'D:/work', auth: { ...auth, status: 'configured' } } }), undefined);
  const failed = { ...relay, checked: { provider: 'codex' as const, cwd: 'D:/work', auth: { ...auth, status: 'unauthenticated' as const } } };
  assert.match(newSessionBlockedReason({ ...failed, latestAuth: { ...auth, networkRoute: 'management', status: 'checking' } }) || '', /正在检测/);
  assert.equal(newSessionBlockedReason({ ...failed, latestAuth: { ...auth, networkRoute: 'management', checkedAt: '2026-09-29' } }), undefined, 'a successful login followed by automatic recheck unlocks creation');
  assert.match(newSessionBlockedReason({ ...relay, checked: { provider: 'codex', cwd: 'D:/work', auth }, latestAuth: { ...auth, networkRoute: 'management', status: 'error', checkedAt: '2026-09-29' } }) || '', /尚未检测成功/);
  assert.equal(newSessionBlockedReason({ ...failed, latestAuth: { ...auth, networkRoute: 'direct', checkedAt: '2026-09-29' } }), '所选 AI 账号尚未检测成功，请登录或重新检测。', 'a direct-route check cannot unlock the management route');
});
