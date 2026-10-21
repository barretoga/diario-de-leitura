import { searchBookCandidates } from "./searchCandidates.ts";
import type { CatalogLanguage } from "./openLibrary.ts";
import type { CatalogCandidate } from "./bookDraft.ts";

export type SuggestionState = {
  phase: "idle" | "waiting" | "searching" | "ready" | "selected" | "error";
  source: "google" | "openlibrary" | null;
  items: CatalogCandidate[];
  selection: CatalogCandidate | null;
  message: string | null;
};
const emptyState = (): SuggestionState => ({ phase: "idle", source: null, items: [], selection: null, message: null });
const normalize = (value: string) => value.trim().replace(/\s+/g, " ");

// One instance per registration. Its in-memory cache disappears with the form.
export class BookSuggestions {
  state: SuggestionState = emptyState();
  private listener: (state: SuggestionState) => void;
  private cache = new Map<string, SuggestionState>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private revision = 0;
  private key: string | null = null;
  private query: { title: string; author: string; language: CatalogLanguage } | null = null;
  constructor(listener: (state: SuggestionState) => void) { this.listener = listener; }
  private publish(state: SuggestionState) { this.state = state; this.listener(state); }
  private stop() {
    this.revision++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
  }
  update(title: string, author: string, language: CatalogLanguage) {
    title = normalize(title); author = normalize(author);
    const key = JSON.stringify([title, author, language]);
    if (key === this.key && this.state.phase !== "selected") return;
    this.stop(); this.key = key; this.query = { title, author, language };
    if (title.length < 3 || title.length > 200 || author.length > 200) {
      this.publish({ ...emptyState(), message: title.length > 200 || author.length > 200
        ? "A busca aceita título e autoria com até 200 caracteres. Você pode cadastrar manualmente com até 500." : null });
      return;
    }
    const cached = this.cache.get(key);
    if (cached) { this.publish(cached); return; }
    this.publish({ ...emptyState(), phase: "waiting", source: "google" });
    const revision = this.revision;
    this.timer = setTimeout(() => { this.timer = null; void this.search(key, revision, title, author, language); }, 600);
  }
  private async search(key: string, revision: number, title: string, author: string, language: CatalogLanguage) {
    const controller = new AbortController(); this.controller = controller;
    const current = () => revision === this.revision && !controller.signal.aborted;
    let source: "google" | "openlibrary" = "google";
    this.publish({ ...emptyState(), phase: "searching", source });
    try {
      const { items } = await searchBookCandidates(title, author, language, controller.signal, nextSource => {
        source = nextSource;
        if (current()) this.publish({ ...emptyState(), phase: "searching", source });
      });
      if (!current()) return;
      const result: SuggestionState = { phase: "ready", source, items, selection: null, message: null };
      this.cache.set(key, result); this.publish(result);
    } catch (error) {
      if (!current()) return;
      const result: SuggestionState = { ...emptyState(), phase: "error", source,
        message: error instanceof Error ? error.message : "Não foi possível buscar. Cadastre manualmente ou tente novamente." };
      this.cache.set(key, result); this.publish(result);
    } finally { if (current()) this.controller = null; }
  }
  candidate(): CatalogCandidate | null {
    return this.state.phase === "selected" ? this.state.selection : this.state.phase === "ready" ? this.state.items[0] ?? null : null;
  }
  select(candidate: CatalogCandidate) {
    if (this.state.phase !== "ready" || !this.state.items.includes(candidate)) return;
    this.stop(); this.publish({ ...this.state, phase: "selected", selection: candidate });
  }
  retry() {
    if (!this.query || !this.key) return;
    const { title, author, language } = this.query;
    this.cache.delete(this.key); this.key = null; this.update(title, author, language);
  }
  dispose() { this.stop(); }
}
