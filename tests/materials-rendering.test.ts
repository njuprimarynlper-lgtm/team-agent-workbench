import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs/promises';
import type { AgentSession, Draft, DraftArtifact, Project } from '../src/shared/types';

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

test('project notes use a precise, role-neutral name in navigation, library, activity and Session entry', async () => {
  (globalThis as any).window = { workbench: { call: async () => [] } };
  try {
    const { ConclusionLibrary } = await import('../src/renderer/conclusions');
    const { SessionMaterials } = await import('../src/renderer/session-materials');
    const { ContentUpdatesPanel } = await import('../src/renderer/content-updates');
    const project = { id: 'personal-project', name: '测试项目' } as Project;
    const library = renderToStaticMarkup(createElement(ConclusionLibrary, { project, sessions: [], notice: () => {}, mergeStarted: () => {} }));
    assert.match(library, /我的项目笔记 · 测试项目/);
    assert.match(library, /你在本项目中保存的结论、标准、方法、问题与建议/);
    assert.match(library, /aria-label="搜索我的项目笔记"/);
    assert.doesNotMatch(library, /管理项目资料|我的资料|<h1>项目资料/);
    for (const category of ['项目结论', '项目标准', '方法探索', '问题与风险', '改进建议']) assert(library.includes(category), 'renaming the library must not rename its content categories');
    assert.match(library, />新建笔记<\/button>/);
    const session = renderToStaticMarkup(createElement(SessionMaterials, { session: { binding: { project } } as AgentSession, changed: async () => {} }));
    assert.match(session, />引用项目笔记<\/button>/);
    const activity = renderToStaticMarkup(createElement(ContentUpdatesPanel, { updates: [{ eventId: 'event', projectId: project.id, projectName: project.name, id: 'result', title: '共享成果', revision: 1, change: 'new', occurredAt: '2026-09-22', detectedAt: '2026-09-22' }], aliases: {}, apply: async () => undefined, view: () => {}, deletionResolved: async () => {} }));
    assert.match(activity, />存为项目笔记<\/button>/); assert.doesNotMatch(activity, /加入项目资料/);
    // This role-neutral entry must not become an administrator-only label.
    const main = await fs.readFile('src/renderer/main.tsx', 'utf8');
    assert.match(main, /title="我的项目笔记" data-tooltip="我的项目笔记" aria-label="我的项目笔记"/);
    assert.doesNotMatch(main, /管理项目资料|我的资料（当前项目）/);
    assert.match(main, /projectAdmin \? '整理项目文档' : '公共成果'/, 'the public project entry remains distinct');
  } finally { delete (globalThis as any).window; }
});
