import type { SyncStore } from "../sync/store.ts";
import { registrationDraft, type RegistrationDraft } from "./bookDraft.ts";
import { searchBookCandidates } from "./searchCandidates.ts";

export async function enrichKindleBooks(store: SyncStore, signal: AbortSignal) {
  for (const book of await store.pendingKindleCatalogBooks()) {
    if (signal.aborted) return;
    let draft: RegistrationDraft | null = null;
    try {
      const { items } = await searchBookCandidates(book.title, book.author, "all", signal);
      if (items[0]) draft = registrationDraft(book.title, book.author, items[0]);
    } catch { /* Catalog unavailability keeps the original Kindle registration. */ }
    if (signal.aborted) return;
    await store.finishKindleCatalogLookup(book.id, draft);
  }
}
