import { createHash } from 'node:crypto';
// Mirrors group_slug() in server/admin.py: a local name that already obeys the Linux
// rule stays byte-identical, anything else (including Chinese) derives a stable suffix.
export function groupSlug(label: string): string {
  const name = label.normalize('NFC');
  return /^[a-z][a-z0-9_-]{0,13}$/.test(name) ? name : 'g' + createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 13);
}
