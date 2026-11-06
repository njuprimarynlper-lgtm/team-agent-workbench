/** Collapse overlapping state events into one follow-up snapshot read. */
export function createSnapshotRefresh<T>(read: () => Promise<T>, apply: (value: T) => void, failed: (error: unknown) => void) {
  let requested = 0, completed = 0, active = false;
  const waiters: { target: number; resolve: () => void }[] = [];
  const pump = async () => {
    if (active) return;
    active = true;
    try {
      while (completed < requested) {
        const batch = requested;
        try { apply(await read()); }
        catch (error) { failed(error); }
        completed = batch;
        for (let index = waiters.length - 1; index >= 0; index--) {
          if (waiters[index].target <= completed) waiters.splice(index, 1)[0].resolve();
        }
      }
    } finally { active = false; }
  };
  return (): Promise<void> => {
    const target = ++requested;
    const done = new Promise<void>(resolve => waiters.push({ target, resolve }));
    void pump();
    return done;
  };
}

/** Limit background state reads when a running agent emits frequent updates. */
export function createStateEventRefresh(refresh: () => Promise<void>, intervalMs = 250) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextAt = 0;
  const request = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      nextAt = Date.now() + intervalMs;
      void refresh();
    }, Math.max(0, nextAt - Date.now()));
  };
  return { request, cancel: () => { if (timer) clearTimeout(timer); timer = undefined; } };
}
