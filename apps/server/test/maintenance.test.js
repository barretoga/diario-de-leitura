import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackup, inspectDatabase, restoreBackup } from '../src/maintenance.js';
import { openStore, sync } from '../src/store.js';
import { getServerId } from '../src/identity.js';
import { ingestBatch,linkDocument } from '../src/koreader/store.js';
import { batch,options,bookOperation } from './koreader-fixtures.js';

const book = {
  opId: 'create-book-001', entity: 'book', id: 'book-0001', baseVersion: 0, deleted: false,
  data: { title: 'Um livro', author: 'Autora', created_at: '2026-09-21T12:00:00.000Z' },
};
const log = {
  opId: 'create-log-0001', entity: 'log', id: 'reading-log-0001', baseVersion: 0, deleted: false,
  data: { book_id: 'book-0001', started_at: '2026-09-21T12:30:00.000Z', minutes: 25,
    progress_value: 40, progress_unit: 'percent', note: 'Leitura boa', created_at: '2026-09-21T12:30:00.000Z' },
};

function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'reading-server-backup-'));
  return Promise.resolve().then(() => run(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test('integral backup keeps adapter receipt, raw data, mapping and replay semantics',()=>withDirectory(async directory=>{
  const source=join(directory,'source.db'),saved=join(directory,'saved.sqlite'),restored=join(directory,'restored.db');
  const db=openStore(source);const b=batch();let receipt,originalId;
  try{originalId=getServerId(db);sync(db,{cursor:0,operations:[bookOperation()]});receipt=ingestBatch(db,b,options);linkDocument(db,receipt.document.id,{bookId:'book-00000001',expectedVersion:0},options);await createBackup(source,saved);}finally{db.close();}
  await restoreBackup(saved,restored,{offline:true});const copy=openStore(restored);
  try{assert.equal(getServerId(copy),originalId);for(const table of ['koreader_generations','koreader_documents','koreader_events','koreader_progress','koreader_batches','koreader_projections','koreader_config'])assert.equal(copy.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,1);
    assert.deepEqual(ingestBatch(copy,b,options),receipt);assert.equal(copy.prepare('SELECT COUNT(*) n FROM reading_logs').get().n,1);
  }finally{copy.close();}
}));

test('online backup includes WAL changes, operations and cursor; restore keeps a safety copy', () => withDirectory(async directory => {
  const database = join(directory, 'server.db');
  const backup = join(directory, 'snapshot.sqlite');
  const live = openStore(database);
  try {
    sync(live, { cursor: 0, operations: [book, log] });
    const saved = await createBackup(database, backup);
    assert.deepEqual({ books: saved.books, logs: saved.logs, operations: saved.operations, changes: saved.changes },
      { books: 1, logs: 1, operations: 2, changes: 2 });
    assert.equal(inspectDatabase(backup).changes, 2);
    assert.equal(readdirSync(directory).some(name => name.includes('.partial-')), false);
    sync(live, { cursor: 2, operations: [{ ...book, opId: 'edit-book-001', baseVersion: 1,
      data: { ...book.data, title: 'Edição posterior' } }] });
    assert.equal(live.prepare('SELECT title FROM books WHERE id = ?').get(book.id).title, 'Edição posterior');
  } finally {
    live.close();
  }

  await assert.rejects(createBackup(database, backup), /destino já existe/);
  await assert.rejects(restoreBackup(backup, database), /--offline/);
  const restored = await restoreBackup(backup, database, { offline: true });
  assert.ok(restored.previous && existsSync(restored.previous));
  assert.equal(restored.changes, 2);
  const reopened = openStore(database);
  try {
    assert.equal(reopened.prepare('SELECT title FROM books WHERE id = ?').get(book.id).title, 'Um livro');
    assert.equal(sync(reopened, { cursor: 2, operations: [] }).changes.length, 0);
    const duplicate = sync(reopened, { cursor: 2, operations: [book, log] });
    assert.deepEqual(duplicate.results.map(result => result.version), [1, 1]);
  } finally {
    reopened.close();
  }
  assert.equal(inspectDatabase(restored.previous).changes, 3);
}));

test('invalid and incomplete sources cannot replace the current server database', () => withDirectory(async directory => {
  const database = join(directory, 'server.db');
  const invalid = join(directory, 'invalid.sqlite');
  const incomplete = join(directory, 'incomplete.sqlite');
  const live = openStore(database);
  sync(live, { cursor: 0, operations: [book] });
  live.close();
  writeFileSync(invalid, 'not a SQLite database');
  const other = new DatabaseSync(incomplete);
  other.exec('CREATE TABLE books (id TEXT)');
  other.close();

  await assert.rejects(restoreBackup(invalid, database, { offline: true }));
  await assert.rejects(restoreBackup(incomplete, database, { offline: true }), /Esquema incompatível/);
  assert.equal(inspectDatabase(database).books, 1);
  assert.equal(readdirSync(directory).filter(name => name.includes('before-restore')).length, 0);
}));

test('restore refuses a database with an active WAL connection', () => withDirectory(async directory => {
  const database = join(directory, 'server.db');
  const backup = join(directory, 'snapshot.sqlite');
  const live = openStore(database);
  try {
    sync(live, { cursor: 0, operations: [book] });
    await createBackup(database, backup);
    await assert.rejects(restoreBackup(backup, database, { offline: true }), /em uso|WAL pendentes/);
    assert.equal(live.prepare('SELECT title FROM books WHERE id = ?').get(book.id).title, 'Um livro');
  } finally {
    live.close();
  }
  assert.equal(inspectDatabase(database).books, 1);
  assert.equal(readFileSync(backup).subarray(0, 16).toString(), 'SQLite format 3\u0000');
}));

test('restore recovers a damaged destination and preserves its original file', () => withDirectory(async directory => {
  const database = join(directory, 'server.db');
  const backup = join(directory, 'snapshot.sqlite');
  const live = openStore(database);
  sync(live, { cursor: 0, operations: [book] });
  live.close();
  await createBackup(database, backup);
  writeFileSync(database, 'damaged database');

  const restored = await restoreBackup(backup, database, { offline: true });
  assert.equal(inspectDatabase(database).books, 1);
  assert.equal(readFileSync(restored.previous, 'utf8'), 'damaged database');
}));

test('restore refuses orphan WAL files instead of mixing them with a replacement', () => withDirectory(async directory => {
  const database = join(directory, 'server.db');
  const backup = join(directory, 'snapshot.sqlite');
  const live = openStore(database);
  sync(live, { cursor: 0, operations: [book] });
  live.close();
  await createBackup(database, backup);
  rmSync(database);
  writeFileSync(`${database}-wal`, 'orphan WAL');

  await assert.rejects(restoreBackup(backup, database, { offline: true }), /WAL sem banco principal/);
  assert.equal(existsSync(database), false);
}));
