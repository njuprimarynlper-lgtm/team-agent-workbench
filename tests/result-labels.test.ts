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

test('both library filters offer only categories present in stored titles, ignoring preset metadata', () => {
  const items = [{ title: '【综合整理】A', category: 'finding' }, { title: '【部署约束】B', category: 'finding' }, { title: '【综合整理】【项目标准】C' }, { title: '无类别的记录' }];
  for (const label of ['团队成果类别', '个人成果类别']) {
    const html = renderToStaticMarkup(createElement(ResultCategoryFilter, { items, value: 'label:综合整理', label, onChange: () => {} }));
    assert.match(html, /全部类别（4）/);
    assert.match(html, /value="label:综合整理" selected="">【综合整理】（2）/);
    assert.match(html, /【部署约束】（1）/);
    assert.match(html, /【项目标准】（1）/);
    assert.match(html, /未分类（1）/);
    assert.doesNotMatch(html, /项目结论|方法探索|全部类型|全部标签/);
    assert.equal((html.match(/<option /g) || []).length, 5);
    const empty = renderToStaticMarkup(createElement(ResultCategoryFilter, { items: [], value: 'all', label, onChange: () => {} }));
    assert.match(empty, /全部类别（0）/);
    assert.equal((empty.match(/<option /g) || []).length, 1);
  }
});

test('display retains existing labels and local aliases do not invent or replace categories', () => {
  assert.equal(resultLabelTitle('【综合整理】原题'), '【综合整理】原题');
  assert.equal(resultLabelTitle('【综合整理】【验收约束】原题', '【别名标签】易读名称'), '【综合整理】【验收约束】 易读名称');
  assert.equal(resultLabelTitle('没有标签', '【别名标签】易读名称'), '易读名称');
});
