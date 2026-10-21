import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrateKOReader } from './koreader/migrations.js';
import { migrateIdentity } from './identity.js';
import { isDerivedLog } from './koreader/store.js';

const entities = {
  book: {
    table: 'books',
    columns: ['title', 'author', 'created_at'],
  },
  log: {
    table: 'reading_logs',
    columns: ['book_id', 'started_at', 'minutes', 'progress_value', 'progress_unit', 'note', 'created_at'],
  },
  annotation: {
    table: 'annotations',
    columns: ['book_id', 'kind', 'content', 'location', 'page', 'source_date', 'source_title', 'source_author', 'fingerprint', 'created_at'],
  },
};

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reading_logs (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id),
      started_at TEXT NOT NULL,
      minutes INTEGER NOT NULL CHECK (minutes >= 0),
      progress_value REAL,
      progress_unit TEXT CHECK (progress_unit IN ('page', 'location', 'percent')),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      version INTEGER NOT NULL,
      CHECK ((progress_value IS NULL AND progress_unit IS NULL) OR
             (progress_value IS NOT NULL AND progress_unit IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id),
      kind TEXT NOT NULL CHECK(kind IN ('highlight','note','bookmark')), content TEXT NOT NULL,
      location TEXT, page TEXT, source_date TEXT, source_title TEXT NOT NULL, source_author TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      deleted_at TEXT, version INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_annotations_book ON annotations(book_id);
    CREATE TABLE IF NOT EXISTS operations (
      op_id TEXT PRIMARY KEY,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      request_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  try { migrateKOReader(db); migrateIdentity(db); } catch (error) { db.close(); throw error; }
  return db;
}

function snapshot(db, entity, id) {
  const config = entities[entity];
  return db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(id) ?? null;
}

function validateOperation(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return 'Operação inválida';
  if (!Object.hasOwn(entities, operation.entity)) return 'Entidade inválida';
  if (typeof operation.opId !== 'string' || operation.opId.length < 8 || operation.opId.length > 100) return 'opId inválido';
  if (typeof operation.id !== 'string' || operation.id.length < 8 || operation.id.length > 100) return 'id inválido';
  if (!Number.isInteger(operation.baseVersion) || operation.baseVersion < 0) return 'baseVersion inválida';
  if (typeof operation.deleted !== 'boolean') return 'deleted inválido';
  if (operation.deleted) return null;
  const data = operation.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'Dados inválidos';
  if (operation.entity === 'book') {
    if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 500) return 'Título inválido';
    if (typeof data.author !== 'string' || data.author.length > 500) return 'Autor inválido';
    if (!validDate(data.created_at)) return 'Data de criação inválida';
  } else if (operation.entity === 'annotation') {
    if (typeof data.book_id !== 'string' || data.book_id.length < 8 || data.book_id.length > 100) return 'Livro inválido';
    if (!['highlight', 'note', 'bookmark'].includes(data.kind)) return 'Tipo inválido';
    if (typeof data.content !== 'string' || data.content.length > 10000 || (data.kind !== 'bookmark' && !data.content.trim())) return 'Conteúdo inválido';
    for (const key of ['location', 'page', 'source_date']) {
      if (data[key] !== null && (typeof data[key] !== 'string' || data[key].length > (key === 'source_date' ? 500 : 100))) return 'Metadados inválidos';
    }
    if (data.kind === 'bookmark' && !data.location && !data.page) return 'Marcador sem posição';
    if (typeof data.source_title !== 'string' || !data.source_title.trim() || data.source_title.length > 500 ||
      typeof data.source_author !== 'string' || data.source_author.length > 500) return 'Origem inválida';
    if (typeof data.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(data.fingerprint) || operation.id !== `kindle-${data.fingerprint}`) return 'Identificador inválido';
    if (!validDate(data.created_at)) return 'Data inválida';
  } else {
    if (typeof data.book_id !== 'string' || data.book_id.length < 8 || data.book_id.length > 100) return 'Livro inválido';
    if (!validDate(data.started_at) || !validDate(data.created_at)) return 'Data inválida';
    if (!Number.isInteger(data.minutes) || data.minutes < 0 || data.minutes > 10080) return 'Minutos inválidos';
    if (typeof data.note !== 'string' || data.note.length > 10000) return 'Nota inválida';
    if (data.progress_value === undefined || data.progress_unit === undefined) return 'Progresso inválido';
    const hasProgress = data.progress_value !== null;
    if (hasProgress !== (data.progress_unit !== null)) return 'Progresso inválido';
    if (hasProgress && (!Number.isFinite(data.progress_value) || data.progress_value < 0 ||
      !['page', 'location', 'percent'].includes(data.progress_unit) ||
      (data.progress_unit === 'percent' && data.progress_value > 100))) return 'Progresso inválido';
  }
  return null;
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value)) && value.length <= 40;
}

