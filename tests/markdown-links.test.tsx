import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/renderer/markdown';

test('a bare URL in a sent conversation message only links the URL', () => {
  for (const text of [
    '请查看 https://example.com/report 然后告诉我结论。',
    '请查看\nhttps://example.com/report\n然后告诉我结论。',
    '请查看 https://example.com/report，之后继续分析。',
    '请查看 https://example.com中文说明。',
    '请查看 https://example.com/中文路径，之后继续分析。',
    '请查看 http://localhost:3000，之后继续分析。',
    '请查看 www.example.com，之后继续分析。',
  ]) {
    const html = renderToStaticMarkup(React.createElement(Markdown, { text, conversation: true }));
    assert.equal((html.match(/<a\b/g) || []).length, 1, html);
    assert.match(html, /请查看/);
    assert.match(html, /然后告诉我结论|之后继续分析|中文说明/);
    assert.doesNotMatch(html, /<a[^>]*>[^<]*请查看/);
    assert.doesNotMatch(html, /<a[^>]*>[^<]*(然后告诉我结论|之后继续分析|中文说明)/);
  }
});

test('explicit links, Unicode URL paths, code and URL-adjacent emphasis keep their meaning', () => {
  const explicit = renderToStaticMarkup(React.createElement(Markdown, { text: '[https://example.com/report，说明](https://example.com/report)；<https://example.com/中文路径>' }));
  assert.match(explicit, /<a[^>]*>https:\/\/example.com\/report，说明/);
  assert.match(explicit, /href="https:\/\/example.com\/%E4%B8%AD%E6%96%87%E8%B7%AF%E5%BE%84"/);
  const unicode = renderToStaticMarkup(React.createElement(Markdown, { text: '查看 https://example.com/中文路径，之后继续分析。' }));
  assert.match(unicode, /href="https:\/\/example.com\/%E4%B8%AD%E6%96%87%E8%B7%AF%E5%BE%84"/);
  assert.doesNotMatch(unicode, /<a[^>]*>[^<]*之后继续分析/);
  const mixed = renderToStaticMarkup(React.createElement(Markdown, { text: '参考 https://example.com，**目前还不能判断为“已能部署完整 ADI 平台”。**四个仓库已覆盖主要后端业务。' }));
  assert.match(mixed, /<a[^>]*>https:\/\/example.com/);
  assert.match(mixed, /<strong>目前还不能判断为“已能部署完整 ADI 平台”。<\/strong>四个仓库已覆盖主要后端业务。/);
  const code = renderToStaticMarkup(React.createElement(Markdown, { text: '`https://example.com，说明`\n\n```text\nhttps://example.com，说明\n```' }));
  assert.equal((code.match(/<a\b/g) || []).length, 0);
  assert.match(code, /https:\/\/example.com，说明/);
});
