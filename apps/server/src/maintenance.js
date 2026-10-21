import { backup, DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const requiredColumns = {
  books: ['id', 'title', 'author', 'version', 'deleted_at'],
  reading_logs: ['id', 'book_id', 'started_at', 'minutes', 'version', 'deleted_at'],
  annotations: ['id', 'book_id', 'kind', 'fingerprint', 'version', 'deleted_at'],
  operations: ['op_id', 'entity', 'entity_id', 'version', 'request_json'],
  changes: ['seq', 'entity', 'entity_id', 'payload'],
};

function regularFile(path) {
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Arquivo SQLite não encontrado: ${path}`);
}

function sameFile(a, b) {
  return resolve(a) === resolve(b) || (existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b));
}

function temporaryPath(destination) {
  return resolve(dirname(destination), `.${basename(destination)}.partial-${randomUUID()}`);
}

function removeIfPresent(path) {
  if (existsSync(path)) unlinkSync(path);
}

function removePartial(path) {
  for (const suffix of ['-wal', '-shm', '']) removeIfPresent(`${path}${suffix}`);
}

function finalizeSnapshot(path) {
  const db = new DatabaseSync(path, { timeout: 1000 });
  try {
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint.busy) throw new Error('Não foi possível finalizar o arquivo SQLite');
    if (db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete') {
      throw new Error('Não foi possível fechar o arquivo WAL do backup');
    }
  } finally {
    db.close();
  }
  if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) {
    throw new Error('O backup ainda possui arquivos WAL pendentes');
  }
}

export function inspectDatabase(path) {
  regularFile(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Falha na integridade do SQLite');
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Referências inválidas no SQLite');
    for (const [table, columns] of Object.entries(requiredColumns)) {
      const found = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      if (columns.some(column => !found.has(column))) throw new Error(`Esquema incompatível: ${table}`);
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='koreader_schema'").get()) {
      if (db.prepare('SELECT MAX(version) version FROM koreader_schema').get().version !== 1) throw new Error('Esquema KOReader incompatível');
      for (const [table, columns] of Object.entries({
        koreader_config:['id','time_zone'], koreader_generations:['device_id','generation_id','activation_unix'],
        koreader_documents:['id','checksum','book_id','association_version'], koreader_events:['event_key','document_id','duration_seconds','projection_eligible'],
        koreader_progress:['document_id','sequence','captured_at','percent'], koreader_batches:['batch_id','canonical_json','response_json'],
        koreader_projections:['document_id','day','log_id','total_seconds'],
      })) {
        const found = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
        if (columns.some(column => !found.has(column))) throw new Error(`Esquema incompatível: ${table}`);
      }
    }
    return {
      books: db.prepare('SELECT COUNT(*) AS count FROM books').get().count,
      logs: db.prepare('SELECT COUNT(*) AS count FROM reading_logs').get().count,
      annotations: db.prepare('SELECT COUNT(*) AS count FROM annotations').get().count,
      operations: db.prepare('SELECT COUNT(*) AS count FROM operations').get().count,
      changes: db.prepare('SELECT COUNT(*) AS count FROM changes').get().count,
    };
  } finally {
    db.close();
  }
}

export async function createBackup(databasePath, destinationPath) {
  const source = resolve(databasePath);
  const destination = resolve(destinationPath);
  regularFile(source);
  if (sameFile(source, destination)) throw new Error('Origem e destino não podem ser iguais');
  if (existsSync(destination)) throw new Error('O arquivo de destino já existe');
  if (!existsSync(dirname(destination))) throw new Error('Crie a pasta de destino antes do backup');
  const partial = temporaryPath(destination);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, partial);
    finalizeSnapshot(partial);
    const summary = inspectDatabase(partial);
    if (existsSync(destination)) throw new Error('O arquivo de destino já existe');
    renameSync(partial, destination);
    return { path: destination, ...summary };
  } finally {
    try { db.close(); } finally { removePartial(partial); }
  }
}

export async function restoreBackup(sourcePath, databasePath, { offline = false } = {}) {
  if (!offline) throw new Error('Pare a API e confirme a restauração com --offline');
  const source = resolve(sourcePath);
  const destination = resolve(databasePath);
  if (sameFile(source, destination)) throw new Error('Origem e destino não podem ser iguais');
  const expected = inspectDatabase(source);
  if (!existsSync(dirname(destination))) throw new Error('Pasta do banco de dados não encontrada');
  if (existsSync(destination)) regularFile(destination);
  else if (existsSync(`${destination}-wal`) || existsSync(`${destination}-shm`)) {
    throw new Error('Arquivos WAL sem banco principal; preserve-os e verifique o volume antes de restaurar');
  }
  const partial = temporaryPath(destination);
  let previous = null;
  try {
    const sourceDb = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(sourceDb, partial);
    } finally {
      sourceDb.close();
    }
    finalizeSnapshot(partial);
    const actual = inspectDatabase(partial);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('O backup mudou durante a cópia');
    let damaged = false;
    if (existsSync(destination)) {
      let current;
      try {
        current = new DatabaseSync(destination, { timeout: 1000 });
        const checkpoint = current.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (checkpoint.busy) throw new Error('Banco em uso; pare a API antes de restaurar');
      } catch (error) {
        if (![11, 26].includes(error.errcode)) throw error;
        damaged = true;
      } finally {
        current?.close();
      }
      if (!damaged && (existsSync(`${destination}-wal`) || existsSync(`${destination}-shm`))) {
        throw new Error('Banco em uso ou com arquivos WAL pendentes; pare a API antes de restaurar');
      }
      previous = `${destination}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    }
    const moved = [];
    try {
      if (previous) {
        renameSync(destination, previous);
        if (damaged) for (const suffix of ['-wal', '-shm']) {
          if (existsSync(`${destination}${suffix}`)) {
            renameSync(`${destination}${suffix}`, `${previous}${suffix}`);
            moved.push(suffix);
          }
        }
      }
      renameSync(partial, destination);
    } catch (error) {
      if (previous) {
        for (const suffix of moved.reverse()) renameSync(`${previous}${suffix}`, `${destination}${suffix}`);
        if (existsSync(previous)) renameSync(previous, destination);
      }
      throw error;
    }
    return { path: destination, previous, ...actual };
  } finally {
    removePartial(partial);
  }
}

async function main() {
  const [command, file, flag] = process.argv.slice(2);
  const database = process.env.DATABASE_PATH ?? './data/reading-log.db';
  if (!file || !['backup', 'restore'].includes(command)) {
    throw new Error('Uso: node src/maintenance.js backup <arquivo.sqlite> | restore <arquivo.sqlite> --offline');
  }
  const result = command === 'backup' ? await createBackup(database, file)
    : await restoreBackup(file, database, { offline: flag === '--offline' });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
