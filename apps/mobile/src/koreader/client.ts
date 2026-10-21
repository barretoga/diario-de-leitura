import { normalizeUrl } from "../sync/transport.ts";
import type { DocumentSummary, DocumentPage, KOReaderStatus, KOReaderClient } from "./types.ts";
export class KOReaderClientError extends Error {
  kind: "configuration" | "auth" | "network" | "protocol" | "request" | "conflict" | "cancelled";
  code: string;
  constructor(kind: KOReaderClientError["kind"], message: string, code: string = kind) { super(message); this.kind = kind; this.code = code; }
}
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const safe = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function validDocument(row: unknown): row is DocumentSummary {
  return object(row) && safe(row.id) && row.id > 0 && typeof row.deviceId === "string" && uuid.test(row.deviceId) && typeof row.generationId === "string" && uuid.test(row.generationId) &&
    typeof row.documentId === "string" && /^[a-f0-9]{32}$/.test(row.documentId) && typeof row.title === "string" && row.title.length <= 500 && typeof row.author === "string" && row.author.length <= 500 &&
    ["pending", "linked", "blocked"].includes(row.state) && (row.bookId === null || typeof row.bookId === "string" && row.bookId.length >= 8 && row.bookId.length <= 100) && safe(row.associationVersion) &&
    (row.error === null || object(row.error) && typeof row.error.code === "string" && typeof row.error.message === "string" && row.error.message.length <= 500);
}
export function createKOReaderClient(options: { getUrl: () => Promise<string | null>; getToken: () => Promise<string | null>; fetchImpl?: typeof fetch; timeoutMs?: number }): KOReaderClient {
  async function request(path: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController(); const abort = () => controller.abort(); signal?.addEventListener("abort", abort); if (signal?.aborted) abort();
    const timer = setTimeout(abort, options.timeoutMs ?? 15000);
    try {
      const configured = await options.getUrl(); if (!configured) throw new KOReaderClientError("configuration", "Configure a sincronização pessoal primeiro");
      let url: string; try { url = normalizeUrl(configured); } catch { throw new KOReaderClientError("configuration", "Confira a URL HTTPS da sincronização pessoal"); }
      let token: string | null; try { token = await options.getToken(); } catch { throw new KOReaderClientError("auth", "Não foi possível ler o token pessoal"); }
      if (!token) throw new KOReaderClientError("auth", "Atualize o token na sincronização pessoal");
      if (controller.signal.aborted) throw new KOReaderClientError(signal?.aborted ? "cancelled" : "network", "Consulta interrompida");
      const response = await (options.fetchImpl ?? fetch)(url + path, { method: input === undefined ? "GET" : "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: input === undefined ? undefined : JSON.stringify(input), redirect: "error", signal: controller.signal });
      if (response.status === 401 || response.status === 403) throw new KOReaderClientError("auth", "Token inválido. Atualize-o na sincronização pessoal");
      if (response.status === 429 || response.status >= 500) throw new KOReaderClientError("network", "Servidor pessoal indisponível. Tente atualizar");
      if (response.status === 409) throw new KOReaderClientError("conflict", "Associação alterada. A lista será atualizada");
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const code = object(body) && object(body.error) && body.error.code === "book_missing" ? "book_missing" : "request";
        throw new KOReaderClientError("request", code === "book_missing" ? "Sincronize este livro antes de associar" : "Confira a integração e atualize a lista", code);
      }
      try { return await response.json(); } catch { throw new KOReaderClientError("protocol", "Resposta incompatível da integração"); }
    } catch (error) {
      if (error instanceof KOReaderClientError) throw error;
      throw new KOReaderClientError(signal?.aborted ? "cancelled" : "network", signal?.aborted ? "Consulta cancelada" : "Não foi possível conectar ao servidor pessoal");
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  const invalid = () => { throw new KOReaderClientError("protocol", "Resposta incompatível da integração"); };
  return {
    async status(signal) {
      const value = await request("/v1/koreader/status", undefined, signal);
      if (!object(value) || value.protocolVersion !== 1 || typeof value.timeZone !== "string" || !object(value.counts) || ![value.counts.pending, value.counts.linked, value.counts.blocked].every(safe) || !(value.lastReceiptAt === null || typeof value.lastReceiptAt === "string" && Number.isFinite(Date.parse(value.lastReceiptAt)))) invalid();
      return value as KOReaderStatus;
    },
    async documents(query, signal) {
      const params = new URLSearchParams({ state: query.state, after: String(query.after), limit: String(query.limit) });
      const value = await request(`/v1/koreader/documents?${params}`, undefined, signal);
      if (!object(value) || !Array.isArray(value.documents) || value.documents.length > query.limit || !value.documents.every(validDocument) || !(value.nextAfter === null || safe(value.nextAfter) && value.nextAfter > query.after)) invalid();
      const page = value as DocumentPage;
      let previous = query.after; for (const doc of page.documents) { if (doc.id <= previous) invalid(); previous = doc.id; }
      if (page.nextAfter !== null && (page.documents.length === 0 || page.nextAfter !== previous)) invalid();
      return page;
    },
    async link(id, input, signal) {
      if (!safe(id) || id === 0 || !safe(input.expectedVersion) || typeof input.bookId !== "string" || input.bookId.length < 8 || input.bookId.length > 100) throw new KOReaderClientError("request", "Associação inválida");
      const value = await request(`/v1/koreader/documents/${id}/link`, input, signal);
      if (!object(value) || !validDocument(value.document) || value.document.id !== id || value.document.bookId !== input.bookId) invalid();
      return value as { document: DocumentSummary };
    },
  };
}
