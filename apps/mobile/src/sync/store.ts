import { isKOReaderLog } from "../logs/source.ts";
import { validateData } from "./types.ts";
import { AUTH_ERROR, OTHER_SERVER, SERVER_MISMATCH, SyncError } from "./transport.ts";
import { planRestore, validateBackup } from "../backup/format.ts";
import type { Backup, BackupAnnotation, BackupBook, BackupLog } from "../backup/format.ts";
import type { AnnotationData, BookData, Data, Entity, Issue, LogData, Operation, Settings, Snapshot, SyncRequest, SyncResponse } from "./types.ts";
import type { Clippings } from "../kindle/parser.ts";
import type { ReadingTimer } from "../timer/readingTimer.ts";

export type BookMetadata = {
  book_id: string;
  work_key: string;
  cover_id: number | null;
  subjects: string[];
  first_publish_year: number | null;
};
export type GoogleBookLink = { book_id: string; volume_id: string };
export type NewBookCatalog = ({ source: "google" } & Omit<GoogleBookLink, "book_id">) |
  ({ source: "openlibrary" } & Omit<BookMetadata, "book_id">);
const validGoogleLink = (link: GoogleBookLink) => /^[A-Za-z0-9_-]{1,80}$/.test(link.volume_id);

function validateBookMetadata(metadata: BookMetadata) {
  return /^\/works\/OL\d+W$/.test(metadata.work_key) &&
    (metadata.cover_id === null || (Number.isSafeInteger(metadata.cover_id) && metadata.cover_id > 0)) &&
    Array.isArray(metadata.subjects) && metadata.subjects.length <= 5 &&
    metadata.subjects.every(subject => typeof subject === "string" && subject.length <= 120) &&
    (metadata.first_publish_year === null || Number.isSafeInteger(metadata.first_publish_year));
}

