export type GoogleVolume = {
  source: "google";
  id: string;
  title: string;
  authors: string[];
  language: string | null;
  categories: string[];
  coverUri: string | null;
  publishedYear: number | null;
  sourceUrl: string;
};
export function validVolumeId(id: string) { return /^[A-Za-z0-9_-]{1,80}$/.test(id); }
export function googleVolumeUrl(id: string) {
  if (!validVolumeId(id)) throw new Error("Identificador do livro inválido.");
  return `https://books.google.com/books?id=${encodeURIComponent(id)}`;
}
