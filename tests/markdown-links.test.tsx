import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/renderer/markdown';
import { markdownHeadingSlugs, markdownLinkTarget } from '../src/renderer/markdown-links';

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

test('link routing distinguishes web addresses, local files and reply anchors', () => {
  for (const value of ['https://example.com/report', 'http://localhost:3000/a?q=1#part', 'HTTPS://example.com']) {
    assert.deepEqual(markdownLinkTarget(value), { kind: 'web', value });
  }
  assert.deepEqual(markdownLinkTarget('//example.com/a'), { kind: 'web', value: 'https://example.com/a' });
  assert.deepEqual(markdownLinkTarget('www.example.com/a'), { kind: 'web', value: 'https://www.example.com/a' });
  for (const value of ['report.md', './www.example.com/report.md', '../report.md', '/tmp/report.md', 'C:/项目/报告.md:12', 'C:\\项目\\报告.md', '/C:/项目/报告.md', 'file:///C:/report.md', 'docs/report.md#L12', 'docs/%E6%8A%A5%E5%91%8A.md#L12-L14']) {
    assert.deepEqual(markdownLinkTarget(value), { kind: 'file', value });
  }
  for (const value of ['#heading', '#%E6%A0%87%E9%A2%98', '#user-content-fn-1']) {
    assert.deepEqual(markdownLinkTarget(value), { kind: 'anchor', value });
  }
});

test('unsupported and malformed links cannot become external browser URLs', () => {
  for (const value of [undefined, '', ' ', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,test', 'mailto:a@example.com', 'vscode://file/C:/test.md', 'sandbox:/mnt/data/report.md', 'https://', 'https:example.com', 'https://[invalid', '///server/share', '\\\\server\\share', 'java\tscript:alert(1)', 'a\u0000.md']) {
    assert.equal(markdownLinkTarget(value).kind, 'unsupported', String(value));
  }
  const html = renderToStaticMarkup(React.createElement(Markdown, { text: '[危险](javascript:alert%281%29) [数据](data:text/html,test) [空]()' }));
  assert.doesNotMatch(html, /href=|javascript:|data:text/);
  assert.equal((html.match(/<button\b/g) || []).length, 3, html);
  assert.match(html, /不受支持/);
});

test('heading fragments retain Chinese and code text, and disambiguate duplicate headings', () => {
  assert.deepEqual(markdownHeadingSlugs(['测试标题', '测试标题', 'Hello, World!', 'Hello, World!', 'Hello World-1', '使用 foo_bar.ts', 'Résumé']),
    ['测试标题', '测试标题-1', 'hello-world', 'hello-world-1', 'hello-world-1-1', '使用-foo_barts', 'résumé']);
});

test('footnote link IDs and accessibility attributes survive custom link rendering', () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, { text: '说明[^1]\n\n[^1]: 详情。' }));
  assert.match(html, /id="user-content-fnref-1"/);
  assert.match(html, /data-footnote-ref="true"/);
  assert.match(html, /aria-describedby="footnote-label"/);
  assert.match(html, /href="#user-content-fn-1"/);
  assert.match(html, /href="#user-content-fnref-1"/);
});
