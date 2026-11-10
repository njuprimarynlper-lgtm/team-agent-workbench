import { useLayoutEffect, useRef, useState } from 'react';
import { inheritedMessageCount, sessionMessageCount, transcriptPageSize, type TranscriptPage } from '../shared/transcript-page';
import type { AgentSession, Message, WorkbenchAPI } from '../shared/types';

export interface InheritedTranscript {
  label?: string;
  count: number;
  parentCount?: number;
  read: (before: number, limit: number) => Promise<TranscriptPage>;
}

export function sessionTranscriptPages(api: WorkbenchAPI, session?: AgentSession): InheritedTranscript | undefined {
  if (!session) return;
  const parentCount = inheritedMessageCount(session);
  const count = parentCount + sessionMessageCount(session) - session.messages.length;
  if (count) return { count, parentCount, read: (before, limit) => api.call('session.transcriptPage', { id: session.id, before, limit }) };
}

const maxWindow = transcriptPageSize * 3;
type WindowPage = { start: number; end: number; history: Message[]; following: boolean };
type Anchor = { element: HTMLElement; id?: string; top: number; height: number; scrollTop: number };

function captureAnchor(element: HTMLElement): Anchor {
  const top = element.getBoundingClientRect().top;
  const visible = [...element.querySelectorAll<HTMLElement>('[data-transcript-anchor]')].find(row => row.getBoundingClientRect().bottom > top + 4);
  return { element, id: visible?.dataset.transcriptAnchor, top: visible?.getBoundingClientRect().top ?? top, height: element.scrollHeight, scrollTop: element.scrollTop };
}

/** Keep only nearby messages mounted. The prefix reader may be frozen parent
 * history or older messages from the current session. */
