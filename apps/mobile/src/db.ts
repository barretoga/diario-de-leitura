import * as SQLite from "expo-sqlite";
import { newId, SyncStore, type BookMetadata, type GoogleBookLink, type NewBookCatalog } from "./sync/store";
import type { BookData, LogData, Snapshot } from "./sync/types";
import type { Clippings } from "./kindle/parser";
import type { AnnotationData } from "./sync/types";
import type { ReadingTimer } from "./timer/readingTimer";

export type Book = BookData & Snapshot;
export type ReadingLog = LogData & Snapshot & { book_title: string };
export type LogInput = Omit<LogData, "created_at">;
let store: SyncStore;
const listeners = new Set<() => void>();
export const onLocalChange = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function changed() { for (const listener of listeners) listener(); }
export async function initializeDatabase() {
  store = new SyncStore(await SQLite.openDatabaseAsync("reading-log.db"));
  await store.initialize();
}
export function getStore() { return store; }
export const listBooks = () => store.listBooks();
export const listBookMetadata = () => store.listBookMetadata();
export const listGoogleBookLinks = () => store.listGoogleBookLinks();
export async function saveBookCatalog(book: Book, title: string, author: string, metadata: BookMetadata) {
  await store.saveBookFromCatalog(book.id, { title: title.trim(), author: author.trim(), created_at: book.created_at }, metadata);
  changed();
}
export async function saveBookGoogle(book: Book, title: string, author: string, link: GoogleBookLink) {
  await store.saveBookFromGoogle(book.id, { title: title.trim(), author: author.trim(), created_at: book.created_at }, link);
  changed();
}
export const listLogs = () => store.listLogs();
export const dailyGoal = () => store.dailyGoal();
export const setDailyGoal = (minutes: number | null) => store.setDailyGoal(minutes);
export const currentTimer = (): Promise<ReadingTimer | null> => store.timer();
export const startTimer = () => store.startTimer();
export const pauseTimer = () => store.pauseTimer();
export const resumeTimer = () => store.resumeTimer();
export const discardTimer = () => store.discardTimer();
export async function addBook(title: string, author: string, catalog: NewBookCatalog | null = null) {
  await store.createBook(newId(), { title: title.trim(), author: author.trim(), created_at: new Date().toISOString() }, catalog);
  changed();
}
export async function updateBook(id: string, title: string, author: string) {
  const old = await store.get("book", id);
  if (!old) throw new Error("Livro não encontrado");
  await store.save("book", id, { title: title.trim(), author: author.trim(), created_at: old.created_at });
  changed();
}
export async function addLog(input: LogInput) {
  await store.save("log", newId(), { ...input, note: input.note.trim(), created_at: new Date().toISOString() });
  changed();
}
export async function addTimedLog(input: LogInput) {
  await store.saveTimedLog(newId(), { ...input, note: input.note.trim(), created_at: new Date().toISOString() });
  changed();
}
export async function updateLog(id: string, input: LogInput) {
  const old = await store.get("log", id);
  if (!old) throw new Error("Log não encontrado");
  await store.save("log", id, { ...input, note: input.note.trim(), created_at: old.created_at });
  changed();
}
export async function deleteLog(id: string) { await store.remove("log", id); changed(); }
export async function restoreBackup(value: unknown) {
  const summary = await store.restoreBackup(value);
  changed();
  return summary;
}
export async function importClippings(parsed: Clippings, mapping: Record<string, string>) {
  const result = await store.importClippings(parsed, mapping); changed(); return result;
}
export async function deleteAnnotation(id: string) { await store.remove("annotation", id); changed(); }
export async function moveAnnotation(id: string, bookId: string) {
  const old = await store.get("annotation", id) as (Snapshot & AnnotationData) | null;
  if (!old || old.deleted_at) throw new Error("Anotação não encontrada");
  await store.save("annotation", id, { ...old, book_id: bookId }); changed();
}
