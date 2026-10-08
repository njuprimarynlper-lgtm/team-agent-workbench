import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResultCategoryFilter } from '../src/renderer/result-category-filter';
import { matchesResultLabel, resultLabels, resultLabelOptions, resultLabelTitle } from '../src/shared/result-labels';

test('result labels come from existing title prefixes, including custom and multiple labels', () => {
  assert.deepEqual(resultLabels(' 【综合整理】 【自定义标签】 【综合整理】 核对【正文引用】'), ['综合整理', '自定义标签']);
  assert.deepEqual(resultLabels('【 项目标准 】 接口规范'), ['项目标准']);
  for (const title of ['没有标签', '标题中引用【项目标准】', '【】空标签', '【缺少闭括号', '【跨\n行】正文']) assert.deepEqual(resultLabels(title), []);
  assert(matchesResultLabel('【综合整理】结果', 'label:综合整理'));
  assert(!matchesResultLabel('【综合整理】结果', 'label:项目结论'));
  assert(matchesResultLabel('没有标签', 'untagged'));
  assert(!matchesResultLabel('【无标签】这是一个真实标签', 'untagged'));
});

test('label counts are per result and a disappearing active filter stays at zero', () => {
  const items = [{ title: '【项目标准】A' }, { title: '【项目标准】【验收约束】【项目标准】B' }, { title: '【综合整理】C' }, { title: '无标签内容' }];
  const options = resultLabelOptions(items);
  assert.equal(options.find(option => option.value === 'label:项目标准')?.count, 2);
  assert.equal(options.find(option => option.value === 'label:验收约束')?.count, 1);
  assert.equal(options.find(option => option.value === 'untagged')?.count, 1);
  assert.deepEqual(resultLabelOptions([], 'label:综合整理'), [{ value: 'label:综合整理', label: '【综合整理】', count: 0 }]);
  assert.deepEqual(resultLabelOptions([], 'untagged'), [{ value: 'untagged', label: '未分类', count: 0 }]);
});

test('both libraries expose five stable categories and metadata takes precedence over title labels', () => {
  const items = [{ title: '【已有能力】A', category: 'finding' }, { title: '【部署约束】B', category: 'todo' }, { title: '【项目标准】C' }, { title: '无类别的记录' }];
  const original = structuredClone(items);
  for (const label of ['团队成果类别', '个人成果类别']) {
    const html = renderToStaticMarkup(createElement(ResultCategoryFilter, { items, value: 'exploration', label, onChange: () => {} }));
    assert.match(html, /aria-pressed="true">探索记录<span>2<\/span>/);
    assert.match(html, /项目目标<span>1<\/span>/);
    assert.match(html, /项目资料<span>0<\/span>/);
    assert.match(html, /已有能力<span>0<\/span>/);
    assert.match(html, /待办事项<span>1<\/span>/);
    assert.doesNotMatch(html, /项目结论|项目经验|方法探索|全部类型|全部标签/);
    assert.equal((html.match(/<button /g) || []).length, 6);
    const empty = renderToStaticMarkup(createElement(ResultCategoryFilter, { items: [], value: 'all', label, onChange: () => {} }));
    assert.equal((empty.match(/<span>0<\/span>/g) || []).length, 6);
    assert.match(empty, /aria-pressed="true">全部<span>0<\/span><\/button>/);
  }
  assert.deepEqual(items, original);
});

test('display retains existing labels and local aliases do not invent or replace categories', () => {
  assert.equal(resultLabelTitle('【综合整理】原题'), '【综合整理】原题');
  assert.equal(resultLabelTitle('【综合整理】【验收约束】原题', '【别名标签】易读名称'), '【综合整理】【验收约束】 易读名称');
  assert.equal(resultLabelTitle('没有标签', '【别名标签】易读名称'), '易读名称');
});

test('legacy findings display and filter as project experience without rewriting stored titles', () => {
  const items = [{ title: '【项目结论】旧经验' }, { title: '【项目经验】新经验' }, { title: '【项目结论】【项目经验】【性能】同条多标签' }];
  const original = structuredClone(items);
  assert.deepEqual(resultLabels(items[2].title), ['项目经验', '性能']);
  for (const filter of ['label:项目结论', 'label:项目经验']) {
    assert(items.every(item => matchesResultLabel(item.title, filter)));
    assert.equal(matchesResultLabel('【性能】测试', filter), false);
    const options = resultLabelOptions(items, filter);
    assert.deepEqual(options.find(option => option.value === 'label:项目经验'), { value: 'label:项目经验', label: '【项目经验】', count: 3 });
    assert.equal(options.some(option => option.value === 'label:项目结论'), false);
    const html = renderToStaticMarkup(createElement(ResultCategoryFilter, { items, value: 'exploration', label: '成果类别', onChange: () => {} }));
    assert.match(html, /aria-pressed="true">探索记录<span>3<\/span>/);
    assert.doesNotMatch(html, /项目结论/);
  }
  assert.deepEqual(resultLabelOptions([], 'label:项目结论'), [{ value: 'label:项目经验', label: '【项目经验】', count: 0 }]);
  assert.equal(resultLabelTitle('【 项目结论 】【性能】 原标题'), '【项目经验】【性能】 原标题');
  assert.equal(resultLabelTitle('【项目结论】【性能】 原标题', '【别名标签】我的名称'), '【项目经验】【性能】 我的名称');
  assert.equal(resultLabelTitle('【性能】 标题引用【项目结论】'), '【性能】 标题引用【项目结论】');
  assert.deepEqual(items, original);
});
