import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openStore, sync } from '../src/store.js';
import { migrateKOReader } from '../src/koreader/migrations.js';
import { bookOperation } from './koreader-fixtures.js';
test('migration preserves core and is repeatable', () => {
  const db = openStore(':memory:');
  try {
    sync(db, { cursor: 0, operations: [bookOperation()] });
    const before = db.prepare('SELECT * FROM books').all();
    for (const table of ['koreader_projections','koreader_batches','koreader_progress','koreader_events','koreader_documents','koreader_generations','koreader_config','koreader_schema']) db.exec('DROP TABLE '+table);
    const feed = db.prepare('SELECT * FROM changes').all();
    migrateKOReader(db); migrateKOReader(db);
    assert.deepEqual(db.prepare('SELECT * FROM books').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM changes').all(), feed);
    assert.equal(db.prepare('SELECT version FROM koreader_schema').get().version, 1);
  } finally { db.close(); }
});
test('migration rolls back DDL and version on failure', () => {
  const db = new DatabaseSync(':memory:');
  const exec = db.exec.bind(db);
  db.exec = sql => { exec(sql); if (sql.includes('CREATE TABLE koreader_generations')) throw new Error('injected DDL failure'); };
  assert.throws(() => migrateKOReader(db), /injected/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'koreader_%'").get().n, 0);
  db.exec = exec; migrateKOReader(db);
  assert.equal(db.prepare('SELECT version FROM koreader_schema').get().version, 1);
  db.close();
});
test('newer module schema is never reset', () => {
  const db = openStore(':memory:');
  db.exec('UPDATE koreader_schema SET version=99');
  assert.throws(() => migrateKOReader(db), /mais recente/); db.close();
});
