type MotionSource = {
  getCurrent: () => Promise<boolean>;
  subscribe: (listener: (reduced: boolean) => void) => () => void;
  onChange: (reduced: boolean) => void;
};

/** Default to no motion until Android's preference is known. Live changes win over a delayed read. */
export function observeReducedMotion({ getCurrent, subscribe, onChange }: MotionSource): () => void {
  let active = true;
  let receivedEvent = false;
  onChange(true);
  const unsubscribe = subscribe(reduced => {
    if (!active) return;
    receivedEvent = true;
    onChange(reduced);
  });
  void getCurrent().then(reduced => {
    if (active && !receivedEvent) onChange(reduced);
  }).catch(() => { /* Keep the conservative default when the preference cannot be read. */ });
  return () => { active = false; unsubscribe(); };
}
