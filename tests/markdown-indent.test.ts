import assert from 'node:assert/strict';
import test from 'node:test';
import { indentMarkdown } from '../src/renderer/markdown-indent';

function apply(value: string, start: number, end = start, reverse = false) {
  const edit = indentMarkdown(value, start, end, reverse);
  return { value: value.slice(0, edit.from) + edit.text + value.slice(edit.to), start: edit.start, end: edit.end };
}
test('Tab inserts at caret and indents all selected lines without including next line', () => {
  assert.deepEqual(apply('abc', 1), { value: 'a\tbc', start: 2, end: 2 });
  assert.deepEqual(apply('one\ntwo\nthree', 0, 8), { value: '\tone\n\ttwo\nthree', start: 1, end: 10 });
  assert.deepEqual(apply('\nline', 0, 1), { value: '\t\nline', start: 1, end: 2 });
});
test('Shift+Tab removes one indentation level and keeps selections on text', () => {
  assert.deepEqual(apply('\tone\n    two\nthree', 1, 13, true), { value: 'one\ntwo\nthree', start: 0, end: 8 });
  assert.deepEqual(apply('  one', 1, 1, true), { value: 'one', start: 0, end: 0 });
  assert.deepEqual(apply('one\n\nthree', 4, 5, true), { value: 'one\n\nthree', start: 4, end: 5 });
  assert.deepEqual(apply('\t', 0, 0, true), { value: '', start: 0, end: 0 });
});
