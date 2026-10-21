import type { SyncEngine } from "./engine.ts";
import type { SyncStore } from "./store.ts";
// Engine requests intentionally resolve after reporting recoverable failures.
// A caller that depends on receipt must check the outcome separately.
export async function syncConfirmed(engine: Pick<SyncEngine, "request" | "status"> | null, store: Pick<SyncStore, "settings" | "pendingCount">) {
  const pending = () => { throw new Error("Sincronização pendente. Confira a conexão pessoal"); };
  const before = await store.settings();
  if (!engine || !before.url || before.paused || before.fatal) pending();
  await engine!.request();
  const after = await store.settings();
  if (after.paused || after.fatal || engine!.status.phase !== "idle" || engine!.status.message || await store.pendingCount()) pending();
}
