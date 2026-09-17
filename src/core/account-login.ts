import { createHash } from 'node:crypto';

// Keep existing managed Linux accounts unchanged. Extended names are display/login
// aliases; use the same deterministic mapping as server/admin.py for SSH auth.
export function systemUsername(username: string): string {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(username) ? username
    : 'wbu_' + createHash('sha256').update(username, 'utf8').digest('hex').slice(0, 28);
}
