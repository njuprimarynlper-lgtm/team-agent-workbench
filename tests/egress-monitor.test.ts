import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EgressMonitor } from '../src/core/egress-monitor';
import { EgressMonitorPanel } from '../src/admin/egress-monitor';
import { CliConnectionNotice } from '../src/renderer/cli-connection-notice';
import { cliReportSchema } from '../src/shared/cli-connection';
import type { EgressConnectionEvent } from '../src/shared/egress';

const event = (id: string): EgressConnectionEvent => ({ id, at: '2026-01-01T00:00:00Z', username: 'alice', clientAddress: '127.0.0.1', provider: 'codex', target: 'chatgpt.com:443', status: 'connected', bytesUp: 0, bytesDown: 0 });
test('live traffic rates, member totals and cumulative counts remain correct beyond the 100 recent events', () => {
  let clock = 0; const monitor = new EgressMonitor(() => clock, () => new Date(clock).toISOString());
  const first = event('first'); monitor.connected(first); monitor.transfer(first, 4000, 12000);
  clock = 2000; let sample = monitor.sample();
  assert.equal(sample.upPerSecond, 2000); assert.equal(sample.downPerSecond, 6000); assert.equal(sample.members[0].connections, 1);
  for (let i = 0; i < 120; i++) { const item = event(String(i)); monitor.connected(item); monitor.transfer(item, 10, 20); item.status = 'closed'; monitor.finished(item); }
  sample = monitor.snapshot(); assert.equal(sample.connections, 121); assert.equal(sample.bytesUp, 5200); assert.equal(sample.bytesDown, 14400);
  assert.equal(sample.activeTunnels, 1); assert.equal(sample.members[0].bytesDown, 12000);
  assert.equal(monitor.events().length, 100); assert.equal(monitor.events().filter(item => item.id === 'first').length, 1);
  clock = 4000; monitor.sample(); clock = 6000; assert.equal(monitor.sample().upPerSecond, 0, 'idle periods must not retain a stale throughput');
  first.status = 'error'; monitor.finished(first); sample = monitor.snapshot(); assert.equal(sample.activeTunnels, 0); assert.equal(sample.failures, 1); assert.deepEqual(sample.members, []);
  for (let i = 0; i < 80; i++) { clock += 2000; monitor.sample(); } assert.equal(monitor.snapshot().history.length, 60);
});

test('CLI reports retain only allowlisted state, remain bounded and render errors independently of a healthy tunnel', () => {
  const monitor = new EgressMonitor();
  const report = cliReportSchema.parse({ clientId: 'bd5451d3-4bdf-44b3-bcdd-27ff4597c42b', sessionId: 'fixture', provider: 'codex', connection: { state: 'failed', kind: 'forbidden', httpStatus: 403, prompt: 'PRIVATE_PROMPT', token: 'PRIVATE_TOKEN', message: 'PRIVATE_ERROR' }, password: 'PRIVATE_PASSWORD' });
  monitor.report({ ...report, username: 'alice', address: '127.0.0.1', updatedAt: new Date().toISOString() });
  assert(!JSON.stringify(monitor.snapshot()).includes('PRIVATE'));
  const html = renderToStaticMarkup(React.createElement(EgressMonitorPanel, { snapshot: { config: {} as any, running: true, activeConnections: 1, fingerprint: '', inviteCode: '', hasUpstreamPassword: false, events: [], monitor: { ...monitor.sample(), process: { pid: 123, cpuPercent: 0.17, memoryBytes: 50 * 1024 ** 2, heapBytes: 1 } } } }));
  for (const value of ['HTTP 403', 'CLI 请求失败', '代理 CPU', '0.17%', '50.0 MB', '独立代理进程', '在线成员']) assert(html.includes(value), value);
  const reconnect = renderToStaticMarkup(React.createElement(CliConnectionNotice, { value: { state: 'reconnecting', kind: 'network', attempt: 2, retryLimit: 5, at: new Date().toISOString() } }));
  assert(reconnect.includes('CLI 正在重连（2/5）')); assert(reconnect.includes('role="status"'));
  for (let i = 0; i < 120; i++) monitor.report({ ...report, sessionId: 'session-' + i, username: 'alice', address: '127.0.0.1', updatedAt: new Date().toISOString() });
  assert.equal(monitor.snapshot().cliReports.length, 100);
});

test('stale process and client samples are explicitly labelled instead of displaying old health as live', () => {
  const monitor = new EgressMonitor(() => 0, () => '2020-01-01T00:00:00Z');
  monitor.report({ clientId: 'bd5451d3-4bdf-44b3-bcdd-27ff4597c42b', sessionId: 'session', provider: 'codex', username: 'alice', address: '127.0.0.1', connection: { state: 'connected' }, updatedAt: '2020-01-01T00:00:00Z' });
  const html = renderToStaticMarkup(React.createElement(EgressMonitorPanel, { snapshot: { config: {} as any, running: true, activeConnections: 1, fingerprint: '', inviteCode: '', hasUpstreamPassword: false, events: [], monitor: { ...monitor.snapshot(), process: { pid: 1, cpuPercent: 99, memoryBytes: 100, heapBytes: 1 } } } }));
  assert(html.includes('监控暂未更新')); assert(html.includes('状态已过期')); assert(!html.includes('99.00%'));
});
