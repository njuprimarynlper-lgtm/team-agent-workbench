import type { Root } from 'mdast';
import type { Plugin } from 'unified';

// Two CommonMark/GFM edge cases in Chinese prose: bare URLs consume their CJK
// suffix, and a closing ** after punctuation cannot close before a Han letter.
// Reparse only the affected source spans so surrounding Markdown remains intact.
const cjkPunctuation = /[，。；：！？、（）【】《》「」『』]/u;
const cjkLetter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const strandedEmphasis = /(?<!\\)\*\*[^\n]*?[。！？；：，、]\*\*(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu;
// Make the closing delimiter right-flanking during parsing, then remove this
// invisible character from the resulting text node (and keep stored text raw).
const emphasisJoiner = '\u2060';
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; position?: { start?: { offset?: number }; end?: { offset?: number } } };
type Replacement = { start: number; end: number; text: string };

function walk(node: MarkdownNode, visit: (node: MarkdownNode, inLink: boolean) => void, inLink = false) {
  visit(node, inLink);
  for (const child of node.children || []) walk(child, visit, inLink || node.type === 'link');
}

function applyReplacements(source: string, replacements: Replacement[]) {
  return replacements.sort((a, b) => b.start - a.start).reduce((value, item) => value.slice(0, item.start) + item.text + value.slice(item.end), source);
}

function boundary(value: string) {
  const host = /^(?:https?:\/\/|www\.)[a-z\d.-]+(?::\d+)?/i.exec(value)?.[0];
  if (!host) return -1;
  try { if (!new URL(host.startsWith('www.') ? `http://${host}` : host).hostname) return -1; }
  catch { return -1; }
  for (let index = host.length; index < value.length; index++) {
    if (cjkPunctuation.test(value[index])) return index;
    if (cjkLetter.test(value[index]) && /[a-z\d]/i.test(value[index - 1])) return index;
  }
  return -1;
}

export const remarkMarkdownBoundaries: Plugin<[], Root> = function () {
  const processor = this;
  return (tree, file) => {
    let source = String(file.value), parsed: Root = tree;
    const urls: Replacement[] = [];
    walk(parsed, node => {
      if (node.type !== 'link') return;
      const start = node.position?.start?.offset, end = node.position?.end?.offset;
      if (start === undefined || end === undefined) return;
      const literal = source.slice(start, end);
      // An explicit [label](url) or <url> begins with a delimiter, not h/w.
      if (!/^(?:https?:\/\/|www\.)/i.test(literal)) return;
      const split = boundary(literal);
      if (split <= 0 || /[<>\[\]\n]/.test(literal.slice(0, split))) return;
      const prefix = literal.slice(0, split);
      urls.push({ start, end: start + split, text: prefix.startsWith('www.') ? `[${prefix}](<http://${prefix}>)` : `<${prefix}>` });
    });
    if (urls.length) {
      source = applyReplacements(source, urls);
      parsed = processor.parse(source) as Root;
    }

    const emphasis: Replacement[] = [];
    walk(parsed, (node, inLink) => {
      if (node.type !== 'text' || inLink) return;
      const start = node.position?.start?.offset, end = node.position?.end?.offset;
      if (start === undefined || end === undefined) return;
      const raw = source.slice(start, end);
      for (const match of raw.matchAll(strandedEmphasis)) {
        const closing = start + match.index + match[0].lastIndexOf('**');
        emphasis.push({ start: closing, end: closing, text: emphasisJoiner });
      }
    });
    if (emphasis.length) {
      source = applyReplacements(source, emphasis);
      parsed = processor.parse(source) as Root;
      walk(parsed, node => { if (node.type === 'text' && node.value) node.value = node.value.replaceAll(emphasisJoiner, ''); });
    }
    if (urls.length || emphasis.length) tree.children = parsed.children;
  };
};
