export interface TextEdit { from: number; to: number; text: string; start: number; end: number }
/** Keep selection boundaries on the original text, including a selection ending at the next line. */
export function indentMarkdown(value: string, start: number, end: number, reverse = false): TextEdit {
  const first = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  if (!reverse && start === end) return { from: start, to: end, text: '\t', start: start + 1, end: start + 1 };
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const lineEnd = value.indexOf('\n', last), to = lineEnd < 0 ? value.length : lineEnd;
  const lines = value.slice(first, to).split('\n');
  let offset = first;
  const changes = lines.map(line => {
    const removed = reverse ? (line.startsWith('\t') ? 1 : /^ {1,4}/.exec(line)?.[0].length || 0) : 0;
    const item = { at: offset, removed, added: reverse ? 0 : 1 }; offset += line.length + 1; return item;
  });
  const map = (position: number) => position + changes.reduce((delta, item) => position < item.at ? delta : delta + item.added - Math.min(item.removed, position - item.at), 0);
  return { from: first, to, text: lines.map((line, index) => reverse ? line.slice(changes[index].removed) : '\t' + line).join('\n'), start: map(start), end: map(end) };
}
