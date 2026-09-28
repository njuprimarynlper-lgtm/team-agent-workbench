import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EgressView } from '../src/admin/egress-view';
import { adminEgressConfigSchema } from '../src/core/egress-config';
import type { AdminEgressSnapshot } from '../src/shared/egress';

test('egress opens setup before enabling, monitoring afterwards, and keeps each access route in its own panel', () => {
  const base: AdminEgressSnapshot = { config: adminEgressConfigSchema.parse({ enabled: false, publicHost: 'admin.internal' }), running: false, activeConnections: 0, fingerprint: 'A'.repeat(64), inviteCode: 'PRIVATE_ACCESS_CODE', hasUpstreamPassword: false, events: [] };
  const render = (snapshot: AdminEgressSnapshot) => renderToStaticMarkup(React.createElement(EgressView, { snapshot, remote: { connected: false, verified: false, busy: false }, refresh: async () => { throw new Error('Rendering must not change the gateway'); } }));
  for (const enabled of [false, true]) {
    const html = render({ ...base, config: { ...base.config, enabled }, running: enabled });
    const panels = [...html.matchAll(/<div role="tabpanel"[^>]*>/g)].map(match => match[0]);
    assert.equal(panels.length, 4); assert.equal(panels.filter(tag => !tag.includes('hidden')).length, 1);
    assert(panels.find(tag => !tag.includes('hidden'))!.includes(enabled ? '-panel-monitor' : '-panel-settings'));
    assert.equal((html.match(/role="tab"/g) || []).length, 4);
    assert.doesNotMatch(html, /PRIVATE_ACCESS_CODE/);
    assert.match(html, /<details class="egress-disclosure egress-credentials">/);
    assert.match(html, /<details class="egress-disclosure egress-history">/);
    assert.match(html, /<div class="egress-route-panel"><section class="egress-card egress-direct-access"/);
    assert.match(html, /<div hidden="" class="egress-route-panel"><section class="egress-card egress-jump"/);
    assert.match(html, /复制接入码/); assert.match(html, /启用反向隧道/);
  }
  const shared = render({ ...base, reverse: { enabled: true, state: 'connected', detail: '反向隧道已连接', memberAccessConfigured: true, activeConnections: 2, reconnects: 0, bytesUp: 0, bytesDown: 0 } });
  assert.match(shared, /<div hidden="" class="egress-route-panel"><section class="egress-card egress-direct-access"/);
  assert.match(shared, /<div class="egress-route-panel"><section class="egress-card egress-jump"/);
  assert.match(shared, /复制中转接入码/); assert.match(shared, /检测完整隧道/);
});
