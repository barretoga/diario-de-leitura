import type { SyncStore } from "./store.ts";
import { enrichKindleBooks } from "../catalog/enrichKindleBooks.ts";
import { AUTH_ERROR, sendSync, SyncError } from "./transport.ts";
import type { SyncRequest, SyncResponse, SyncStatus } from "./types.ts";

type Transport = (
  url: string,
  token: string,
  request: SyncRequest,
  options: { signal: AbortSignal },
) => Promise<SyncResponse>;
export class SyncEngine {
  private store: SyncStore;
  private getToken: () => Promise<string | null>;
  private transport: Transport;
  private listeners = new Set<() => void>();
  private active = false;
  private running: Promise<void> | null = null;
  private requested = false;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = 1000;
  status: SyncStatus = { phase: "idle", message: null };
  constructor(
    store: SyncStore,
    getToken: () => Promise<string | null>,
    transport: Transport = sendSync,
  ) {
    this.store = store;
    this.getToken = getToken;
    this.transport = transport;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  settled() {
    return this.running ?? Promise.resolve();
  }
  private publish(status: SyncStatus) {
    this.status = status;
    for (const listener of this.listeners) listener();
  }
  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  setActive(active: boolean) {
    this.active = active;
    if (active) void this.request();
    else {
      this.clearTimer();
      this.controller?.abort();
    }
  }
  async pause(paused: boolean) {
    await this.store.pause(paused);
    if (paused) {
      this.clearTimer();
      this.controller?.abort();
      this.publish({ phase: "idle", message: "Sincronização pausada" });
    } else await this.request();
  }
  request(): Promise<void> {
    if (!this.active) return Promise.resolve();
    this.requested = true;
    if (this.running) return this.running;
    this.clearTimer();
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.requested && this.active && !this.timer) void this.request();
    });
    return this.running;
  }
  private async run() {
    try {
      do {
        this.requested = false;
        const settings = await this.store.settings();
        if (
          !this.active ||
          settings.paused ||
          !settings.url ||
          settings.fatal
        ) {
          this.publish({
            phase: settings.fatal ? "blocked" : "idle",
            message:
              settings.fatal ??
              (settings.paused ? "Sincronização pausada" : null),
          });
          return;
        }
        const token = await this.getToken();
        if (!token) throw new SyncError("auth", AUTH_ERROR);
        this.publish({ phase: "syncing", message: null });
        let request = await this.store.prepare();
        while (this.active) {
          const current = await this.store.settings();
          if (!this.active || current.paused) return;
          this.controller = new AbortController();
          const response = await this.transport(settings.url, token, request, {
            signal: this.controller.signal,
          });
          await this.store.apply(request, response);
          this.publish({ phase: "syncing", message: null });
          // Drain each page before sending more operations to avoid using a stale remote version.
          if (response.hasMore)
            request = { cursor: response.cursor, operations: [] };
          else {
            if (this.active) await enrichKindleBooks(this.store, this.controller.signal);
            request = await this.store.prepare();
            if (!request.operations.length) break;
          }
        }
        if (!this.active) return;
        await this.store.success();
        this.retryMs = 1000;
        this.publish({ phase: "idle", message: null });
      } while (this.requested && this.active);
    } catch (error) {
      this.requested = false;
      if (!this.active) return;
      try {
        if ((await this.store.settings()).paused) return;
      } catch {
        this.publish({
          phase: "blocked",
          message:
            "Não foi possível ler o banco local. Feche e reabra o app; os dados foram preservados.",
        });
        return;
      }
      const failure =
        error instanceof SyncError
          ? error
          : new SyncError(
              "protocol",
              "Não foi possível aplicar a sincronização. Dados locais preservados; verifique o banco e a versão do app.",
            );
      if (failure.kind !== "network") {
        try {
          await this.store.block(failure.message);
        } catch {
          /* Report even when SQLite is unavailable. */
        }
        this.publish({ phase: "blocked", message: failure.message });
      } else {
        this.publish({ phase: "offline", message: failure.message });
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.request();
        }, this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 30000);
      }
    } finally {
      this.controller = null;
      if (this.status.phase === "syncing")
        this.publish({ phase: "idle", message: null });
    }
  }
}
