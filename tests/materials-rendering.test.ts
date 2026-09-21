import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Draft, DraftArtifact } from '../src/shared/types';

test('attachment review renders explicit unchecked suggestions and no conclusion-download control without opening windows', async () => {
  (globalThis as any).window = { workbench: { call: async () => true } };
  const { DraftAttachments, SharedAttachments } = await import('../src/renderer/attachments');
  const artifact = { id: 'a', title: '【项目结论】 可复用结果', attachments: [{ fileId: 'f', selected: false }] } as DraftArtifact;
  const draft = { files: [{ id: 'f', name: 'report.csv', size: 32 }] } as Draft;
  const html = renderToStaticMarkup(createElement(DraftAttachments, { draft, artifact, locked: false, run: async fn => fn() }));
  assert.match(html, /report.csv/); assert.match(html, /预览/); assert.match(html, /添加本地文件/); assert.doesNotMatch(html, /checked=""/);
  const shared = renderToStaticMarkup(createElement(SharedAttachments, { projectId: 'p', item: { id: 'r', attachments: [{ name: 'report.csv', path: '/p/blob', sha256: 'a'.repeat(64), size: 32 }] } as any }));
  assert.match(shared, /下载附件/); assert.match(shared, /32 B/);
  delete (globalThis as any).window;
});
