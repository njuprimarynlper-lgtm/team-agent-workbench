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

test('local project results use consistent navigation and actions without renaming content categories', async () => {
  (globalThis as any).window = { workbench: { call: async () => [] } };
  try {
    const { ConclusionLibrary } = await import('../src/renderer/conclusions');
    const { ProjectResults } = await import('../src/renderer/project-results');
    const { SessionMaterials } = await import('../src/renderer/session-materials');
    const { ContentUpdatesPanel } = await import('../src/renderer/content-updates');
    const project = { id: 'personal-project', name: '测试项目' } as Project;
    const library = renderToStaticMarkup(createElement(ConclusionLibrary, { project, sessions: [], notice: () => {}, mergeStarted: () => {} }));
    assert.match(library, /个人成果 · 测试项目/);
    assert.match(library, /你在本项目中保存的成果，可供会话引用/);
    assert.match(library, /aria-label="搜索个人成果"/);
    assert.doesNotMatch(library, /管理项目资料|我的资料|我的项目笔记|本地项目结论库|<h1>项目资料/);
    assert.match(library, /aria-label="个人成果类别"/);
    assert.match(library, /全部类别（0）/);
    for (const category of ['项目结论', '项目标准', '方法探索', '问题与风险', '改进建议']) assert(!library.includes(category), 'an empty library must not offer project preset categories');
    assert.match(library, />新建成果<\/button>/);
    const unified = renderToStaticMarkup(createElement(ProjectResults, { projectName: project.name, scope: 'personal', changeScope: () => {}, children: createElement(ConclusionLibrary, { project, sessions: [], notice: () => {}, mergeStarted: () => {}, embedded: true }) }));
    assert.equal(unified.match(/<h1>/g)?.length, 1); assert.match(unified, /项目成果库 · 测试项目/);
    assert.equal(unified.match(/role="tab"/g)?.length, 2);
    assert.match(unified, /aria-label="个人"[^>]*aria-selected="true"/);
    assert.match(unified, /role="tabpanel" id="results-panel-personal" aria-labelledby="results-tab-personal"/);
    const session = renderToStaticMarkup(createElement(SessionMaterials, { session: { binding: { project } } as AgentSession, changed: async () => {} }));
    assert.match(session, />引用项目成果<\/button>/);
    const activity = renderToStaticMarkup(createElement(ContentUpdatesPanel, { updates: [{ eventId: 'event', projectId: project.id, projectName: project.name, id: 'result', title: '共享成果', revision: 1, change: 'new', occurredAt: '2026-09-22', detectedAt: '2026-09-22' }], aliases: {}, view: () => {}, changed: async () => {} }));
    assert.match(activity, />查看结果<\/button>/); assert.match(activity, /标记已处理/); assert.doesNotMatch(activity, />存入个人成果库<\/button>|加入项目资料/);
    // This role-neutral entry must not become an administrator-only label.
    const main = await fs.readFile('src/renderer/main.tsx', 'utf8');
    assert.match(main, /title="项目成果库" data-tooltip="项目成果库" aria-label="项目成果库"/);
    assert.doesNotMatch(main, /管理项目资料|我的资料（当前项目）|我的项目笔记|本地项目结论库|整理项目文档/);
    assert.doesNotMatch(main, /title="(?:团队|个人)成果库"/, 'the rail exposes a single results entry');
    assert.match(main, /title="成果整理" data-tooltip="成果整理" aria-label="打开成果整理"/);
    assert.match(main, /<h1>成果整理<\/h1>/);
  } finally { delete (globalThis as any).window; }
});

test('team project results have one name for both roles while administrative controls stay restricted', async () => {
  const { SharedContentLibrary } = await import('../src/renderer/shared-content');
  const common = { project: { id: 'p', name: '测试项目' } as Project, username: 'member', aliases: {}, aliasSaved: async () => {}, attach: async () => {}, attachSessions: [], notice: () => {}, mergeSessions: [], mergeStarted: () => {} };
  for (const admin of [false, true]) {
    const html = renderToStaticMarkup(createElement(SharedContentLibrary, { ...common, admin }));
    assert.match(html, /<h1>团队成果 · 测试项目<\/h1>/);
    assert.match(html, /aria-label="搜索团队成果"/);
    assert.doesNotMatch(html, /aria-label="团队成果内容形式"/, 'a content format filter is unnecessary in an empty library');
    assert.doesNotMatch(html, /整理项目文档|公共成果|个人成果库/);
    assert.equal(html.includes('多选语义合并'), admin);
    assert.match(html, /aria-label="团队成果类别"/);
    assert.match(html, /全部类别（0）/);
    assert.equal(html.includes('包含个人库已有成果'), admin);
    assert.doesNotMatch(html, /维护全部成果|返回差异列表|全部类型|全部标签/);
    assert.doesNotMatch(html, /团队成果操作状态|未操作|已操作|待整理|已整理/);
    const result = renderToStaticMarkup(createElement(SharedContentLibrary, { ...common, admin, resultId: 'result', returnToUpdates: () => {} }));
    assert.match(result, /<h1>动态结果 · 测试项目<\/h1>/);
    assert.doesNotMatch(result, /aria-label="搜索团队成果"|多选语义合并/);
  }
});

test('result preparation separates stored results from deletable task records', async () => {
  const { DraftTaskList } = await import('../src/renderer/draft-list');
  const common = { sessionId: 's', title: '已整理的成果', body: '', files: [], inputDir: 'test-input', outputPath: 'test-output.md', createdAt: '2026-09-22T00:00:00Z', mergeCompletedAt: '2026-09-22T00:01:00Z' };
  const drafts = [{ ...common, id: 'local', conclusionMergeProjectId: 'p' }, { ...common, id: 'team', mergeProjectId: 'p' }] as Draft[];
  const html = renderToStaticMarkup(createElement(DraftTaskList, { drafts, sessions: [], transfers: [], open: () => {}, remove: () => {} }));
  assert.match(html, /aria-label="成果整理任务列表"/);
  assert.match(html, /本地成果处理/); assert.match(html, /团队成果合并/);
  assert.match(html, /已保存到个人成果库/); assert.match(html, /已保存到团队成果库/);
  assert.equal(html.match(/成果已单独保存/g)?.length, 2);
  assert.equal(html.match(/aria-label="删除整理记录：/g)?.length, 2);
  assert.doesNotMatch(html, /项目资料处理|项目文档合并|不可删除/);
});
