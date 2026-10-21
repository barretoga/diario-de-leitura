export type Entity = "book" | "log" | "annotation";
export type BookData = { title: string; author: string; created_at: string };
export type LogData = {
  book_id: string; started_at: string; minutes: number;
  progress_value: number | null; progress_unit: "page" | "location" | "percent" | null;
  note: string; created_at: string;
};
export type AnnotationData = {
  book_id: string; kind: "highlight" | "note" | "bookmark"; content: string;
  location: string | null; page: string | null; source_date: string | null;
  source_title: string; source_author: string; fingerprint: string; created_at: string;
};
export type Data = BookData | LogData | AnnotationData;
export type Snapshot = Data & {
  id: string; version: number; updated_at: string; deleted_at: string | null;
  origin?: "koreader";
};
export type Operation = {
  opId: string; entity: Entity; id: string; baseVersion: number; deleted: boolean; data?: Data;
};
export type SyncRequest = { cursor: number; operations: Operation[] };
export type Result =
  | { opId: string; status: "accepted"; version: number }
  | { opId: string; status: "conflict"; current: Snapshot | null }
  | { opId: string; status: "invalid"; reason: string };
export type SyncResponse = {
  results: Result[];
  changes: { seq: number; entity: Entity; id: string; payload: Snapshot }[];
  cursor: number; hasMore: boolean; serverId?: string;
};
export type Settings = {
  url: string; paused: boolean; cursor: number; lastSuccess: string | null; fatal: string | null;
  serverId: string | null;
};
export type Issue = {
  entity: Entity; id: string; error: string | null;
  local: Snapshot; remote: Snapshot | null; conflict: boolean;
};
export type SyncStatus = {
  phase: "idle" | "syncing" | "offline" | "blocked";
  message: string | null;
};

export function validateData(entity: Entity, data: Data): string | null {
  if (!Number.isFinite(Date.parse(data.created_at))) return "Data de criação inválida";
  if (entity === "book") {
    const book = data as BookData;
    if (!book.title.trim() || book.title.length > 500) return "Título deve ter entre 1 e 500 caracteres";
    if (book.author.length > 500) return "Autor deve ter até 500 caracteres";
  } else if (entity === "annotation") {
    return validateAnnotation(data);
  } else {
    const log = data as LogData;
    if (!Number.isFinite(Date.parse(log.started_at))) return "Data de leitura inválida";
    if (!Number.isInteger(log.minutes) || log.minutes < 0 || log.minutes > 10080) return "Duração deve estar entre 0 e 10.080 minutos inteiros";
    if (log.note.length > 10000) return "Nota deve ter até 10.000 caracteres";
    if ((log.progress_value === null) !== (log.progress_unit === null)) return "Progresso inválido";
    if (log.progress_value !== null && (!Number.isFinite(log.progress_value) || log.progress_value < 0 ||
      !["page", "location", "percent"].includes(log.progress_unit ?? "") ||
      (log.progress_unit === "percent" && log.progress_value > 100))) return "Progresso inválido";
  }
  return null;
}

export function validateAnnotation(value: unknown): string | null {
  if (!value || typeof value !== "object") return "Anotação inválida";
  const row = value as AnnotationData;
  if (typeof row.book_id !== "string" || row.book_id.length < 8 || row.book_id.length > 100) return "Livro inválido";
  if (!["highlight", "note", "bookmark"].includes(row.kind)) return "Tipo de anotação inválido";
  if (typeof row.content !== "string" || row.content.length > 10000 || (row.kind !== "bookmark" && !row.content.trim())) return "Conteúdo inválido";
  for (const key of ["location", "page", "source_date"] as const) {
    if (row[key] !== null && (typeof row[key] !== "string" || row[key].length > (key === "source_date" ? 500 : 100))) return "Metadados inválidos";
  }
  if (row.kind === "bookmark" && !row.location && !row.page) return "Marcador sem posição";
  if (typeof row.source_title !== "string" || !row.source_title.trim() || row.source_title.length > 500 ||
    typeof row.source_author !== "string" || row.source_author.length > 500) return "Origem inválida";
  if (typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.fingerprint)) return "Identificador de anotação inválido";
  if (typeof row.created_at !== "string" || row.created_at.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(row.created_at) || !Number.isFinite(Date.parse(row.created_at))) return "Data de criação inválida";
  return null;
}
