import { useLayoutEffect, useRef, useState } from 'react';

export function useConversationScroll(id: string | undefined, revision: unknown, active = true) {
  const ref = useRef<HTMLDivElement>(null), follows = useRef(true), previous = useRef(id);
  const [away, setAway] = useState(false);
  const latest = () => { follows.current = true; setAway(false); const el = ref.current; if (el) el.scrollTop = el.scrollHeight; };
  const onScroll = () => { const el = ref.current; if (!el) return; follows.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64; setAway(!follows.current); };
  useLayoutEffect(() => {
    if (previous.current !== id) { previous.current = id; follows.current = true; }
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    if (follows.current) latest();
    const observer = new ResizeObserver(() => { if (follows.current) latest(); });
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [id, revision, active]);
  return { ref, onScroll, away, latest };
}
