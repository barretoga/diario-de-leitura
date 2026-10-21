import { CatalogRequestError, searchCatalog } from "./catalogClient.ts";
import type { CatalogCandidate } from "./bookDraft.ts";
import type { CatalogLanguage } from "./openLibrary.ts";

export async function searchBookCandidates(title: string, author: string, language: CatalogLanguage,
  signal?: AbortSignal, onSource: (source: "google" | "openlibrary") => void = () => {}) {
  let source: "google" | "openlibrary" = "google";
  onSource(source);
  let items: CatalogCandidate[];
  try { items = await searchCatalog("google", title, author, language, signal); }
  catch (error) {
    if (signal?.aborted || !(error instanceof CatalogRequestError) || !error.fallbackAllowed) throw error;
    items = [];
  }
  if (signal?.aborted) throw new Error("Busca interrompida");
  if (!items.length) {
    source = "openlibrary"; onSource(source);
    items = await searchCatalog("openlibrary", title, author, language, signal);
  }
  return { source, items };
}
