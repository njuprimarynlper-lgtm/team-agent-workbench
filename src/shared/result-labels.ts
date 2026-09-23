// Labels are the existing leading 【...】 blocks, including custom labels.
// Text quoted later in a title is not a category, and aliases do not reclassify it.
const labelPrefix = /^(?:\s*【[^【】\r\n]+】)+\s*/u;
export function resultLabels(title: string): string[] {
  const prefix = title.match(labelPrefix)?.[0] || '';
  return [...new Set([...prefix.matchAll(/【([^【】\r\n]+)】/gu)].map(match => match[1].trim()).filter(Boolean))];
}
export function matchesResultLabel(title: string, filter: string) {
  const labels = resultLabels(title);
  return filter === 'all' || (filter === 'untagged' ? !labels.length : labels.includes(filter.slice('label:'.length)) && filter.startsWith('label:'));
}
export function resultLabelOptions(items: { title: string }[], selected = 'all') {
  const counts = new Map<string, number>(); let untagged = 0;
  for (const item of items) {
    const labels = resultLabels(item.title);
    if (!labels.length) untagged++;
    for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1);
  }
  // Keep a selected label at zero after import/deletion instead of silently
  // broadening the user's selection to unrelated results.
  if (selected.startsWith('label:') && !counts.has(selected.slice(6))) counts.set(selected.slice(6), 0);
  const options = [...counts].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([label, count]) => ({ value: 'label:' + label, label: `【${label}】`, count }));
  if (untagged || selected === 'untagged') options.push({ value: 'untagged', label: '未分类', count: untagged });
  return options;
}
export function resultLabelTitle(title: string, alias?: string) {
  if (!alias?.trim()) return title.trim();
  const prefix = resultLabels(title).map(label => `【${label}】`).join('');
  const subject = alias.trim().replace(labelPrefix, '').trim();
  return [prefix, subject].filter(Boolean).join(' ') || title.trim();
}