function applyOperation(db, operation) {
  const error = validateOperation(operation);
  if (error) return { opId: operation?.opId ?? null, status: 'invalid', reason: error };
  const requestJson = JSON.stringify(operation);
  const duplicate = db.prepare('SELECT version, request_json FROM operations WHERE op_id = ?').get(operation.opId);
  if (duplicate) {
    if (duplicate.request_json !== requestJson) {
      return { opId: operation.opId, status: 'invalid', reason: 'opId reutilizado com dados diferentes' };
    }
    return { opId: operation.opId, status: 'accepted', version: duplicate.version };
  }

  const current = snapshot(db, operation.entity, operation.id);
  const currentVersion = current?.version ?? 0;
  if (currentVersion !== operation.baseVersion) {
    return { opId: operation.opId, status: 'conflict', current };
  }
  if (operation.deleted && !current) {
    return { opId: operation.opId, status: 'invalid', reason: 'Registro inexistente' };
  }

  if (operation.entity === 'log' && !operation.deleted && isDerivedLog(db, operation.id)) {
    return { opId: operation.opId, status: 'invalid', reason: 'Leitura do KOReader não pode ser editada; exclua e crie uma leitura manual' };
  }

  const now = new Date().toISOString();
  const version = currentVersion + 1;
  const config = entities[operation.entity];
  if (operation.deleted) {
    if (operation.entity === 'book') {
      const activeLogs = db.prepare('SELECT COUNT(*) AS total FROM reading_logs WHERE book_id = ? AND deleted_at IS NULL').get(operation.id).total;
      if (activeLogs > 0) return { opId: operation.opId, status: 'invalid', reason: 'Livro possui logs ativos' };
      const activeAnnotations = db.prepare('SELECT COUNT(*) AS total FROM annotations WHERE book_id = ? AND deleted_at IS NULL').get(operation.id).total;
      if (activeAnnotations > 0) return { opId: operation.opId, status: 'invalid', reason: 'Livro possui anotações ativas' };
    }
    db.prepare(`UPDATE ${config.table} SET deleted_at = ?, updated_at = ?, version = ? WHERE id = ?`)
      .run(now, now, version, operation.id);
  } else if (operation.entity !== 'book') {
    const book = snapshot(db, 'book', operation.data.book_id);
    if (!book || book.deleted_at) return { opId: operation.opId, status: 'invalid', reason: 'Livro inexistente' };
    writeEntity(db, config, operation, now, version, current);
  } else {
    writeEntity(db, config, operation, now, version, current);
  }

  const updated = snapshot(db, operation.entity, operation.id);
  db.prepare('INSERT INTO operations (op_id, entity, entity_id, version, request_json) VALUES (?, ?, ?, ?, ?)')
    .run(operation.opId, operation.entity, operation.id, version, requestJson);
  db.prepare('INSERT INTO changes (entity, entity_id, payload) VALUES (?, ?, ?)')
    .run(operation.entity, operation.id, JSON.stringify(updated));
  return { opId: operation.opId, status: 'accepted', version };
}

function writeEntity(db, config, operation, now, version, current) {
  const values = config.columns.map((column) => operation.data[column]);
  if (current) {
    const assignments = config.columns.map((column) => `${column} = ?`).join(', ');
    db.prepare(`UPDATE ${config.table} SET ${assignments}, updated_at = ?, deleted_at = NULL, version = ? WHERE id = ?`)
      .run(...values, now, version, operation.id);
  } else {
    const columns = config.columns.join(', ');
    const placeholders = config.columns.map(() => '?').join(', ');
    db.prepare(`INSERT INTO ${config.table} (id, ${columns}, updated_at, deleted_at, version) VALUES (?, ${placeholders}, ?, NULL, ?)`)
      .run(operation.id, ...values, now, version);
  }
}

export function sync(db, request) {
  if (!request || typeof request !== 'object' || !Array.isArray(request.operations) ||
      request.operations.length > 100 || !Number.isInteger(request.cursor) || request.cursor < 0) {
    throw new TypeError('Requisição de sincronização inválida');
  }
  const results = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const latestCursor = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM changes').get().seq;
    if (request.cursor > latestCursor) throw new TypeError('Cursor inválido');
    for (const operation of request.operations) results.push(applyOperation(db, operation));
    const changes = db.prepare('SELECT seq, entity, entity_id AS id, payload FROM changes WHERE seq > ? ORDER BY seq LIMIT 500')
      .all(request.cursor).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
    const cursor = changes.at(-1)?.seq ?? request.cursor;
    db.exec('COMMIT');
    return { results, changes, cursor, hasMore: changes.length === 500 };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
