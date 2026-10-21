import { validateAnnotation } from "../sync/types.ts";
import type { AnnotationData, BookData, LogData } from "../sync/types.ts";
import type { BookMetadata, GoogleBookLink } from "../sync/store.ts";

export const MAX_BACKUP_BYTES = 25 * 1024 * 1024;
const MAX_RECORDS = 50000;
export type BackupBook = BookData & { id: string };
export type BackupLog = LogData & { id: string };
export type BackupAnnotation = AnnotationData & { id: string };
export type Backup = {
  format: "reading-log-backup";
  version: 1 | 2 | 3 | 4;
  exportedAt: string;
  books: BackupBook[];
  logs: BackupLog[];
  annotations?: BackupAnnotation[];
  catalog?: BookMetadata[];
  googleCatalog?: GoogleBookLink[];
};
export type RestoreSummary = {
  booksAdded: number; logsAdded: number; annotationsAdded: number; metadataAdded: number; googleLinksAdded: number; unchanged: number;
  skipped: { kind: "Livro" | "Leitura" | "Anotação" | "Catálogo"; id: string; label: string; reason: string }[];
};
type ExistingBook = BackupBook & { deleted_at: string | null };
type ExistingLog = BackupLog & { deleted_at: string | null };
const bookKeys = ["id", "title", "author", "created_at"] as const;
const logKeys = ["id", "book_id", "started_at", "minutes", "progress_value", "progress_unit", "note", "created_at"] as const;
const annotationKeys = ["id", "book_id", "kind", "content", "location", "page", "source_date", "source_title", "source_author", "fingerprint", "created_at"] as const;

