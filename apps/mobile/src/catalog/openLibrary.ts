export type CatalogBook = {
  source: "openlibrary";
  workKey: string;
  title: string;
  authors: string[];
  editionLanguage: "por" | "other" | "unknown";
  coverId: number | null;
  subjects: string[];
  firstPublishYear: number | null;
  sourceUrl: string;
};
export type CatalogLanguage = "pt" | "all";
export function coverUrl(coverId: number, size: "S" | "M" = "M") {
  return `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg?default=false`;
}
export function workUrl(workKey: string) {
  if (!/^\/works\/OL\d+W$/.test(workKey)) throw new Error("Identificador do livro inválido.");
  return `https://openlibrary.org${workKey}`;
}
