import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { subsessionParentId, subsessionSiblings } from '../shared/subsessions';
import { SubsessionChat } from './subsession-chat';
import { SessionStatusIndicator } from './session-status';

// Keep the switcher mounted while each chat owns its own transient send state.
export function SubsessionWorkspace(props: React.ComponentProps<typeof SubsessionChat>) {
  const { session, sessions, open } = props;
  const siblings = session && !session.closedAt ? subsessionSiblings(sessions, session) : [];
  const parent = session && sessions.find(value => value.id === subsessionParentId(session));
  const track = useRef<HTMLDivElement>(null), selected = useRef<HTMLButtonElement>(null);
  const [overflow, setOverflow] = useState({ before: false, after: false });
  const id = useId(), panelId = id + '-panel', activeTabId = id + '-' + session?.id;
  const measure = () => {
    const el = track.current;
    const host = el?.parentElement, style = host && getComputedStyle(host);
    const fullWidth = host && style ? host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) : 0;
    const needsScroll = !!el && el.scrollWidth > fullWidth + 1;
    if (el && !needsScroll) el.scrollLeft = 0;
    const next = { before: needsScroll && el!.scrollLeft > 1, after: needsScroll && el!.scrollWidth - el!.clientWidth - el!.scrollLeft > 1 };
    setOverflow(old => old.before === next.before && old.after === next.after ? old : next);
  };
  const reveal = (button = selected.current) => {
    const el = track.current; if (!el || !button) return;
    const bounds = el.getBoundingClientRect(), tab = button.getBoundingClientRect();
    if (tab.left < bounds.left) el.scrollLeft -= bounds.left - tab.left;
    else if (tab.right > bounds.right) el.scrollLeft += tab.right - bounds.right;
    measure();
  };
  const revision = siblings.map(value => value.id + ':' + value.title + ':' + value.status).join('|');
  useLayoutEffect(() => {
    reveal(); const el = track.current; if (!el) return;
    const observer = new ResizeObserver(() => { reveal(); }); observer.observe(el);
    return () => observer.disconnect();
  }, [session?.id, revision]);
  const scroll = (direction: number) => { const el = track.current; if (el) { el.scrollLeft += direction * Math.max(100, el.clientWidth * .7); measure(); } };
  const hasTabs = !!siblings.length;
  return <div className="subsession-workspace">
    {hasTabs && <div className="subsession-switcher">
      {(overflow.before || overflow.after) && <button className="subsession-scroll" type="button" aria-label="查看前面的子会话" disabled={!overflow.before} onClick={() => scroll(-1)}><ChevronLeft size={14}/></button>}
      <div className="subsession-tabs" ref={track} role="tablist" aria-label={parent ? `父会话「${parent.title}」的子会话` : '同级子会话'} onScroll={measure}>
        {siblings.map((child, index) => <button type="button" role="tab" key={child.id} id={id + '-' + child.id} aria-controls={panelId} aria-selected={child.id === session?.id} tabIndex={child.id === session?.id ? 0 : -1} ref={child.id === session?.id ? selected : undefined} title={child.title} onClick={() => open(child)} onKeyDown={event => {
          const target = event.key === 'ArrowRight' ? (index + 1) % siblings.length : event.key === 'ArrowLeft' ? (index + siblings.length - 1) % siblings.length : event.key === 'Home' ? 0 : event.key === 'End' ? siblings.length - 1 : undefined;
          if (target === undefined) return; event.preventDefault();
          const button = track.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target];
          button?.focus({ preventScroll: true }); reveal(button); open(siblings[target]);
        }}><span className="subsession-tab-title">{child.title}</span><SessionStatusIndicator session={child}/></button>)}
      </div>
      {(overflow.before || overflow.after) && <button className="subsession-scroll" type="button" aria-label="查看后面的子会话" disabled={!overflow.after} onClick={() => scroll(1)}><ChevronRight size={14}/></button>}
    </div>}
    <div className="subsession-workspace-body" role={hasTabs ? 'tabpanel' : undefined} id={panelId} aria-labelledby={hasTabs ? activeTabId : undefined}>
      <SubsessionChat key={session?.id || 'empty'} {...props}/>
    </div>
  </div>;
}
