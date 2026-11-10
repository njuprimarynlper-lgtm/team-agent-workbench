import { useLayoutEffect, useRef, useState } from 'react';
import { transcriptPageSize, type TranscriptPage } from '../shared/transcript-page';
import type { AgentSession, Message, WorkbenchAPI } from '../shared/types';
import { inheritedMessageCount } from '../shared/transcript-page';

export interface InheritedTranscript {
  label?: string;
  count: number;
  read: (before: number, limit: number) => Promise<TranscriptPage>;
}

export function subsessionPages(api: WorkbenchAPI, session?: AgentSession): InheritedTranscript | undefined {
  if (!session) return;
  const count = inheritedMessageCount(session);
  if (count) return { count, read: (before, limit) => api.call('subsession.historyPage', { id: session.id, before, limit }) };
}

export function useTranscriptPages(messages: Message[], inherited: InheritedTranscript | undefined, active: boolean, readingEarlier?: () => void) {
  const [page, setPage] = useState<{ firstId?: string; before?: number; history: Message[] }>({ history: [] });
  const hidden = page.firstId ? messages.findIndex(m => m.id === page.firstId) : -1;
  const start = hidden >= 0 ? hidden : page.before !== undefined ? 0 : Math.max(0, messages.length - transcriptPageSize);
  const before = page.before ?? inherited?.count ?? 0;
  const [status, setStatus] = useState('');
  const marker = useRef<HTMLDivElement>(null), busy = useRef(false), mounted = useRef(false);
  const restore = useRef<{ element: HTMLElement; height: number; top: number } | undefined>(undefined);
  const load = useRef<(element: HTMLElement) => void>(() => {});
  load.current = async element => {
    if (busy.current || (!start && !before) || element.scrollTop > 1) return;
    busy.current = true;
    readingEarlier?.();
    const nextStart = Math.max(0, start - transcriptPageSize);
    const limit = transcriptPageSize - (start - nextStart);
    try {
      let previous: TranscriptPage | undefined;
      if (limit && inherited && before) {
        setStatus(inherited.label ? '正在读取更早消息…' : '正在读取创建时的消息…');
        previous = await inherited.read(before, limit);
      }
      if (!mounted.current) return;
      restore.current = { element, height: element.scrollHeight, top: element.scrollTop };
      setStatus('');
      setPage({ firstId: messages[nextStart]?.id, before: previous?.before ?? before, history: previous ? [...previous.messages, ...page.history] : page.history });
    } catch (error: any) {
      if (mounted.current) setStatus((error.message || '历史读取失败') + '，向上滚动重试');
      busy.current = false;
    }
  };
  useLayoutEffect(() => {
    const pending = restore.current;
    if (active && pending) {
      pending.element.scrollTop = pending.top + pending.element.scrollHeight - pending.height;
      restore.current = undefined; busy.current = false;
    }
  }, [page, active]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    const element = marker.current?.closest<HTMLElement>('[data-transcript-scroll]');
    if (!active || !element) return;
    // Only an upward input at the boundary advances a page. Initial positioning,
    // resize events and auto-following a streamed reply never start a history read.
    const wheel = (e: WheelEvent) => { if (e.deltaY < 0 && !e.ctrlKey) load.current(element); };
    let touchY: number | undefined;
    const touchStart = (e: TouchEvent) => { touchY = e.touches.length === 1 ? e.touches[0].clientY : undefined; };
    const touchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1 || touchY === undefined) return;
      const y = e.touches[0].clientY;
      if (y - touchY >= 16 && element.scrollTop <= 1) { touchY = y; load.current(element); }
      if (y < touchY || element.scrollTop > 1) touchY = y;
    };
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || (e.target as HTMLElement).closest('textarea,input,select,[contenteditable=true]')) return;
      if (['PageUp','ArrowUp','Home'].includes(e.key) && !e.altKey && !e.metaKey && !e.ctrlKey) load.current(element);
    };
    element.addEventListener('wheel', wheel, { passive: true });
    element.addEventListener('touchstart', touchStart, { passive: true });
    element.addEventListener('touchmove', touchMove, { passive: true });
    element.addEventListener('keydown', key);
    return () => {
      element.removeEventListener('wheel', wheel); element.removeEventListener('touchstart', touchStart);
      element.removeEventListener('touchmove', touchMove); element.removeEventListener('keydown', key);
    };
  }, [active]);
  return { marker, status, start, remaining: start + before, history: page.history };
}