type Value = string | number | null;
export interface Sql {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: Value[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: Value[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: Value[]): Promise<T[]>;
}
type Row = Snapshot & { local_revision: number };
type Pending = { entity: Entity; id: string; operation_json: string | null; sent_revision: number | null; error: string | null };
const table = (entity: Entity) => ({ book: "books", log: "reading_logs", annotation: "annotations" })[entity];
const columns = (entity: Entity) => entity === "book"
  ? ["title", "author", "created_at"]
  : entity === "log" ? ["book_id", "started_at", "minutes", "progress_value", "progress_unit", "note", "created_at"]
  : ["book_id", "kind", "content", "location", "page", "source_date", "source_title", "source_author", "fingerprint", "created_at"];
export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const now = () => new Date().toISOString();
function dataOf(entity: Entity, row: Snapshot): Data {
  return Object.fromEntries(columns(entity).map(key => [key, (row as unknown as Record<string, Value>)[key]])) as Data;
}
async function rowOf(tx: Sql, entity: Entity, id: string) {
  return tx.getFirstAsync<Row>(`SELECT * FROM ${table(entity)} WHERE id = ?`, id);
}
async function enqueue(tx: Sql, entity: Entity, id: string) {
  // A previously sent payload is never changed, even after a timeout.
  await tx.runAsync(`INSERT INTO sync_pending(entity,id) VALUES (?,?)
    ON CONFLICT(entity,id) DO UPDATE SET error = NULL`, entity, id);
}
async function writeRemote(tx: Sql, entity: Entity, row: Snapshot) {
  const keys = ["id", ...columns(entity), "version", "updated_at", "deleted_at"];
  const values = keys.map(key => (row as unknown as Record<string, Value>)[key]);
  await tx.runAsync(`INSERT INTO ${table(entity)} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})
    ON CONFLICT(id) DO UPDATE SET ${keys.slice(1).map(key => `${key}=excluded.${key}`).join(",")}`, ...values);
}

export class SyncStore {
  private db: Sql;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(db: Sql) { this.db = db; }
  // This store is the only owner of the connection. All access, including reads,
  // is serialized so no unrelated work can enter an open transaction.
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }
  private transaction<T>(action: (tx: Sql) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      // Use the same connection so foreign_keys=ON applies to every transaction.
      await this.db.execAsync("BEGIN IMMEDIATE");
      try {
        const result = await action(this.db);
        await this.db.execAsync("COMMIT");
        return result;
      } catch (error) {
        await this.db.execAsync("ROLLBACK");
        throw error;
      }
    });
  }
  async initialize() {
    await this.db.execAsync("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    await this.transaction(async tx => {
      const version = await tx.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
      if ((version?.user_version ?? 0) > 8) throw new Error("Banco de uma versão mais recente do aplicativo");
      if (version?.user_version === 8) return;
      if ((version?.user_version ?? 0) < 1) {
      await tx.execAsync(`
        CREATE TABLE IF NOT EXISTS books (
          id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reading_logs (
          id TEXT PRIMARY KEY NOT NULL, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
          started_at TEXT NOT NULL, minutes INTEGER NOT NULL DEFAULT 0 CHECK(minutes>=0),
          progress_value REAL, progress_unit TEXT CHECK(progress_unit IN ('page','location','percent')),
          note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
          CHECK ((progress_value IS NULL AND progress_unit IS NULL) OR (progress_value IS NOT NULL AND progress_unit IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS idx_reading_logs_date ON reading_logs(started_at DESC);
        CREATE TABLE sync_pending (
          entity TEXT NOT NULL, id TEXT NOT NULL, operation_json TEXT, sent_revision INTEGER, error TEXT,
          PRIMARY KEY(entity,id)
        );
        CREATE TABLE sync_conflicts (entity TEXT NOT NULL,id TEXT NOT NULL,current_json TEXT NOT NULL,PRIMARY KEY(entity,id));
        CREATE TABLE sync_settings (
          id INTEGER PRIMARY KEY CHECK(id=1), url TEXT NOT NULL DEFAULT '', paused INTEGER NOT NULL DEFAULT 0,
          cursor INTEGER NOT NULL DEFAULT 0,last_success TEXT,fatal TEXT
        );
        INSERT INTO sync_settings(id) VALUES(1);
      `);
      for (const entity of ["book", "log"] as const) {
        await tx.execAsync(`ALTER TABLE ${table(entity)} ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE ${table(entity)} ADD COLUMN updated_at TEXT;
          ALTER TABLE ${table(entity)} ADD COLUMN deleted_at TEXT;
          ALTER TABLE ${table(entity)} ADD COLUMN local_revision INTEGER NOT NULL DEFAULT 1;
          UPDATE ${table(entity)} SET updated_at=created_at;`);
        await tx.runAsync(`INSERT INTO sync_pending(entity,id) SELECT ?,id FROM ${table(entity)}`, entity);
      }
      await tx.execAsync("PRAGMA user_version=1;");
      }
      if ((version?.user_version ?? 0) < 2) await tx.execAsync(`CREATE TABLE annotations (
        id TEXT PRIMARY KEY NOT NULL, book_id TEXT NOT NULL REFERENCES books(id),
        kind TEXT NOT NULL CHECK(kind IN ('highlight','note','bookmark')), content TEXT NOT NULL,
        location TEXT, page TEXT, source_date TEXT, source_title TEXT NOT NULL, source_author TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        deleted_at TEXT, version INTEGER NOT NULL DEFAULT 0, local_revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_annotations_book ON annotations(book_id);
      PRAGMA user_version=2;`);
      if ((version?.user_version ?? 0) < 3) await tx.execAsync(`CREATE TABLE reading_preferences (
        id INTEGER PRIMARY KEY CHECK(id=1),
        daily_goal_minutes INTEGER CHECK(daily_goal_minutes IS NULL OR daily_goal_minutes BETWEEN 1 AND 1440)
      );
      INSERT INTO reading_preferences(id,daily_goal_minutes) VALUES(1,NULL);
      PRAGMA user_version=3;`);
      if ((version?.user_version ?? 0) < 4) await tx.execAsync(`CREATE TABLE reading_timer (
        id INTEGER PRIMARY KEY CHECK(id=1), started_at TEXT NOT NULL,
        resumed_at TEXT, elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK(elapsed_ms>=0)
      );
      PRAGMA user_version=4;`);
      if ((version?.user_version ?? 0) < 5) await tx.execAsync(`CREATE TABLE book_catalog (
        book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        work_key TEXT NOT NULL, cover_id INTEGER,
        subjects_json TEXT NOT NULL DEFAULT '[]', first_publish_year INTEGER
      );
      PRAGMA user_version=5;`);
      if ((version?.user_version ?? 0) < 6) await tx.execAsync(`CREATE TABLE google_catalog (
        book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        volume_id TEXT NOT NULL
      );
      PRAGMA user_version=6;`);
      if ((version?.user_version ?? 0) < 7) await tx.execAsync(`CREATE TABLE IF NOT EXISTS kindle_catalog_lookup (
        book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        expected_version INTEGER NOT NULL, expected_revision INTEGER NOT NULL,
        done INTEGER NOT NULL DEFAULT 0 CHECK(done IN(0,1))
      );
      PRAGMA user_version=7;`);
      if ((version?.user_version ?? 0) < 8) {
        const columns = await tx.getAllAsync<{ name: string }>("PRAGMA table_info(sync_settings)");
        if (!columns.some(column => column.name === "server_id")) await tx.execAsync("ALTER TABLE sync_settings ADD COLUMN server_id TEXT;");
        await tx.execAsync("PRAGMA user_version=8;");
      }
    });
  }
  listBooks() {
    return this.serial(() => this.db.getAllAsync<Snapshot & BookData>("SELECT * FROM books WHERE deleted_at IS NULL ORDER BY title COLLATE NOCASE"));
  }
  pendingKindleCatalogBooks() {
    return this.serial(() => this.db.getAllAsync<Snapshot & BookData>(`SELECT b.* FROM books b
      JOIN kindle_catalog_lookup q ON q.book_id=b.id WHERE q.done=0 ORDER BY b.created_at,b.id`));
  }
  finishKindleCatalogLookup(id: string, draft: { title: string; author: string; catalog: NewBookCatalog | null } | null) {
    if (draft && (validateData("book", { ...draft, created_at: now() }) || !draft.catalog ||
      !(draft.catalog.source === "google" ? validGoogleLink({ ...draft.catalog, book_id: id }) : validateBookMetadata({ ...draft.catalog, book_id: id })))) {
      return Promise.reject(new Error("Dados inválidos do catálogo"));
    }
    return this.transaction(async tx => {
      const queued = await tx.getFirstAsync<{ expected_version: number; expected_revision: number; done: number }>("SELECT * FROM kindle_catalog_lookup WHERE book_id=?", id);
      if (!queued || queued.done) return;
      const row = await rowOf(tx, "book", id);
      await tx.runAsync("UPDATE kindle_catalog_lookup SET done=1 WHERE book_id=?", id);
      if (!draft || !row || row.deleted_at || row.version !== queued.expected_version || row.local_revision !== queued.expected_revision ||
        await tx.getFirstAsync("SELECT id FROM sync_pending WHERE entity='book' AND id=?", id) ||
        await tx.getFirstAsync("SELECT book_id FROM google_catalog WHERE book_id=? UNION SELECT book_id FROM book_catalog WHERE book_id=?", id, id)) return;
      const old = row as Row & BookData;
      if (old.title !== draft.title || old.author !== draft.author) {
        await writeRemote(tx, "book", { id, title: draft.title, author: draft.author, created_at: old.created_at,
          version: old.version, updated_at: now(), deleted_at: null });
        await tx.runAsync("UPDATE books SET local_revision=local_revision+1 WHERE id=?", id);
        await enqueue(tx, "book", id);
      }
      const catalog = draft.catalog!;
      if (catalog.source === "google") await tx.runAsync("INSERT INTO google_catalog(book_id,volume_id) VALUES(?,?)", id, catalog.volume_id);
      else await tx.runAsync("INSERT INTO book_catalog(book_id,work_key,cover_id,subjects_json,first_publish_year) VALUES(?,?,?,?,?)",
        id, catalog.work_key, catalog.cover_id, JSON.stringify(catalog.subjects), catalog.first_publish_year);
    });
  }
  createBook(id: string, data: BookData, catalog: NewBookCatalog | null = null) {
    const error = validateData("book", data);
    if (error) return Promise.reject(new Error(error));
    if (catalog && !(catalog.source === "google" ? validGoogleLink({ ...catalog, book_id: id }) :
      catalog.source === "openlibrary" && validateBookMetadata({ ...catalog, book_id: id }))) {
      return Promise.reject(new Error("Dados inválidos do catálogo"));
    }
    return this.transaction(async tx => {
      if (await rowOf(tx, "book", id)) throw new Error("Livro já existe");
      await writeRemote(tx, "book", { ...data, id, version: 0, updated_at: now(), deleted_at: null });
      await tx.runAsync("UPDATE books SET local_revision=1 WHERE id=?", id);
      await enqueue(tx, "book", id);
      if (catalog?.source === "google") {
        await tx.runAsync("INSERT INTO google_catalog(book_id,volume_id) VALUES(?,?)", id, catalog.volume_id);
      } else if (catalog?.source === "openlibrary") {
        await tx.runAsync("INSERT INTO book_catalog(book_id,work_key,cover_id,subjects_json,first_publish_year) VALUES(?,?,?,?,?)",
          id, catalog.work_key, catalog.cover_id, JSON.stringify(catalog.subjects), catalog.first_publish_year);
      }
    });
  }
  listBookMetadata(): Promise<BookMetadata[]> {
    return this.serial(async () => {
      const rows = await this.db.getAllAsync<Omit<BookMetadata, "subjects"> & { subjects_json: string }>(
        "SELECT book_catalog.* FROM book_catalog JOIN books ON books.id=book_catalog.book_id WHERE books.deleted_at IS NULL");
      return rows.map(({ subjects_json, ...row }) => ({ ...row, subjects: JSON.parse(subjects_json) as string[] }));
    });
  }
  listGoogleBookLinks(): Promise<GoogleBookLink[]> {
    return this.serial(async () => (await this.db.getAllAsync<GoogleBookLink>(
      "SELECT google_catalog.* FROM google_catalog JOIN books ON books.id=google_catalog.book_id WHERE books.deleted_at IS NULL"))
      .map(row => ({ book_id: row.book_id, volume_id: row.volume_id })));
  }
  setBookMetadata(metadata: BookMetadata) {
    if (!validateBookMetadata(metadata)) throw new Error("Dados inválidos do catálogo");
    return this.transaction(async tx => {
      const book = await tx.getFirstAsync<{ id: string }>("SELECT id FROM books WHERE id=? AND deleted_at IS NULL", metadata.book_id);
      if (!book) throw new Error("Livro não encontrado");
      await tx.runAsync("DELETE FROM google_catalog WHERE book_id=?", metadata.book_id);
      await tx.runAsync(`INSERT INTO book_catalog(book_id,work_key,cover_id,subjects_json,first_publish_year)
        VALUES(?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET work_key=excluded.work_key,
        cover_id=excluded.cover_id,subjects_json=excluded.subjects_json,first_publish_year=excluded.first_publish_year`,
        metadata.book_id, metadata.work_key, metadata.cover_id, JSON.stringify(metadata.subjects), metadata.first_publish_year);
    });
  }
  saveBookFromCatalog(id: string, data: BookData, metadata: BookMetadata) {
    const error = validateData("book", data);
    if (error) return Promise.reject(new Error(error));
    if (metadata.book_id !== id || !validateBookMetadata(metadata)) return Promise.reject(new Error("Dados inválidos do catálogo"));
    return this.transaction(async tx => {
      const old = await rowOf(tx, "book", id);
      if (!old || old.deleted_at) throw new Error("Livro não encontrado");
      if ((old as Row & BookData).title !== data.title || (old as Row & BookData).author !== data.author) {
        await writeRemote(tx, "book", { ...data, id, created_at: old.created_at,
          version: old.version, updated_at: now(), deleted_at: null });
        await tx.runAsync("UPDATE books SET local_revision=? WHERE id=?", old.local_revision + 1, id);
        await enqueue(tx, "book", id);
      }
      await tx.runAsync(`INSERT INTO book_catalog(book_id,work_key,cover_id,subjects_json,first_publish_year)
        VALUES(?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET work_key=excluded.work_key,
        cover_id=excluded.cover_id,subjects_json=excluded.subjects_json,first_publish_year=excluded.first_publish_year`,
        id, metadata.work_key, metadata.cover_id, JSON.stringify(metadata.subjects), metadata.first_publish_year);
      await tx.runAsync("DELETE FROM google_catalog WHERE book_id=?", id);
    });
  }
  saveBookFromGoogle(id: string, data: BookData, link: GoogleBookLink) {
    const error = validateData("book", data);
    if (error) return Promise.reject(new Error(error));
    if (link.book_id !== id || !validGoogleLink(link)) return Promise.reject(new Error("Identificador do Google Books inválido"));
    return this.transaction(async tx => {
      const old = await rowOf(tx, "book", id);
      if (!old || old.deleted_at) throw new Error("Livro não encontrado");
      if ((old as Row & BookData).title !== data.title || (old as Row & BookData).author !== data.author) {
        await writeRemote(tx, "book", { ...data, id, created_at: old.created_at,
          version: old.version, updated_at: now(), deleted_at: null });
        await tx.runAsync("UPDATE books SET local_revision=? WHERE id=?", old.local_revision + 1, id);
        await enqueue(tx, "book", id);
      }
      await tx.runAsync("INSERT INTO google_catalog(book_id,volume_id) VALUES(?,?) ON CONFLICT(book_id) DO UPDATE SET volume_id=excluded.volume_id", id, link.volume_id);
      await tx.runAsync("DELETE FROM book_catalog WHERE book_id=?", id);
    });
  }
  listLogs() {
    return this.serial(() => this.db.getAllAsync<Snapshot & LogData & { book_title: string }>(`
      SELECT reading_logs.*,books.title AS book_title FROM reading_logs JOIN books ON books.id=reading_logs.book_id
      WHERE reading_logs.deleted_at IS NULL ORDER BY started_at DESC,reading_logs.created_at DESC`));
  }
  dailyGoal(): Promise<number | null> {
    return this.serial(async () => {
      const row = await this.db.getFirstAsync<{ daily_goal_minutes: number | null }>("SELECT daily_goal_minutes FROM reading_preferences WHERE id=1");
      if (!row) throw new Error("Preferências não inicializadas");
      return row.daily_goal_minutes;
    });
  }
  setDailyGoal(minutes: number | null) {
    if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440)) {
      return Promise.reject(new Error("Informe uma meta de 1 a 1.440 minutos por dia."));
    }
    return this.transaction(async tx => {
      await tx.runAsync("UPDATE reading_preferences SET daily_goal_minutes=? WHERE id=1", minutes);
    });
  }
  timer(): Promise<ReadingTimer | null> {
    return this.serial(() => this.db.getFirstAsync<ReadingTimer>("SELECT started_at,resumed_at,elapsed_ms FROM reading_timer WHERE id=1"));
  }
  startTimer(at = now()) {
    return this.transaction(async tx => {
      const existing = await tx.getFirstAsync<ReadingTimer>("SELECT started_at,resumed_at,elapsed_ms FROM reading_timer WHERE id=1");
      if (existing) throw new Error("Já existe um cronômetro. Continue ou descarte a sessão anterior.");
      await tx.runAsync("INSERT INTO reading_timer(id,started_at,resumed_at,elapsed_ms) VALUES(1,?,?,0)", at, at);
      return { started_at: at, resumed_at: at, elapsed_ms: 0 } satisfies ReadingTimer;
    });
  }
  pauseTimer(at = now()) {
    return this.transaction(async tx => {
      const timer = await tx.getFirstAsync<ReadingTimer>("SELECT started_at,resumed_at,elapsed_ms FROM reading_timer WHERE id=1");
      if (!timer) throw new Error("Cronômetro não encontrado");
      if (!timer.resumed_at) return timer;
      const elapsed_ms = timer.elapsed_ms + Math.max(0, Date.parse(at) - Date.parse(timer.resumed_at));
      await tx.runAsync("UPDATE reading_timer SET resumed_at=NULL,elapsed_ms=? WHERE id=1", elapsed_ms);
      return { ...timer, resumed_at: null, elapsed_ms };
    });
  }
  resumeTimer(at = now()) {
    return this.transaction(async tx => {
      const timer = await tx.getFirstAsync<ReadingTimer>("SELECT started_at,resumed_at,elapsed_ms FROM reading_timer WHERE id=1");
      if (!timer) throw new Error("Cronômetro não encontrado");
      if (timer.resumed_at) return timer;
      await tx.runAsync("UPDATE reading_timer SET resumed_at=? WHERE id=1", at);
      return { ...timer, resumed_at: at };
    });
  }
  discardTimer() { return this.transaction(async tx => { await tx.runAsync("DELETE FROM reading_timer WHERE id=1"); }); }
  get(entity: Entity, id: string) { return this.serial(() => rowOf(this.db, entity, id)); }
  listAnnotations() {
    return this.serial(() => this.db.getAllAsync<Snapshot & AnnotationData & { book_title: string }>(`
      SELECT a.*,b.title AS book_title FROM annotations a JOIN books b ON b.id=a.book_id
      WHERE a.deleted_at IS NULL ORDER BY a.created_at DESC,a.id`));
  }
  annotationFingerprints() {
    // Include tombstones so reimporting a file does not revive a deleted annotation.
    return this.serial(() => this.db.getAllAsync<{ fingerprint: string }>("SELECT fingerprint FROM annotations"));
  }
  importClippings(parsed: Clippings, mapping: Record<string, string>) {
    return this.transaction(async tx => {
      const groups = new Map(parsed.groups.map(group => [group.key, group]));
      const known = new Set((await tx.getAllAsync<{ fingerprint: string }>("SELECT fingerprint FROM annotations")).map(row => row.fingerprint));
      let added = 0, duplicates = parsed.duplicates, skipped = parsed.rejected.length, booksAdded = 0;
      for (const entry of parsed.entries) {
        if (known.has(entry.fingerprint)) { duplicates++; continue; }
        const choice = mapping[entry.group];
        if (!choice || choice === "skip") { skipped++; continue; }
        const group = groups.get(entry.group);
        if (!group) throw new Error("Livro da importação não encontrado");
        const bookId = choice === "new" ? group.suggestedId : choice;
        const existing = await rowOf(tx, "book", bookId);
        if (existing?.deleted_at) throw new Error("Um livro escolhido foi excluído. Revise a associação e tente novamente.");
        if (!existing) {
          if (choice !== "new") throw new Error("Um livro escolhido não existe mais. Revise a associação.");
          const error = validateData("book", { title: group.title, author: group.author, created_at: now() });
          if (error) throw new Error(error);
          await writeRemote(tx, "book", { id: bookId, title: group.title, author: group.author, created_at: now(), updated_at: now(), deleted_at: null, version: 0 });
          await enqueue(tx, "book", bookId); booksAdded++;
        }
        const data: AnnotationData = {
          book_id: bookId, kind: entry.kind, content: entry.content, location: entry.location, page: entry.page,
          source_date: entry.source_date, source_title: entry.title, source_author: entry.author,
          fingerprint: entry.fingerprint, created_at: now(),
        };
        const error = validateData("annotation", data);
        if (error) throw new Error(error);
        const id = `kindle-${entry.fingerprint}`;
        await writeRemote(tx, "annotation", { ...data, id, version: 0, updated_at: now(), deleted_at: null });
        await enqueue(tx, "annotation", id); known.add(entry.fingerprint); added++;
      }
      return { added, duplicates, skipped, booksAdded };
    });
  }
  exportBackup(): Promise<Backup> {
    return this.transaction(async tx => validateBackup({
      format: "reading-log-backup", version: 4, exportedAt: now(),
      // Include the parent of every active log, even if that parent was deleted remotely.
      books: await tx.getAllAsync(`SELECT id,title,author,created_at FROM books WHERE deleted_at IS NULL
        OR id IN (SELECT book_id FROM reading_logs WHERE deleted_at IS NULL)
        OR id IN (SELECT book_id FROM annotations WHERE deleted_at IS NULL) ORDER BY id`),
      logs: await tx.getAllAsync(`SELECT id,book_id,started_at,minutes,progress_value,progress_unit,note,created_at
        FROM reading_logs WHERE deleted_at IS NULL ORDER BY id`),
      annotations: await tx.getAllAsync(`SELECT id,${columns("annotation").join(",")} FROM annotations WHERE deleted_at IS NULL ORDER BY id`),
      catalog: (await tx.getAllAsync<Omit<BookMetadata, "subjects"> & { subjects_json: string }>(
        "SELECT c.* FROM book_catalog c JOIN books b ON b.id=c.book_id WHERE b.deleted_at IS NULL ORDER BY c.book_id"))
        .map(({ subjects_json, ...row }) => ({ ...row, subjects: JSON.parse(subjects_json) as string[] })),
      googleCatalog: await tx.getAllAsync<GoogleBookLink>(
        "SELECT c.* FROM google_catalog c JOIN books b ON b.id=c.book_id WHERE b.deleted_at IS NULL ORDER BY c.book_id"),
    }));
  }
  private async restoration(tx: Sql, backup: Backup) {
    return planRestore(backup,
      await tx.getAllAsync<BackupBook & { deleted_at: string | null }>("SELECT * FROM books"),
      await tx.getAllAsync<BackupLog & { deleted_at: string | null }>("SELECT * FROM reading_logs"),
      await tx.getAllAsync<BackupAnnotation & { deleted_at: string | null }>("SELECT * FROM annotations"),
      (await tx.getAllAsync<Omit<BookMetadata, "subjects"> & { subjects_json: string }>("SELECT * FROM book_catalog"))
        .map(({ subjects_json, ...row }) => ({ ...row, subjects: JSON.parse(subjects_json) as string[] })),
      await tx.getAllAsync<GoogleBookLink>("SELECT * FROM google_catalog"));
  }
  previewRestore(value: unknown) {
    const backup = validateBackup(value);
    return this.transaction(async tx => (await this.restoration(tx, backup)).summary);
  }
  restoreBackup(value: unknown) {
    const backup = validateBackup(value);
    return this.transaction(async tx => {
      // Recompute under the write transaction; a preview never authorizes overwriting newer data.
      const plan = await this.restoration(tx, backup);
      for (const [entity, records] of [["book", plan.books], ["log", plan.logs], ["annotation", plan.annotations]] as const) {
        for (const record of records) {
          await writeRemote(tx, entity, { ...record, version: 0, updated_at: now(), deleted_at: null });
          await enqueue(tx, entity, record.id);
        }
      }
      for (const row of plan.catalog) await tx.runAsync(
        "INSERT INTO book_catalog(book_id,work_key,cover_id,subjects_json,first_publish_year) VALUES(?,?,?,?,?)",
        row.book_id, row.work_key, row.cover_id, JSON.stringify(row.subjects), row.first_publish_year);
      for (const row of plan.googleCatalog) await tx.runAsync(
        "INSERT INTO google_catalog(book_id,volume_id) VALUES(?,?)", row.book_id, row.volume_id);
      return plan.summary;
    });
  }
  save(entity: Entity, id: string, data: Data) {
    if (entity === "log" && isKOReaderLog(id)) return Promise.reject(new Error("Leituras do KOReader são atualizadas pela integração"));
    const error = validateData(entity, data);
    if (error) return Promise.reject(new Error(error));
    if (entity === "annotation" && id !== `kindle-${(data as AnnotationData).fingerprint}`) return Promise.reject(new Error("Identificador inválido"));
    return this.transaction(async tx => {
      if (entity !== "book") {
        const book = await rowOf(tx, "book", (data as LogData).book_id);
        if (!book || book.deleted_at) throw new Error("Selecione um livro ativo");
      }
      const old = await rowOf(tx, entity, id);
      await writeRemote(tx, entity, { ...data, id, created_at: old?.created_at ?? data.created_at,
        version: old?.version ?? 0, updated_at: now(), deleted_at: null });
      await tx.runAsync(`UPDATE ${table(entity)} SET local_revision=? WHERE id=?`, (old?.local_revision ?? 0) + 1, id);
      await enqueue(tx, entity, id);
    });
  }
  saveTimedLog(id: string, data: LogData) {
    const error = validateData("log", data);
    if (error) return Promise.reject(new Error(error));
    return this.transaction(async tx => {
      const timer = await tx.getFirstAsync<ReadingTimer>("SELECT started_at,resumed_at,elapsed_ms FROM reading_timer WHERE id=1");
      if (!timer || timer.resumed_at) throw new Error("Pause o cronômetro antes de registrar a leitura.");
      const book = await rowOf(tx, "book", data.book_id);
      if (!book || book.deleted_at) throw new Error("Selecione um livro ativo");
      if (await rowOf(tx, "log", id)) throw new Error("Leitura já registrada");
      await writeRemote(tx, "log", { ...data, id, version: 0, updated_at: now(), deleted_at: null });
      await enqueue(tx, "log", id);
      await tx.runAsync("DELETE FROM reading_timer WHERE id=1");
    });
  }
  remove(entity: Entity, id: string) {
    return this.transaction(async tx => {
      await tx.runAsync(`UPDATE ${table(entity)} SET deleted_at=?,updated_at=?,local_revision=local_revision+1 WHERE id=?`, now(), now(), id);
      await enqueue(tx, entity, id);
    });
  }
  settings(): Promise<Settings> {
    return this.serial(async () => {
      const row = await this.db.getFirstAsync<{ url: string; paused: number; cursor: number; last_success: string | null; fatal: string | null; server_id: string | null }>("SELECT * FROM sync_settings WHERE id=1");
      if (!row) throw new Error("Banco não inicializado");
      return { url: row.url, paused: !!row.paused, cursor: row.cursor, lastSuccess: row.last_success, fatal: row.fatal, serverId: row.server_id };
    });
  }
  configure(url: string) {
    return this.transaction(async tx => {
      const old = await tx.getFirstAsync<{ url: string }>("SELECT url FROM sync_settings WHERE id=1");
      if (old?.url && old.url !== url) throw new Error("Este banco já está vinculado a outro servidor");
      await tx.runAsync("UPDATE sync_settings SET url=? WHERE id=1", url);
    });
  }
  /** Rebinds the URL only when the memorized server identity matches; cursor, queue, conflicts and token stay untouched. */
  migrate(url: string, serverId: string) {
    return this.transaction(async tx => {
      const known = (await tx.getFirstAsync<{ server_id: string | null }>("SELECT server_id FROM sync_settings WHERE id=1"))?.server_id ?? null;
      if (known === null || known !== serverId) throw new Error(OTHER_SERVER);
      await tx.runAsync("UPDATE sync_settings SET url=?,fatal=CASE WHEN fatal IN (?,?) THEN NULL ELSE fatal END WHERE id=1", url, SERVER_MISMATCH, AUTH_ERROR);
    });
  }
  pause(paused: boolean) { return this.transaction(async tx => { await tx.runAsync("UPDATE sync_settings SET paused=? WHERE id=1", Number(paused)); }); }
  block(message: string) { return this.transaction(async tx => { await tx.runAsync("UPDATE sync_settings SET fatal=? WHERE id=1", message); }); }
  clearBlock(message: string) { return this.transaction(async tx => { await tx.runAsync("UPDATE sync_settings SET fatal=NULL WHERE id=1 AND fatal=?", message); }); }
  success() { return this.transaction(async tx => { await tx.runAsync("UPDATE sync_settings SET last_success=? WHERE id=1", now()); }); }
  pendingCount() { return this.serial(async () => (await this.db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM sync_pending"))!.n); }
  issues(): Promise<Issue[]> {
    return this.serial(async () => {
      const rows = await this.db.getAllAsync<Pending & { current_json: string | null }>(`
        SELECT p.*,c.current_json FROM sync_pending p LEFT JOIN sync_conflicts c ON c.entity=p.entity AND c.id=p.id
        WHERE p.error IS NOT NULL OR c.id IS NOT NULL`);
      return Promise.all(rows.map(async p => ({ entity: p.entity, id: p.id, error: p.error,
        local: (await rowOf(this.db, p.entity, p.id))!, conflict: p.current_json !== null,
        remote: p.current_json ? JSON.parse(p.current_json) : null })));
    });
  }
  prepare(): Promise<SyncRequest> {
    return this.transaction(async tx => {
      const settings = await tx.getFirstAsync<{ cursor: number }>("SELECT cursor FROM sync_settings WHERE id=1");
      const pending = await tx.getAllAsync<Pending>(`SELECT p.* FROM sync_pending p
        LEFT JOIN sync_conflicts c ON c.entity=p.entity AND c.id=p.id
        WHERE c.id IS NULL AND p.error IS NULL ORDER BY CASE p.entity WHEN 'book' THEN 0 ELSE 1 END,p.id`);
      const operations: Operation[] = [];
      let bytesUpperBound = 100;
      for (const p of pending) {
        const row = (await rowOf(tx, p.entity, p.id))!;
        const frozen: Operation | null = p.operation_json ? JSON.parse(p.operation_json) : null;
        if (p.entity !== "book" && !(frozen ? frozen.deleted : row.deleted_at)) {
          const bookId = p.operation_json ? (JSON.parse(p.operation_json).data?.book_id ?? (row as Row & LogData).book_id) : (row as Row & LogData).book_id;
          const parent = await rowOf(tx, "book", bookId);
          const parentPending = await tx.getFirstAsync("SELECT id FROM sync_pending WHERE entity='book' AND id=?", bookId);
          if (parent?.deleted_at && !parentPending && !frozen) {
            await tx.runAsync("UPDATE sync_pending SET error=? WHERE entity=? AND id=?", "Livro excluído no servidor. Selecione outro livro para este registro.", p.entity, p.id);
          }
          if (!parent || !parent.version || parent.deleted_at || parentPending) continue;
        }
        if (!p.operation_json && row.deleted_at && row.version === 0) {
          await tx.runAsync("DELETE FROM sync_pending WHERE entity=? AND id=?", p.entity, p.id);
          continue; // A never-sent local creation can be deleted without contacting the server.
        }
        const data = dataOf(p.entity, row);
        const error = !p.operation_json && !row.deleted_at ? validateData(p.entity, data) : null;
        if (error) {
          await tx.runAsync("UPDATE sync_pending SET error=? WHERE entity=? AND id=?", error, p.entity, p.id);
          continue;
        }
        const operation: Operation = p.operation_json ? JSON.parse(p.operation_json) : {
          opId: newId(), entity: p.entity, id: p.id, baseVersion: row.version, deleted: !!row.deleted_at,
          ...(!row.deleted_at ? { data } : {}),
        };
        const encoded = JSON.stringify(operation);
        // UTF-8 is at most 3 bytes per UTF-16 code unit. Stay below the API's 1 MB body limit.
        if (operations.length && bytesUpperBound + encoded.length * 3 > 900000) break;
        bytesUpperBound += encoded.length * 3;
        if (!p.operation_json) await tx.runAsync("UPDATE sync_pending SET operation_json=?,sent_revision=? WHERE entity=? AND id=?", encoded, row.local_revision, p.entity, p.id);
        operations.push(operation);
        if (operations.length === 100) break;
      }
      return { cursor: settings!.cursor, operations };
    });
  }
  apply(request: SyncRequest, response: SyncResponse) {
    return this.transaction(async tx => {
      if (response.serverId !== undefined) {
        // Verify identity before any write; an old server that omits it stays compatible.
        const known = (await tx.getFirstAsync<{ server_id: string | null }>("SELECT server_id FROM sync_settings WHERE id=1"))?.server_id ?? null;
        if (known !== null && known !== response.serverId) throw new SyncError("protocol", SERVER_MISMATCH);
        if (known === null) await tx.runAsync("UPDATE sync_settings SET server_id=? WHERE id=1", response.serverId);
      }
      for (const result of response.results) {
        const operation = request.operations.find(op => op.opId === result.opId)!;
        const { entity, id } = operation;
        const pending = await tx.getFirstAsync<Pending>("SELECT * FROM sync_pending WHERE entity=? AND id=?", entity, id);
        if (!pending || pending.operation_json !== JSON.stringify(operation)) throw new Error("Operação pendente divergente");
        const row = (await rowOf(tx, entity, id))!;
        if (result.status === "accepted") {
          await tx.runAsync(`UPDATE ${table(entity)} SET version=MAX(version,?) WHERE id=?`, result.version, id);
          if (row.local_revision === pending.sent_revision) {
            await tx.runAsync("DELETE FROM sync_pending WHERE entity=? AND id=?", entity, id);
          } else {
            await tx.runAsync("UPDATE sync_pending SET operation_json=NULL,sent_revision=NULL,error=NULL WHERE entity=? AND id=?", entity, id);
          }
        } else if (result.status === "conflict") {
          await tx.runAsync("INSERT OR REPLACE INTO sync_conflicts VALUES(?,?,?)", entity, id, JSON.stringify(result.current));
          await tx.runAsync("UPDATE sync_pending SET operation_json=NULL,sent_revision=NULL WHERE entity=? AND id=?", entity, id);
        } else {
          // An invalid result is definitive, so edits may replace this rejected operation.
          await tx.runAsync("UPDATE sync_pending SET operation_json=NULL,sent_revision=NULL,error=? WHERE entity=? AND id=?",
            row.local_revision === pending.sent_revision ? (entity === "annotation" && result.reason === "Entidade inválida"
              ? "Atualize a API para sincronizar anotações. Depois, selecione novamente o livro desta anotação para reenviar."
              : result.reason) : null, entity, id);
        }
      }
      for (const change of response.changes) {
        const { entity, id, payload } = change;
        const row = await rowOf(tx, entity, id);
        const pending = await tx.getFirstAsync<Pending>("SELECT * FROM sync_pending WHERE entity=? AND id=?", entity, id);
        const conflict = await tx.getFirstAsync<{ current_json: string }>("SELECT current_json FROM sync_conflicts WHERE entity=? AND id=?", entity, id);
        if (conflict) {
          const current: Snapshot | null = JSON.parse(conflict.current_json);
          if (payload.version > (current?.version ?? 0)) await tx.runAsync("UPDATE sync_conflicts SET current_json=? WHERE entity=? AND id=?", JSON.stringify(payload), entity, id);
        } else if (pending) {
          if (payload.version > (row?.version ?? 0)) {
            await tx.runAsync("INSERT INTO sync_conflicts VALUES(?,?,?)", entity, id, JSON.stringify(payload));
          }
        } else if (payload.version >= (row?.version ?? 0)) {
          await writeRemote(tx, entity, payload);
          if (entity === "book" && !row && !payload.deleted_at && payload.origin === "koreader") {
            await tx.runAsync("INSERT OR IGNORE INTO kindle_catalog_lookup(book_id,expected_version,expected_revision) VALUES(?,?,1)", id, payload.version);
          }
        }
      }
      await tx.runAsync("UPDATE sync_settings SET cursor=? WHERE id=1", response.cursor);
    });
  }
  resolve(entity: Entity, id: string, choice: "local" | "remote") {
    return this.transaction(async tx => {
      const conflict = await tx.getFirstAsync<{ current_json: string }>("SELECT current_json FROM sync_conflicts WHERE entity=? AND id=?", entity, id);
      if (!conflict) return;
      const remote: Snapshot | null = JSON.parse(conflict.current_json);
      const local = (await rowOf(tx, entity, id))!;
      if (choice === "remote") {
        if (remote) await writeRemote(tx, entity, remote);
        else await tx.runAsync(`UPDATE ${table(entity)} SET deleted_at=?,version=0 WHERE id=?`, now(), id);
        await tx.runAsync("DELETE FROM sync_pending WHERE entity=? AND id=?", entity, id);
      } else {
        await tx.runAsync(`UPDATE ${table(entity)} SET version=?,local_revision=local_revision+1 WHERE id=?`, remote?.version ?? 0, id);
        await tx.runAsync("UPDATE sync_pending SET operation_json=NULL,sent_revision=NULL,error=NULL WHERE entity=? AND id=?", entity, id);
      }
      await tx.runAsync("DELETE FROM sync_conflicts WHERE entity=? AND id=?", entity, id);
      // If a remote book deletion is chosen, preserve unsent local logs as correctable issues.
      if (entity === "book" && choice === "remote" && (!remote || remote.deleted_at)) {
        await tx.runAsync(`UPDATE sync_pending SET error='Livro excluído no servidor. Edite o log e selecione outro livro.'
          WHERE entity='log' AND id IN (SELECT id FROM reading_logs WHERE book_id=? AND deleted_at IS NULL)`, local.id);
        await tx.runAsync(`UPDATE sync_pending SET error='Livro excluído no servidor. Selecione outro livro para a anotação.'
          WHERE entity='annotation' AND id IN (SELECT id FROM annotations WHERE book_id=? AND deleted_at IS NULL)`, local.id);
      }
    });
  }
}