function invalid(message: string): never { throw new Error(`Backup inválido: ${message}`); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("registro incompleto.");
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string): string {
  if (typeof value !== "string") invalid(`${name} deve ser texto.`);
  return value;
}
function id(value: unknown) {
  const result = string(value, "identificador");
  if (result.length < 8 || result.length > 100) invalid("identificador fora do formato esperado.");
  return result;
}
function date(value: unknown) {
  const result = string(value, "data");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || result.length > 40 || !Number.isFinite(Date.parse(result))) invalid("data não reconhecida.");
  return result;
}
export function utf8Bytes(text: string) {
  let bytes = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes > MAX_BACKUP_BYTES) break;
  }
  return bytes;
}
export function validateBackup(value: unknown): Backup {
  const root = object(value);
  if (root.format !== "reading-log-backup" || ![1, 2, 3, 4].includes(root.version as number)) invalid("formato ou versão não suportados.");
  if (!Array.isArray(root.books) || !Array.isArray(root.logs)) invalid("faltam livros ou leituras.");
  if ((root.version === 2 || root.version === 3 || root.version === 4) && !Array.isArray(root.annotations)) invalid("faltam anotações.");
  if (root.version === 1 && root.annotations !== undefined) invalid("anotações exigem versão 2.");
  if ((root.version === 3 || root.version === 4) && !Array.isArray(root.catalog)) invalid("faltam dados do catálogo.");
  if (root.version !== 3 && root.version !== 4 && root.catalog !== undefined) invalid("dados do catálogo exigem versão 3.");
  if (root.version === 4 && !Array.isArray(root.googleCatalog)) invalid("faltam associações ao Google Books.");
  if (root.version !== 4 && root.googleCatalog !== undefined) invalid("associações ao Google Books exigem versão 4.");
  const rawAnnotations = (root.version as number) >= 2 ? root.annotations as unknown[] : [];
  const rawCatalog = (root.version === 3 || root.version === 4) ? root.catalog as unknown[] : [];
  const rawGoogleCatalog = root.version === 4 ? root.googleCatalog as unknown[] : [];
  if (root.books.length + root.logs.length + rawAnnotations.length + rawCatalog.length + rawGoogleCatalog.length > MAX_RECORDS) invalid("limite de 50.000 registros excedido.");
  const bookIds = new Set<string>(), logIds = new Set<string>();
  const books = root.books.map(value => {
    const row = object(value);
    const book: BackupBook = { id: id(row.id), title: string(row.title, "título"), author: string(row.author, "autor"), created_at: date(row.created_at) };
    if (!book.title.trim()) invalid("livro sem título.");
    if (bookIds.has(book.id)) invalid("identificador de livro repetido.");
    bookIds.add(book.id);
    return book;
  });
  const logs = root.logs.map(value => {
    const row = object(value);
    const logId = id(row.id), bookId = id(row.book_id);
    if (logIds.has(logId)) invalid("identificador de leitura repetido.");
    if (!bookIds.has(bookId)) invalid("leitura sem o livro correspondente no arquivo.");
    logIds.add(logId);
    if (typeof row.minutes !== "number" || !Number.isSafeInteger(row.minutes) || row.minutes < 0) invalid("duração inválida.");
    const progress = row.progress_value, unit = row.progress_unit;
    if ((progress === null) !== (unit === null)) invalid("progresso incompleto.");
    if (progress !== null && (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0 ||
      !["page", "location", "percent"].includes(unit as string) || (unit === "percent" && progress > 100))) invalid("progresso inválido.");
    const log: BackupLog = {
      id: logId, book_id: bookId, started_at: date(row.started_at), minutes: row.minutes,
      progress_value: progress as number | null, progress_unit: unit as LogData["progress_unit"],
      note: string(row.note, "nota"), created_at: date(row.created_at),
    };
    return log;
  });
  const fingerprints = new Set<string>();
  const annotations = rawAnnotations.map(value => {
    const row = object(value);
    const annotation = Object.fromEntries(annotationKeys.map(key => [key, row[key]])) as BackupAnnotation;
    const error = validateAnnotation(annotation);
    if (error || annotation.id !== `kindle-${annotation.fingerprint}`) invalid(error ?? "identificador de anotação inválido.");
    if (!bookIds.has(annotation.book_id)) invalid("anotação sem livro correspondente.");
    if (fingerprints.has(annotation.fingerprint)) invalid("anotação repetida.");
    fingerprints.add(annotation.fingerprint);
    return annotation;
  });
  const catalogIds = new Set<string>();
  const catalog = rawCatalog.map(value => {
    const row = object(value), bookId = id(row.book_id);
    if (!bookIds.has(bookId) || catalogIds.has(bookId)) invalid("dados do catálogo sem livro ou repetidos.");
    catalogIds.add(bookId);
    if (typeof row.work_key !== "string" || !/^\/works\/OL\d+W$/.test(row.work_key)) invalid("identificador do catálogo inválido.");
    if (row.cover_id !== null && (typeof row.cover_id !== "number" || !Number.isSafeInteger(row.cover_id) || row.cover_id <= 0)) invalid("capa inválida.");
    if (!Array.isArray(row.subjects) || row.subjects.length > 5 || row.subjects.some(item => typeof item !== "string" || item.length > 120)) invalid("assuntos inválidos.");
    if (row.first_publish_year !== null && (typeof row.first_publish_year !== "number" || !Number.isSafeInteger(row.first_publish_year))) invalid("ano inválido.");
    return { book_id: bookId, work_key: row.work_key, cover_id: row.cover_id,
      subjects: row.subjects, first_publish_year: row.first_publish_year } as BookMetadata;
  });
  const googleIds = new Set<string>();
  const googleCatalog = rawGoogleCatalog.map(value => {
    const row = object(value), bookId = id(row.book_id);
    if (!bookIds.has(bookId) || googleIds.has(bookId) || catalogIds.has(bookId)) invalid("associação ao Google Books sem livro, repetida ou com duas fontes.");
    if (typeof row.volume_id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(row.volume_id)) invalid("identificador do Google Books inválido.");
    googleIds.add(bookId);
    return { book_id: bookId, volume_id: row.volume_id } as GoogleBookLink;
  });
  // Whitelist portable content. Credentials, versions, cursors and extra fields never enter the database.
  return { format: "reading-log-backup", version: root.version as 1 | 2 | 3 | 4, exportedAt: date(root.exportedAt), books, logs,
    ...((root.version as number) >= 2 ? { annotations } : {}), ...((root.version as number) >= 3 ? { catalog } : {}),
    ...(root.version === 4 ? { googleCatalog } : {}) };
}
export function parseBackup(text: string): Backup {
  if (text.length > MAX_BACKUP_BYTES || utf8Bytes(text) > MAX_BACKUP_BYTES) invalid("arquivo maior que 25 MB.");
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { invalid("o arquivo não contém JSON válido."); }
  return validateBackup(value);
}
export function serializeBackup(backup: Backup) {
  const text = JSON.stringify(validateBackup(backup), null, 2);
  if (text.length > MAX_BACKUP_BYTES || utf8Bytes(text) > MAX_BACKUP_BYTES) throw new Error("O backup ultrapassa o limite de 25 MB desta versão.");
  return text;
}
export function planRestore(backup: Backup, existingBooks: ExistingBook[], existingLogs: ExistingLog[], existingAnnotations: (BackupAnnotation & { deleted_at: string | null })[] = [], existingCatalog: BookMetadata[] = [], existingGoogleCatalog: GoogleBookLink[] = []) {
  const booksById = new Map(existingBooks.map(book => [book.id, book]));
  const logsById = new Map(existingLogs.map(log => [log.id, log]));
  const blockedBooks = new Set<string>();
  const books: BackupBook[] = [], logs: BackupLog[] = [];
  const annotations: BackupAnnotation[] = [];
  const annotationsById = new Map(existingAnnotations.map(row => [row.id, row]));
  const summary: RestoreSummary = { booksAdded: 0, logsAdded: 0, annotationsAdded: 0, metadataAdded: 0, googleLinksAdded: 0, unchanged: 0, skipped: [] };
  for (const book of backup.books) {
    const existing = booksById.get(book.id);
    if (!existing) books.push(book);
    else if (!existing.deleted_at && bookKeys.every(key => book[key] === existing[key])) summary.unchanged++;
    else {
      blockedBooks.add(book.id);
      summary.skipped.push({ kind: "Livro", id: book.id, label: book.title, reason: existing.deleted_at ? "Excluído neste banco." : "Já existe com dados diferentes." });
    }
  }
  for (const log of backup.logs) {
    const existing = logsById.get(log.id);
    if (existing) {
      if (!existing.deleted_at && logKeys.every(key => log[key] === existing[key])) summary.unchanged++;
      else summary.skipped.push({ kind: "Leitura", id: log.id, label: log.started_at, reason: existing.deleted_at ? "Excluída neste banco." : "Já existe com dados diferentes." });
    } else if (blockedBooks.has(log.book_id)) {
      summary.skipped.push({ kind: "Leitura", id: log.id, label: log.started_at, reason: "O livro correspondente tem diferenças ou foi excluído." });
    } else logs.push(log);
  }
  summary.booksAdded = books.length; summary.logsAdded = logs.length;
  for (const annotation of backup.annotations ?? []) {
    const existing = annotationsById.get(annotation.id);
    if (existing) {
      if (!existing.deleted_at && annotationKeys.every(key => annotation[key] === existing[key])) summary.unchanged++;
      else summary.skipped.push({ kind: "Anotação", id: annotation.id, label: annotation.source_title, reason: "Já existe com diferenças ou foi excluída." });
    } else if (blockedBooks.has(annotation.book_id)) {
      summary.skipped.push({ kind: "Anotação", id: annotation.id, label: annotation.source_title, reason: "O livro correspondente tem diferenças ou foi excluído." });
    } else annotations.push(annotation);
  }
  summary.annotationsAdded = annotations.length;
  const catalog: BookMetadata[] = [], catalogByBook = new Map(existingCatalog.map(row => [row.book_id, row]));
  const googleByBook = new Map(existingGoogleCatalog.map(row => [row.book_id, row]));
  for (const row of backup.catalog ?? []) {
    const book = booksById.get(row.book_id), existing = catalogByBook.get(row.book_id);
    if (blockedBooks.has(row.book_id) || book?.deleted_at) {
      summary.skipped.push({ kind: "Catálogo", id: row.book_id, label: row.work_key, reason: "O livro correspondente tem diferenças ou foi excluído." });
    } else if (googleByBook.has(row.book_id)) summary.skipped.push({ kind: "Catálogo", id: row.book_id, label: row.work_key, reason: "O livro já está associado a outra fonte neste aparelho." });
    else if (!existing) catalog.push(row);
    else if (existing.work_key === row.work_key && existing.cover_id === row.cover_id &&
      existing.first_publish_year === row.first_publish_year && JSON.stringify(existing.subjects) === JSON.stringify(row.subjects)) summary.unchanged++;
    else summary.skipped.push({ kind: "Catálogo", id: row.book_id, label: row.work_key, reason: "Já existem dados do catálogo diferentes neste aparelho." });
  }
  summary.metadataAdded = catalog.length;
  const googleCatalog: GoogleBookLink[] = [];
  for (const row of backup.googleCatalog ?? []) {
    const book = booksById.get(row.book_id), existing = googleByBook.get(row.book_id);
    if (blockedBooks.has(row.book_id) || book?.deleted_at) {
      summary.skipped.push({ kind: "Catálogo", id: row.book_id, label: row.volume_id, reason: "O livro correspondente tem diferenças ou foi excluído." });
    } else if (catalogByBook.has(row.book_id)) {
      summary.skipped.push({ kind: "Catálogo", id: row.book_id, label: row.volume_id, reason: "O livro já está associado a outra fonte neste aparelho." });
    } else if (!existing) googleCatalog.push(row);
    else if (existing.volume_id === row.volume_id) summary.unchanged++;
    else summary.skipped.push({ kind: "Catálogo", id: row.book_id, label: row.volume_id, reason: "Já existe outra associação ao Google Books neste aparelho." });
  }
  summary.googleLinksAdded = googleCatalog.length;
  return { books, logs, annotations, catalog, googleCatalog, summary };
}