export function useTranscriptPages(messages: Message[], inherited: InheritedTranscript | undefined, active: boolean, readingEarlier?: () => void) {
  const prefix = inherited?.count ?? 0, total = prefix + messages.length;
  const [page, setPage] = useState<WindowPage>(() => ({ start: prefix + Math.max(0, messages.length - transcriptPageSize), end: total, history: [], following: true }));
  const current = page.following ? { start: prefix + Math.max(0, messages.length - transcriptPageSize), end: total, history: [] as Message[], following: true } : page;
  const start = Math.min(current.start, total), end = Math.min(Math.max(current.end, start), total);
  const [status, setStatus] = useState('');
  const marker = useRef<HTMLDivElement>(null), bottomMarker = useRef<HTMLDivElement>(null);
  const busy = useRef(false), mounted = useRef(false), restore = useRef<Anchor | undefined>(undefined);
  const load = useRef<(element: HTMLElement, direction: 'up' | 'down') => void>(() => {});
  const lastTop = useRef(0);
  const previousTail = useRef({ prefix, messages });

  useLayoutEffect(() => {
    const previous = previousTail.current;
    previousTail.current = { prefix, messages };
    if (page.following) return;
    if (prefix < previous.prefix || total < page.end) {
      setPage({ start: prefix + Math.max(0, messages.length - transcriptPageSize), end: total, history: [], following: true });
      return;
    }
    if (prefix === previous.prefix) return;
    // A new message can push the first item out of the snapshot's tail while
    // the reader is looking at older rows. Carry that item into the window.
    const from = Math.max(page.start, previous.prefix), to = Math.min(page.end, prefix);
    if (to <= from) return;
    const leaving = previous.messages.slice(from - previous.prefix, to - previous.prefix);
    if (leaving.length === to - from) {
      setPage(value => value === page ? { ...value, history: [...value.history, ...leaving] } : value);
    } else if (inherited) {
      // A burst larger than one tail page can outpace the carry. Reload only
      // the visible prefix; the renderer still holds at most one window.
      void (async () => {
        const history: Message[] = [];
        let before = Math.min(prefix, page.end);
        try {
          while (before > page.start) {
            const part = await inherited.read(before, Math.min(transcriptPageSize, before - page.start));
            if (part.before >= before || part.messages.length !== before - part.before) throw new Error('历史分页位置已改变');
            history.unshift(...part.messages); before = part.before;
          }
          if (mounted.current) setPage(value => value === page ? { ...value, history } : value);
        } catch (error: any) { if (mounted.current) setStatus(error.message || '历史读取失败'); }
      })();
    }
  }, [prefix, total, messages]);

  load.current = async (element, direction) => {
    if (busy.current || direction === 'up' && (!start || element.scrollTop > 1) || direction === 'down' && (end >= total || element.scrollHeight - element.scrollTop - element.clientHeight > 1)) return;
    busy.current = true;
    if (direction === 'up') readingEarlier?.();
    const nextStart = direction === 'up' ? Math.max(0, start - transcriptPageSize) : Math.max(start, Math.min(total, end + transcriptPageSize) - maxWindow);
    const nextEnd = direction === 'up' ? Math.min(end, nextStart + maxWindow) : Math.min(total, end + transcriptPageSize);
    try {
      const history: Message[] = [];
      if (inherited && nextStart < prefix) {
        setStatus('正在读取更早消息…');
        let before = Math.min(prefix, nextEnd);
        while (before > nextStart) {
          const part = await inherited.read(before, Math.min(transcriptPageSize, before - nextStart));
          if (part.before >= before || part.messages.length !== before - part.before) throw new Error('历史分页位置已改变，请重新打开会话');
          history.unshift(...part.messages);
          before = part.before;
        }
      }
      if (!mounted.current) return;
      restore.current = captureAnchor(element);
      setStatus('');
      setPage({ start: nextStart, end: nextEnd, history, following: false });
    } catch (error: any) {
      if (mounted.current) setStatus((error.message || '历史读取失败') + (direction === 'up' ? '，向上滚动重试' : '，向下滚动重试'));
      busy.current = false;
    }
  };

  useLayoutEffect(() => {
    const pending = restore.current;
    if (!active || !pending) return;
    const row = [...pending.element.querySelectorAll<HTMLElement>('[data-transcript-anchor]')].find(item => item.dataset.transcriptAnchor === pending.id);
    pending.element.scrollTop = row ? pending.scrollTop + row.getBoundingClientRect().top - pending.top : pending.scrollTop + pending.element.scrollHeight - pending.height;
    lastTop.current = pending.element.scrollTop;
    restore.current = undefined;
    busy.current = false;
  }, [page, active]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    const element = marker.current?.closest<HTMLElement>('[data-transcript-scroll]');
    if (!active || !element) return;
    const latest = () => {
      busy.current = false;
      restore.current = undefined;
      setStatus('');
      setPage({ start: prefix + Math.max(0, messages.length - transcriptPageSize), end: total, history: [], following: true });
    };
    const scroll = () => {
      if (busy.current) return;
      const top = element.scrollTop, bottom = element.scrollHeight - top - element.clientHeight;
      if (bottom > 64 && current.following) setPage({ start, end, history: current.history, following: false });
      if (bottom < 2 && end === total && !current.following) latest();
      else if (top < 2 && top < lastTop.current - 1) load.current(element, 'up');
      else if (bottom < 2 && top > lastTop.current + 1) load.current(element, 'down');
      lastTop.current = top;
    };
    const wheel = (event: WheelEvent) => { if (!event.ctrlKey && event.deltaY < 0) load.current(element, 'up'); else if (!event.ctrlKey && event.deltaY > 0) load.current(element, 'down'); };
    let touchY: number | undefined;
    const touchStart = (event: TouchEvent) => { touchY = event.touches.length === 1 ? event.touches[0].clientY : undefined; };
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1 || touchY === undefined) return;
      const y = event.touches[0].clientY;
      if (Math.abs(y - touchY) >= 16) { load.current(element, y > touchY ? 'up' : 'down'); touchY = y; }
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target as HTMLElement).closest('textarea,input,select,[contenteditable=true]') || event.altKey || event.metaKey || event.ctrlKey) return;
      if (['PageUp', 'ArrowUp', 'Home'].includes(event.key)) load.current(element, 'up');
      if (['PageDown', 'ArrowDown', 'End'].includes(event.key)) load.current(element, 'down');
    };
    element.addEventListener('scroll', scroll, { passive: true });
    element.addEventListener('workbench:transcript-latest', latest);
    element.addEventListener('wheel', wheel, { passive: true });
    element.addEventListener('touchstart', touchStart, { passive: true });
    element.addEventListener('touchmove', touchMove, { passive: true });
    element.addEventListener('keydown', key);
    return () => {
      element.removeEventListener('scroll', scroll); element.removeEventListener('workbench:transcript-latest', latest);
      element.removeEventListener('wheel', wheel); element.removeEventListener('touchstart', touchStart);
      element.removeEventListener('touchmove', touchMove); element.removeEventListener('keydown', key);
    };
  }, [active, start, end, total, current.following, current.history, prefix]);
  return { marker, bottomMarker, status, start: Math.max(0, start - prefix), end: Math.max(0, end - prefix), historyStart: start, remaining: start, newer: total - end, history: current.history };
}
