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

test('a prose dash after a bare URL remains text rather than part of the clickable address', () => {
  for (const url of [
    'https://example.com', 'https://example.com/report', 'http://localhost:3000/report',
    'https://example.com/a-b?q=a-b#part-1', 'https://example.com/中文路径', 'www.example.com/report',
  ]) for (const dash of ['——', '—', '–']) {
    const html = renderToStaticMarkup(React.createElement(Markdown, { text: `${url}${dash}这是说明文字`, conversation: true }));
    const expected = new URL(url.startsWith('www.') ? `http://${url}` : url).href;
    const href = /<a\b[^>]*href="([^"]+)"/.exec(html)?.[1];
    // Preserve the original bare host spelling (the browser supplies its trailing slash).
    assert.equal(new URL(href!).href, expected, html);
    assert.equal((html.match(/<a\b/g) || []).length, 1, html);
    assert.match(html, new RegExp(`</a>${dash}这是说明文字`));
    assert.doesNotMatch(html, /<a\b[^>]*>[\s\S]*这是说明文字[\s\S]*<\/a>/);
  }
});

test('dash separation preserves adjacent formatting, multiple URLs, code and explicitly delimited addresses', () => {
  const render = (text: string) => renderToStaticMarkup(React.createElement(Markdown, { text, conversation: true }));
  const mixed = render('https://example.com/a——**第一项**；https://example.com/b——第二项');
  assert.equal((mixed.match(/<a\b/g) || []).length, 2);
  assert.match(mixed, /<\/a>——<strong>第一项<\/strong>/);
  assert.match(mixed, /<\/a>——第二项/);
  const explicit = render('[网址——说明](https://example.com/a——b) <https://example.com/a——b>');
  assert.equal((explicit.match(/href="https:\/\/example.com\/a%E2%80%94%E2%80%94b"/g) || []).length, 2);
  assert.match(explicit, />网址——说明</);
  const code = render('`https://example.com——说明`\n\n```text\nhttps://example.com——说明\n```');
  assert.equal((code.match(/<a\b/g) || []).length, 0);
  const ascii = render('https://example.com/a--b?q=part-1#section-2');
  assert.match(ascii, /href="https:\/\/example.com\/a--b\?q=part-1#section-2"/);
});
