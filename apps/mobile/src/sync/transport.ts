import type { Entity, Snapshot, SyncRequest, SyncResponse } from "./types.ts";
import { validateAnnotation, validateData } from "./types.ts";

export const AUTH_ERROR = "Token inválido ou ausente. Atualize o token nas configurações.";
export const SERVER_MISMATCH = "Servidor diferente do vinculado; fila preservada";
export const NEEDS_IDENTITY = "Sincronize uma vez pelo endereço atual antes de migrar";
export const OTHER_SERVER = "O novo endereço leva a outro servidor; nada foi alterado";
export const SAME_URL = "Esta já é a URL vinculada";
export const MIGRATED = "Servidor migrado; enviando pendências";
export class SyncError extends Error {
  kind: "network" | "auth" | "cursor" | "protocol" | "request";
  constructor(kind: SyncError["kind"], message: string) { super(message); this.kind = kind; }
}
export function normalizeUrl(input: string) {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("Informe uma URL HTTPS válida"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Use HTTPS, sem credenciais, parâmetros ou fragmentos na URL");
  }
  return url.toString().replace(/\/+$/, "");
}
function snapshotValid(entity: Entity, value: any): value is Snapshot {
  if (!value || typeof value.id !== "string" || !Number.isSafeInteger(value.version) || value.version < 1 ||
    typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at)) ||
    !(value.deleted_at === null || (typeof value.deleted_at === "string" && Number.isFinite(Date.parse(value.deleted_at))))) return false;
  if (entity === "book" && (typeof value.title !== "string" || typeof value.author !== "string")) return false;
  if (entity === "log" && (typeof value.book_id !== "string" || typeof value.note !== "string" ||
    typeof value.started_at !== "string" || !(value.progress_value === null || typeof value.progress_value === "number"))) return false;
  if (entity === "annotation" && (validateAnnotation(value) !== null || value.id !== `kindle-${value.fingerprint}`)) return false;
  return typeof value.created_at === "string" && validateData(entity, value) === null;
}
export function validateResponse(value: any, request: SyncRequest): asserts value is SyncResponse {
  const fail = () => { throw new SyncError("protocol", "Resposta incompatível do servidor. Sincronização interrompida; dados locais preservados."); };
  if (!value || !Array.isArray(value.results) || !Array.isArray(value.changes) ||
    !Number.isSafeInteger(value.cursor) || value.cursor < request.cursor || typeof value.hasMore !== "boolean" ||
    value.results.length !== request.operations.length || value.changes.length > 500 ||
    (value.serverId !== undefined && (typeof value.serverId !== "string" || !value.serverId || value.serverId.length > 64))) fail();
  const seen = new Set<string>();
  for (const result of value.results) {
    const op = request.operations.find(item => item.opId === result?.opId);
    if (!op || seen.has(result.opId)) fail();
    seen.add(result.opId);
    if (result.status === "accepted") {
      if (!Number.isSafeInteger(result.version) || result.version !== op!.baseVersion + 1) fail();
    } else if (result.status === "conflict") {
      if (result.current !== null && (!snapshotValid(op!.entity, result.current) || result.current.id !== op!.id)) fail();
    } else if (result.status === "invalid") {
      if (typeof result.reason !== "string") fail();
    } else fail();
  }
  let seq = request.cursor;
  for (const change of value.changes) {
    if (!change || !["book", "log", "annotation"].includes(change.entity) || !Number.isSafeInteger(change.seq) || change.seq <= seq ||
      !snapshotValid(change.entity, change.payload) || change.id !== change.payload.id) fail();
    seq = change.seq;
  }
  if (seq !== value.cursor || (value.hasMore && value.changes.length === 0)) fail();
}
type RequestOptions = { signal?: AbortSignal; timeoutMs?: number; fetcher?: typeof fetch };
async function request(url: string, init: RequestInit, options: RequestOptions, validate: (value: unknown) => void): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort);
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, options.timeoutMs ?? 15000);
  try {
    const response = await (options.fetcher ?? fetch)(url, { ...init, signal: controller.signal, redirect: "error" });
    if (response.status === 401 || response.status === 403) throw new SyncError("auth", AUTH_ERROR);
    if (response.status >= 500 || response.status === 429) throw new SyncError("network", "Servidor indisponível. Uma nova tentativa será feita com o app aberto.");
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (response.status === 400 && body.error === "Cursor inválido") {
        throw new SyncError("cursor", "Cursor inválido: o servidor pode ter sido restaurado. Sincronização bloqueada; preserve o banco local e recupere a instância original.");
      }
      throw new SyncError("request", "Servidor rejeitou a requisição. Verifique a compatibilidade da API; dados locais preservados.");
    }
    let value: unknown;
    try { value = await response.json(); } catch {
      if (controller.signal.aborted) throw new SyncError("network", "Transferência interrompida. Seus registros continuam salvos no celular.");
      throw new SyncError("protocol", "Resposta inválida do servidor. Dados locais preservados.");
    }
    validate(value);
    return value;
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError("network", "Sem conexão ou tempo de espera excedido. Seus registros continuam salvos no celular.");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
export async function sendSync(url: string, token: string, body: SyncRequest, options: RequestOptions = {}): Promise<SyncResponse> {
  return await request(`${url}/v1/sync`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }, options, value => validateResponse(value, body)) as SyncResponse;
}
export async function fetchServerInfo(url: string, token: string, options: RequestOptions = {}): Promise<{ serverId: string }> {
  const value = await request(`${url}/v1/server`, { method: "GET", headers: { Authorization: `Bearer ${token}` } }, options, (value: any) => {
    if (!value || value.protocolVersion !== 1 || typeof value.serverId !== "string" || !value.serverId || value.serverId.length > 64) {
      throw new SyncError("protocol", "Resposta incompatível do servidor. Nenhuma alteração foi feita.");
    }
  }) as { serverId: string };
  return { serverId: value.serverId };
}
/** Steps 1-3 and 5-7 of "Migrar servidor"; the caller pauses the engine (step 4) and requests a sync afterwards. */
export async function migrateServer(store: { settings(): Promise<{ url: string; serverId: string | null }>; migrate(url: string, serverId: string): Promise<void> },
  urlInput: string, token: string, options: RequestOptions = {}) {
  const url = normalizeUrl(urlInput);
  const current = await store.settings();
  if (url === current.url) throw new Error(SAME_URL);
  if (!current.serverId) throw new Error(NEEDS_IDENTITY);
  const info = await fetchServerInfo(url, token, options);
  if (info.serverId !== current.serverId) throw new Error(OTHER_SERVER);
  await store.migrate(url, info.serverId);
}
