import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { preparationDirectionsSchema, selectedPreparationDirections } from '../src/shared/preparation-directions';
import { preparationPrompt } from '../src/core/preparation-prompt';
import { contributionCategoryInfo } from '../src/shared/content';
import type { MaterialCategory } from '../src/shared/result-rules';
import type { AgentSession, Draft } from '../src/shared/types';

test('directions trim whitespace without losing paragraphs, ignore unselected categories and validate input', () => {
  for (const blank of ['', ' ', '\t', '\r\n', ' \t\n\r ', '\u3000\u00a0']) {
    assert.deepEqual(selectedPreparationDirections(['finding'], { finding: blank }), {});
  }
  const input = { finding: ' \t保留验证边界\n\n略过重复信息\r\n ', issue: '不应传入' };
  assert.deepEqual(selectedPreparationDirections(['finding'], input), { finding: '保留验证边界\n\n略过重复信息' });
  assert.equal(input.finding, ' \t保留验证边界\n\n略过重复信息\r\n ');
  assert.deepEqual(selectedPreparationDirections(['finding'], undefined), {});
  assert.equal(preparationDirectionsSchema.safeParse({ finding: '字'.repeat(4001) }).success, false);
  assert.equal(preparationDirectionsSchema.safeParse({ finding: 123 }).success, false);
  assert.equal(preparationDirectionsSchema.safeParse({ unknown: '不支持的类别' }).success, false);
});

test('blank directions leave the default prompt unchanged; custom directions apply only to selected categories and never to merges', () => {
  const draft = { inputDir: '/frozen', resultRules: { contract: 3, combinationId: 'research', name: '算法研究', categories: ['finding', 'project_standard'] } } as Draft;
  const original = preparationPrompt(draft, []), merge = preparationPrompt(draft, [], true);
  draft.preparationDirections = { finding: ' \t\r\n ', project_standard: '\u3000', issue: '未勾选的方向' };
  assert.equal(preparationPrompt(draft, []), original);
  draft.preparationDirections.finding = ' \t重点解释性能的适用条件\n保留尚未验证的范围 ';
  const prompt = preparationPrompt(draft, []);
  assert(prompt.includes(JSON.stringify({ finding: '重点解释性能的适用条件\n保留尚未验证的范围' })));
  assert(!prompt.includes('未勾选的方向'));
  assert(prompt.includes('未提供方向的类别使用默认提示词'));
  assert(prompt.includes('不得为了满足方向编造材料中没有的信息'));
  assert.equal(preparationPrompt(draft, [], true), merge);
});

test('category controls expose one multiline field per checked category, with defaults and reorganization directions', async () => {
  // Renderer modules capture the bridge on import; this test does not launch a desktop.
  const previous = (globalThis as any).window;
  (globalThis as any).window = { workbench: {} };
  try {
    const { PreparationCategoryChoices, PreparationOptionsModal } = await import('../src/renderer/preparation-options');
    const categories: MaterialCategory[] = ['finding', 'project_standard', 'issue'];
    const directions = { finding: '关注精度与性能边界', issue: '保留未解决的阻塞项' };
    const render = (selected: MaterialCategory[]) => renderToStaticMarkup(createElement(PreparationCategoryChoices, { categories, selected, directions, disabled: false, select: () => {}, changeDirection: () => {} }));
    const html = render(['finding', 'project_standard']);
    assert.equal((html.match(/type="checkbox"/g) || []).length, 3);
    assert.equal((html.match(/<textarea /g) || []).length, 2);
    assert(html.includes('rows="3"'));
    assert(html.includes(`aria-label="${contributionCategoryInfo.finding.label}的整理方向"`));
    assert(html.includes('关注精度与性能边界'));
    assert(html.includes('留空使用默认提示词'));
    assert(!html.includes('保留未解决的阻塞项'));
    assert(render(['issue']).includes('保留未解决的阻塞项'));
    assert(!render([]).includes('<textarea'));
    const again = renderToStaticMarkup(createElement(PreparationOptionsModal, {
      session: { id: 'session', title: '会话', messages: [] } as unknown as AgentSession,
      combination: { id: 'research', name: '算法研究', categories }, initialDirections: directions, again: true, close: () => {}, started: async () => {},
    }));
    assert(again.includes('再次整理成果'));
    assert(again.includes('关注精度与性能边界'));
    assert(again.includes('保留未解决的阻塞项'));
  } finally { (globalThis as any).window = previous; }
});
