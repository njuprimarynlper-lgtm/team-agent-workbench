import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsSchema } from '../src/core/config';

test('legacy null session titles in shared content do not block account settings', () => {
  const parsed = settingsSchema.parse({
    connections: [], providerPaths: { codex: '', cursor: '', claude: '' }, lastWorkspace: '',
    contentSeen: { account: { item: { revision: 1, sourceSessionTitle: null } } },
    contentUpdates: [{
      eventId: 'event', projectId: 'project', projectName: 'Project', id: 'item',
      title: 'Result', revision: 1, sourceSessionTitle: null, change: 'new',
      occurredAt: '2026-11-03T00:00:00.000Z', detectedAt: '2026-11-03T00:00:00.000Z',
    }],
  });

  const seen = parsed.contentSeen?.account.item;
  assert.equal(typeof seen, 'object');
  if (typeof seen === 'object') assert.equal(seen.sourceSessionTitle, undefined);
  assert.equal(parsed.contentUpdates?.[0].sourceSessionTitle, undefined);
});
