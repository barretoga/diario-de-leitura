import { KOReaderClientError } from "./client.ts";
import type { KOReaderClient, DocumentSummary, KOReaderStatus } from "./types.ts";
export type KOReaderState = { phase: "unconfigured" | "loading" | "ready" | "error"; documents: DocumentSummary[]; nextAfter: number | null; error: KOReaderClientError | null; busyDocumentId: number | null; status: KOReaderStatus | null; loadingMore: boolean };
export class KOReaderController {
  snapshot: KOReaderState = { phase: "loading", documents: [], nextAfter: null, error: null, busyDocumentId: null, status: null, loadingMore: false };
  private client: KOReaderClient; private onLinked: () => Promise<void>; private generation = 0; private disposed = false; private abort: AbortController | null = null;
  private listeners = new Set<(state: KOReaderState) => void>();
  constructor(client: KOReaderClient, onLinked: () => Promise<void>) { this.client = client; this.onLinked = onLinked; }
  subscribe(listener: (state: KOReaderState) => void) { this.listeners.add(listener); listener(this.snapshot); return () => { this.listeners.delete(listener); }; }
  private emit(patch: Partial<KOReaderState>) { if (this.disposed) return; this.snapshot = { ...this.snapshot, ...patch }; this.listeners.forEach(fn => fn(this.snapshot)); }
  private error(error: unknown) { return error instanceof KOReaderClientError ? error : new KOReaderClientError("network", "Não foi possível consultar a integração"); }
  async load() {
    if (this.disposed || this.snapshot.busyDocumentId !== null) return;
    this.abort?.abort(); this.abort = new AbortController(); const generation = ++this.generation;
    this.emit({ phase: "loading", error: null, loadingMore: false });
    try {
      const [status, page] = await Promise.all([this.client.status(this.abort.signal), this.client.documents({ state: "all", after: 0, limit: 50 }, this.abort.signal)]);
      if (this.disposed || generation !== this.generation) return;
      this.emit({ phase: "ready", status, documents: page.documents, nextAfter: page.nextAfter });
    } catch (value) {
      if (this.disposed || generation !== this.generation) return; const error = this.error(value);
      this.emit({ phase: error.kind === "configuration" ? "unconfigured" : "error", error });
    }
  }
  async loadMore() {
    if (this.disposed || this.snapshot.nextAfter === null || this.snapshot.loadingMore || this.snapshot.phase === "loading" || this.snapshot.busyDocumentId !== null) return;
    const generation = this.generation; const after = this.snapshot.nextAfter; this.emit({ loadingMore: true, error: null });
    try { const page = await this.client.documents({ state: "all", after, limit: 50 }, this.abort?.signal); if (this.disposed || generation !== this.generation) return;
      const ids = new Set(this.snapshot.documents.map(row => row.id)); this.emit({ documents: [...this.snapshot.documents, ...page.documents.filter(row => !ids.has(row.id))], nextAfter: page.nextAfter, loadingMore: false });
    } catch (value) { if (generation === this.generation) this.emit({ error: this.error(value), loadingMore: false }); }
  }
  async link(documentId: number, bookId: string, expectedVersion: number) {
    if (this.disposed || this.snapshot.busyDocumentId !== null) return;
    const generation = this.generation; this.emit({ busyDocumentId: documentId, error: null });
    try {
      const response = await this.client.link(documentId, { bookId, expectedVersion }, this.abort?.signal); if (this.disposed || generation !== this.generation) return;
      this.emit({ documents: this.snapshot.documents.map(row => row.id === documentId ? response.document : row) });
      try { await this.onLinked(); } catch { this.emit({ error: new KOReaderClientError("network", "Livro associado; sincronização pendente") }); }
    } catch (value) {
      if (this.disposed || generation !== this.generation) return; const error = this.error(value); this.emit({ error });
      if (error.kind === "conflict") { this.emit({ busyDocumentId: null }); await this.load(); }
    } finally { if (generation === this.generation) this.emit({ busyDocumentId: null }); }
  }
  cancel() { this.abort?.abort(); this.generation++; this.emit({ phase: this.snapshot.documents.length ? "ready" : "error", loadingMore: false, busyDocumentId: null }); }
  dispose() { this.disposed = true; this.abort?.abort(); this.generation++; this.listeners.clear(); }
}
