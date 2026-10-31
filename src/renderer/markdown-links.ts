export type MarkdownLinkTarget = { kind: 'web' | 'file' | 'anchor'; value: string } | { kind: 'unsupported' };

// Only web URLs go to the external browser. Local paths still go through the
// session-scoped file preview checks in the main process, never shell.openExternal.
export function markdownLinkTarget(source: string | undefined): MarkdownLinkTarget {
  let value = (source || '').trim();
  if (!value || /[\x00-\x1f\x7f]/.test(value) || /^\\\\/.test(value)) return { kind: 'unsupported' };
  if (value.startsWith('#')) return { kind: 'anchor', value };
  if (/^\/\/[^/\\]/.test(value)) value = 'https:' + value;
  if (/^www\./i.test(value)) value = 'https://' + value;
  if (/^https?:/i.test(value)) {
    try {
      if (!/^https?:\/\//i.test(value) || !new URL(value).hostname) return { kind: 'unsupported' };
      return { kind: 'web', value };
    } catch { return { kind: 'unsupported' }; }
  }
  if (/^\/{2}/.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value) && !/^(file:|[a-z]:[/\\])/i.test(value)) return { kind: 'unsupported' };
  return { kind: 'file', value };
}

export function markdownHeadingSlugs(headings: string[]) {
  const used = new Set<string>();
  return headings.map(text => {
    const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
    let slug = base, suffix = 0;
    while (used.has(slug)) slug = `${base}-${++suffix}`;
    used.add(slug);
    return slug;
  });
}

export function revealMarkdownAnchor(link: HTMLElement, fragment: string) {
  const root = link.closest('.markdown');
  let id = fragment.slice(1);
  try { id = decodeURIComponent(id); } catch { /* A literal percent can occur in a heading. */ }
  // Scope lookup to this reply: other messages can have identical headings/footnotes.
  const elements = root ? [...root.querySelectorAll<HTMLElement>('[id],h1,h2,h3,h4,h5,h6')].filter(el => el.closest('.markdown') === root) : [];
  let target = id ? elements.find(el => el.id === id) : undefined;
  if (!target && id) {
    const headings = elements.filter(el => /^H[1-6]$/.test(el.tagName));
    const slugs = markdownHeadingSlugs(headings.map(el => el.textContent || ''));
    target = headings[slugs.indexOf(id)];
  }
  if (!target) throw new Error('本条回复中未找到链接对应的标题或脚注');
  if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'center' });
}
