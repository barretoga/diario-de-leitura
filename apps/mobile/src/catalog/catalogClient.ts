import { googleVolumeUrl, validVolumeId, type GoogleVolume } from "./googleBooks.ts";
import { workUrl, type CatalogBook, type CatalogLanguage } from "./openLibrary.ts";

type Source = "google" | "openlibrary";
export class CatalogRequestError extends Error {
  fallbackAllowed: boolean;
  constructor(message: string, fallbackAllowed = false) {
    super(message);
    this.name = "CatalogRequestError";
    this.fallbackAllowed = fallbackAllowed;
  }
}
const unexpected = () => new Error("Resposta inesperada do catálogo. Tente novamente mais tarde.");
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const isStrings = (value: unknown, count: number, max: number): value is string[] => Array.isArray(value) && value.length <= count && value.every(item => isText(item, max));
const isYear = (value: unknown) => value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
function parseItem(value: unknown, source: Source): GoogleVolume | CatalogBook {
  if (!value || typeof value !== "object") throw unexpected();
  const row = value as Record<string, unknown>;
  if (row.source !== source || !isText(row.title, 500) || !isStrings(row.authors, 3, 500)) throw unexpected();
  if (source === "google") {
    if (typeof row.id !== "string" || !validVolumeId(row.id) || row.sourceUrl !== googleVolumeUrl(row.id) ||
      !(row.language === null || isText(row.language, 12)) || !isStrings(row.categories, 5, 120) || !isYear(row.publishedYear)) throw unexpected();
    if (row.coverUri !== null) {
      if (typeof row.coverUri !== "string") throw unexpected();
      try {
        const url = new URL(row.coverUri);
        if (url.protocol !== "https:" || url.username || url.password || url.port ||
          !["books.google.com", "books.googleusercontent.com"].includes(url.hostname)) throw unexpected();
      } catch { throw unexpected(); }
    }
    return { source: "google", id: row.id, title: row.title, authors: row.authors, language: row.language as string | null,
      categories: row.categories, coverUri: row.coverUri as string | null, publishedYear: row.publishedYear as number | null, sourceUrl: row.sourceUrl };
  }
  if (typeof row.workKey !== "string" || !/^\/works\/OL\d+W$/.test(row.workKey) || row.sourceUrl !== workUrl(row.workKey) ||
    !["por", "other", "unknown"].includes(row.editionLanguage as string) || !isYear(row.coverId) ||
    !isYear(row.firstPublishYear) || !isStrings(row.subjects, 5, 120)) throw unexpected();
  return { source: "openlibrary", workKey: row.workKey, title: row.title, authors: row.authors,
    editionLanguage: row.editionLanguage as CatalogBook["editionLanguage"], coverId: row.coverId as number | null,
    subjects: row.subjects, firstPublishYear: row.firstPublishYear as number | null, sourceUrl: row.sourceUrl };
}

function baseUrl(): URL {
  const value = process.env.EXPO_PUBLIC_CATALOG_API_URL?.trim();
  if (!value) throw new Error("A busca de catálogo ainda não está configurada neste app. Você pode cadastrar o livro manualmente.");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = url.pathname.replace(/\/$/, "") + "/";
    return url;
  } catch { throw new Error("A URL do catálogo neste app é inválida. Você pode cadastrar o livro manualmente."); }
}

async function request(path: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<unknown> {
  const url = new URL(path, baseUrl());
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12_000);
  try {
    let response: Response;
    try { response = await fetch(url.toString(), { signal: controller.signal, credentials: "omit", headers: { Accept: "application/json" } }); }
    catch {
      throw new Error(timedOut ? "A consulta demorou demais. Tente novamente." : "Não foi possível conectar ao catálogo. Confira a conexão ou cadastre manualmente.");
    }
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: "Confira o título, autor e idioma da busca.",
        429: "O catálogo está ocupado. Aguarde e tente novamente.",
        502: "O catálogo recebeu uma resposta inválida. Tente mais tarde.",
        503: "Catálogo indisponível. Tente mais tarde ou mantenha o cadastro manual.",
        504: "A consulta demorou demais. Tente novamente.",
      };
      // Only a provider error reported by the reachable gateway permits fallback.
      // Connection/configuration failures and rate limits must not double traffic.
      let code: unknown;
      try { const body = await response.json(); code = body?.code; } catch { /* No raw error body is exposed. */ }
      const fallbackAllowed = [502, 503, 504].includes(response.status) &&
        ["provider_unavailable", "provider_timeout", "invalid_response"].includes(code as string);
      throw new CatalogRequestError(messages[response.status] ?? "Catálogo indisponível. Tente mais tarde ou mantenha o cadastro manual.", fallbackAllowed);
    }
    try { return await response.json(); }
    catch { if (controller.signal.aborted) throw new Error("A consulta demorou demais. Tente novamente."); throw unexpected(); }
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export function searchCatalog(source: "google", title: string, author: string, language: CatalogLanguage, signal?: AbortSignal): Promise<GoogleVolume[]>;
export function searchCatalog(source: "openlibrary", title: string, author: string, language: CatalogLanguage, signal?: AbortSignal): Promise<CatalogBook[]>;
export async function searchCatalog(source: Source, title: string, author: string, language: CatalogLanguage, signal?: AbortSignal) {
  title = title.trim().replace(/\s+/g, " "); author = author.trim().replace(/\s+/g, " ");
  if (title.length < 2 || title.length > 200 || author.length > 200) throw new Error("Informe um título com 2 a 200 caracteres e autor com até 200 caracteres.");
  const value = await request("v1/catalog/search", { source, title, author, language }, signal);
  if (!value || typeof value !== "object") throw unexpected();
  const row = value as Record<string, unknown>;
  if (row.source !== source || !Array.isArray(row.items) || row.items.length > (source === "google" ? 20 : 10)) throw unexpected();
  return row.items.map(item => parseItem(item, source));
}

export async function getGoogleVolume(id: string, signal?: AbortSignal): Promise<GoogleVolume> {
  if (!validVolumeId(id)) throw new Error("Identificador do livro inválido.");
  const item = parseItem(await request(`v1/catalog/google/volumes/${id}`, {}, signal), "google") as GoogleVolume;
  if (item.id !== id) throw unexpected();
  return item;
}
