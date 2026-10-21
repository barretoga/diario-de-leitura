import type { NewBookCatalog } from "../sync/store.ts";
import type { GoogleVolume } from "./googleBooks.ts";
import type { CatalogBook } from "./openLibrary.ts";

export type CatalogCandidate = GoogleVolume | CatalogBook;
export type RegistrationDraft = { title: string; author: string; catalog: NewBookCatalog | null };

export function registrationDraft(title: string, author: string, candidate: CatalogCandidate | null,
  currentCandidate: CatalogCandidate | null = candidate): RegistrationDraft {
  if (candidate && candidate !== currentCandidate) throw new Error("As sugestões mudaram. Confira a edição antes de cadastrar ou cadastre manualmente.");
  title = (candidate?.title ?? title).trim();
  author = (candidate?.authors.length ? candidate.authors.join(", ") : author).trim();
  if (!title) throw new Error("Informe o título do livro.");
  if (title.length > 500 || author.length > 500) throw new Error("Título e autoria devem ter até 500 caracteres. Ajuste os campos e cadastre manualmente.");
  const catalog: NewBookCatalog | null = !candidate ? null : candidate.source === "google"
    ? { source: "google", volume_id: candidate.id }
    : { source: "openlibrary", work_key: candidate.workKey, cover_id: candidate.coverId,
      subjects: candidate.subjects, first_publish_year: candidate.firstPublishYear };
  return { title, author, catalog };
}
