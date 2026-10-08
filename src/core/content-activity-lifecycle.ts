import type { ContentUpdate } from '../shared/types';

export function invalidateContentActivities(inbox: ContentUpdate[], key: string, contentId: string, at: string) {
  let changed = false;
  for (const event of inbox) {
    if (!event.eventId.startsWith(key + ':') || event.id !== contentId || event.change === 'deleted') continue;
    if (!event.unavailableAt) { event.unavailableAt = at; changed = true; }
    if (!event.readAt) { event.readAt = at; event.statusChangedAt = at; event.archiveReason = 'content_deleted'; changed = true; }
  }
  return changed;
}
