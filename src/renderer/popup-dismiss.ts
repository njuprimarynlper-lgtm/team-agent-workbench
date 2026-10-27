import { useLayoutEffect, useRef, type RefObject } from 'react';

type Popup = { root: HTMLElement; owner?: HTMLElement | null; inside: () => (Node | null | undefined)[]; close: (reason: 'outside' | 'escape' | 'other') => void; parent?: Popup };
const popups: Popup[] = [];
const contains = (popup: Popup, node: Node) => [popup.root, ...popup.inside()].some(root => root?.contains(node));
function remove(popup: Popup) { const index = popups.indexOf(popup); if (index >= 0) popups.splice(index, 1); }
function dismiss(popup: Popup, reason: 'outside' | 'escape' | 'other') { remove(popup); popup.close(reason); }
function outside(event: Event) {
  const target = event.target; if (!(target instanceof Node)) return;
  const keep = new Set<Popup>();
  for (const popup of popups) if (contains(popup, target)) for (let parent: Popup | undefined = popup; parent; parent = parent.parent) keep.add(parent);
  // Never cancel the event: the original target still receives focus and its click.
  for (const popup of [...popups].reverse()) if (!keep.has(popup)) dismiss(popup, 'outside');
}
function escape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || !popups.length) return;
  if (event.target instanceof HTMLSelectElement && event.target.matches(':open')) return;
  event.preventDefault(); event.stopImmediatePropagation();
  dismiss(popups.at(-1)!, 'escape');
}
function register(popup: Popup) {
  popup.parent = [...popups].reverse().find(other => contains(other, popup.owner || popup.root));
  const ancestors = new Set<Popup>();
  for (let parent = popup.parent; parent; parent = parent.parent) ancestors.add(parent);
  for (const other of [...popups].reverse()) if (!ancestors.has(other)) dismiss(other, 'other');
  popups.push(popup);
  if (popups.length === 1) {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
  }
  return () => {
    remove(popup);
    if (!popups.length) { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); }
  };
}

/** A popup's owner keeps portalled submenus in the same dismissal hierarchy. */
export function usePopupDismiss<T extends HTMLElement>(open: boolean, root: RefObject<T | null>, close: Popup['close'], options: { inside?: () => (Node | null | undefined)[]; owner?: () => HTMLElement | null | undefined } = {}) {
  const latest = useRef({ close, options }); latest.current = { close, options };
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    return register({ root: root.current, owner: latest.current.options.owner?.(), inside: () => latest.current.options.inside?.() || [], close: reason => latest.current.close(reason) });
  }, [open, root]);
}

export function useDetailsMenu(root: RefObject<HTMLDetailsElement | null>) {
  useLayoutEffect(() => {
    const element = root.current; if (!element) return;
    let unregister: (() => void) | undefined;
    const toggle = () => {
      unregister?.(); unregister = undefined;
      if (element.open) unregister = register({ root: element, inside: () => [], close: reason => { element.open = false; if (reason === 'escape') element.querySelector('summary')?.focus(); } });
    };
    element.addEventListener('toggle', toggle); toggle();
    return () => { element.removeEventListener('toggle', toggle); unregister?.(); };
  }, [root]);
}
