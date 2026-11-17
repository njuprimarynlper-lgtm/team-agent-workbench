// Generate the actual failPreparation event from frozen/current source using
// isolated local state. The notice screenshot harness consumes this typed event.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = process.cwd(), phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8) || 'after';
assert(['before', 'after'].includes(phase));
const source = phase === 'before' ? path.join(root, '.test-data/error-readability/baseline') : root;
const output = path.join(root, '.test-data/error-audit/preparation-notice-' + phase);
await fs.mkdir(output, { recursive: true });
const { Workbench } = await import(pathToFileURL(path.join(source, 'src/core/workbench.ts')));
const { logsFor } = await import(pathToFileURL(path.join(source, 'src/core/logging.ts')));
const helper = { id: 'audit-preparation-helper', provider: 'codex', purpose: 'prepare', title: '本轮成果整理', cwd: output, createdAt: '2026-11-16T08:00:00Z', messages: [], sources: [], approvals: [], status: 'error' };
const events = [];
const host = { store: { root: output, save: async () => {} }, session: () => helper, runtimes: new Map(), broadcast() {}, notice(message, failure) { events.push({ type: 'notice', message, ...(failure ? { failure } : {}) }); } };
const draft = { id: 'audit-preparation-task', title: '本轮成果整理', sourceSessionTitle: '错误提示验收会话', sessionId: 'audit-session', prepareSessionId: helper.id, body: '', files: [], createdAt: '2026-11-16T08:00:00Z', inputDir: path.join(output, 'input'), outputPath: path.join(output, 'draft.md') };
await Workbench.prototype.failPreparation.call(host, draft, 'Network timeout: connection reset');
assert.equal(events.length, 1);
if (phase === 'after') { assert.equal(events[0].failure.outcome, 'unknown'); assert.doesNotMatch(events[0].message, /成果整理失败|下面|connection reset/); }
await logsFor(output).close();
const file = path.join(root, '.test-data/error-audit/preparation-notice-events.json');
const previous = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}'));
previous[phase] = { id: 'notice-preparation-interrupted', phase, sourceRoot: source, source: 'src/core/workbench.ts#failPreparation', condition: 'actual failPreparation receives Network timeout: connection reset', event: events[0], draft, helper, rawDiagnostic: 'Network timeout: connection reset' };
await fs.writeFile(file, JSON.stringify(previous, null, 2));
console.log(JSON.stringify({ phase, id: 'notice-preparation-interrupted', typed: !!events[0].failure, outcome: events[0].failure?.outcome, file }));
