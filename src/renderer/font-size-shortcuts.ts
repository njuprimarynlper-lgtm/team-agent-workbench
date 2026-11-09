const storageKey = 'team-agent-font-size-step';
const minimum = -4;
const maximum = 12;

function storedStep() {
  try {
    const value = Number(window.localStorage.getItem(storageKey));
    return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : 0;
  } catch { return 0; }
}

function applyStep(step: number) {
  document.documentElement.style.setProperty('--workbench-font-step', `${step}px`);
}

function direction(event: KeyboardEvent) {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return 0;
  if (event.code === 'NumpadAdd' || event.key === '+' || event.code === 'Equal') return 1;
  if (event.code === 'NumpadSubtract' || event.key === '-' || event.code === 'Minus') return -1;
  return 0;
}

export function installFontSizeShortcuts() {
  let step = storedStep();
  applyStep(step);
  window.addEventListener('keydown', event => {
    const change = direction(event);
    if (!change) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    step = Math.max(minimum, Math.min(maximum, step + change));
    applyStep(step);
    try { window.localStorage.setItem(storageKey, String(step)); } catch { /* Keep the current window usable. */ }
  }, true);
  window.addEventListener('storage', event => {
    if (event.key === storageKey) { step = storedStep(); applyStep(step); }
  });
}
