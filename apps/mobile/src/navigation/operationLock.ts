/** Notify navigation synchronously, including before React has rendered the busy state. */
export async function runWithNavigationLock(
  lock: { current: boolean },
  onBusyChange: (busy: boolean) => void,
  action: () => Promise<void>,
): Promise<void> {
  if (lock.current) return;
  lock.current = true;
  onBusyChange(true);
  try { await action(); }
  finally { lock.current = false; onBusyChange(false); }
}
