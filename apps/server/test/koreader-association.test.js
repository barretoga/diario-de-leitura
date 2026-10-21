import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createAppServer } from '../src/server.js';
import { openStore, sync } from '../src/store.js';
import * as integration from '../src/koreader/store.js';
import { batch, options, bookOperation } from './koreader-fixtures.js';

const count = (db, table) => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
function seed(db, books) {
  sync(db, {cursor: 0, operations: books.map(([id, title, author]) => ({...bookOperation(id), data: {...bookOperation().data, title, author}}))});
}
test('automatically links normalized title without overwriting the library metadata', () => {
  const db = openStore(':memory:');
  try {
    seed(db, [['existing-book', '  Dóm   CASMURRO ', 'Machado de Assis']]);
    const before = {...db.prepare('SELECT * FROM books').get()};
    const result = integration.ingestBatch(db, batch(), options);
    assert.equal(result.document.bookId, 'existing-book');
    assert.equal(result.document.state, 'linked');
    assert.deepEqual({...db.prepare('SELECT * FROM books').get()}, before);
    assert.equal(count(db, 'books'), 1);
    assert.equal(count(db, 'reading_logs'), 1);
  } finally {db.close();}
});
test('creates one book before its logs and preserves the exact replay response', () => {
  const db = openStore(':memory:');
  try {
    const input = batch(); const result = integration.ingestBatch(db, input, options);
    assert.equal(result.document.state, 'linked');
    const feed = sync(db, {cursor: 0, operations: []}).changes;
    assert.deepEqual(feed.map(row => row.entity), ['book', 'log']);
    assert.equal(feed[0].payload.title, input.document.title);
    assert.equal(feed[0].payload.author, input.document.author);
    assert.equal(feed[0].payload.origin, 'koreader');
    assert.equal(feed[1].payload.book_id, result.document.bookId);
    assert.deepEqual(integration.ingestBatch(db, input, options), result);
    integration.ingestBatch(db, {...input, batchId: randomUUID()}, options);
    assert.equal(count(db, 'books'), 1); assert.equal(count(db, 'reading_logs'), 1);
    assert.equal(count(db, 'changes'), 2);
  } finally {db.close();}
});
test('author disambiguates titles; indistinguishable candidates require manual association', () => {
  const db = openStore(':memory:');
  try {
    seed(db, [['first-book', 'Dom Casmurro', 'Outra pessoa'], ['second-book', 'Dom Casmurro', 'MACHÁDO DE ASSIS']]);
    assert.equal(integration.ingestBatch(db, batch(), options).document.bookId, 'second-book');
    seed(db, [['third-book', 'Dom Casmurro', 'Machado de Assis']]);
    const result = integration.ingestBatch(db, batch({document: {documentId: 'b'.repeat(32), title: 'Dom Casmurro', author: 'Machado de Assis'}}), options);
    assert.equal(result.document.bookId, null);
    assert.equal(result.document.state, 'pending');
    assert.equal(result.document.error.code, 'association_ambiguous');
    const linked = integration.linkDocument(db, result.document.id, {bookId: 'third-book', expectedVersion: 0}, options);
    assert.equal(linked.document.state, 'linked'); assert.equal(linked.document.error, null);
  } finally {db.close();}
});
test('two independent database connections reuse the book for different devices', () => {
  const folder = mkdtempSync(join(tmpdir(), 'books-association-')); const path = join(folder, 'reading.db');
  const first = openStore(path); const second = openStore(path);
  try {
    const a = integration.ingestBatch(first, batch(), options);
    const b = integration.ingestBatch(second, batch({deviceId: randomUUID(), generationId: randomUUID()}), options);
    assert.equal(b.document.bookId, a.document.bookId);
    assert.equal(count(second, 'books'), 1); assert.equal(count(second, 'reading_logs'), 2);
  } finally {first.close(); second.close(); rmSync(folder, {recursive: true});}
});
test('feed failure rolls back automatic book creation, events and receipt together', () => {
  const db = openStore(':memory:');
  try {
    db.exec("CREATE TRIGGER fail_log_feed BEFORE INSERT ON changes WHEN NEW.entity='log' BEGIN SELECT RAISE(ABORT,'feed failure'); END");
    assert.throws(() => integration.ingestBatch(db, batch(), options), /feed failure/);
    for (const table of ['books', 'reading_logs', 'koreader_documents', 'koreader_events', 'koreader_batches', 'changes']) assert.equal(count(db, table), 0, table);
  } finally {db.close();}
});
test('backfill resolves previously received documents once and leaves existing associations alone', () => {
  const db = openStore(':memory:');
  try {
    seed(db, [['first-book', 'Dom Casmurro', 'Machado de Assis'], ['second-book', 'Dom Casmurro', 'Machado de Assis']]);
    const input = batch(); const pending = integration.ingestBatch(db, input, options);
    assert.equal(pending.document.bookId, null);
    db.prepare("UPDATE books SET deleted_at=? WHERE id='second-book'").run(options.now().toISOString());
    integration.associatePendingDocuments(db, options);
    const doc = integration.listDocuments(db).documents[0];
    assert.equal(doc.bookId, 'first-book'); assert.equal(doc.associationVersion, 1);
    const feedCount = count(db, 'changes');
    integration.associatePendingDocuments(db, options);
    assert.equal(count(db, 'changes'), feedCount);
    assert.deepEqual(integration.ingestBatch(db, input, options), pending, 'old acknowledgement is immutable');
    assert.equal(count(db, 'reading_logs'), 1);
  } finally {db.close();}
});
test('metadata updates never replace an existing link, including a deleted book', () => {
  const db = openStore(':memory:');
  try {
    const first = integration.ingestBatch(db, batch({events: [], progress: null}), options);
    db.prepare('UPDATE books SET deleted_at=? WHERE id=?').run(options.now().toISOString(), first.document.bookId);
    const next = integration.ingestBatch(db, batch({document: {documentId: 'a'.repeat(32), title: 'Outro título', author: 'Outra pessoa'}}), options);
    assert.equal(next.document.bookId, first.document.bookId);
    assert.equal(next.document.error.code, 'book_deleted');
    assert.equal(count(db, 'books'), 1); assert.equal(count(db, 'reading_logs'), 0);
  } finally {db.close();}
});
test('starting the personal API backfills old pending documents into the normal sync feed', async () => {
  const folder=mkdtempSync(join(tmpdir(),'books-backfill-')); const path=join(folder,'reading.db');
  const db=openStore(path);
  seed(db,[['first-book','Dom Casmurro','Machado de Assis'],['second-book','Dom Casmurro','Machado de Assis']]);
  integration.ingestBatch(db,batch(),options);
  db.prepare("UPDATE books SET deleted_at=? WHERE id='second-book'").run(options.now().toISOString());
  const cursor=db.prepare('SELECT MAX(seq) seq FROM changes').get().seq; db.close();
  const token='test-backfill-token-0000000000000000000000';
  const server=createAppServer({token,databasePath:path});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/sync`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({cursor,operations:[]})});
    assert.equal(response.status,200);
    const feed=(await response.json()).changes;assert.deepEqual(feed.map(row=>row.entity),['log']);
    assert.equal(feed[0].payload.book_id,'first-book');
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(folder,{recursive:true});}
});
test('backfill failure rolls back links and projections and leaves the old data intact', () => {
  const db=openStore(':memory:');
  try {
    seed(db,[['first-book','Dom Casmurro','Machado de Assis'],['second-book','Dom Casmurro','Machado de Assis']]);
    const receipt=integration.ingestBatch(db,batch(),options);
    db.prepare("UPDATE books SET deleted_at=? WHERE id='second-book'").run(options.now().toISOString());
    db.exec("CREATE TRIGGER fail_backfill BEFORE INSERT ON changes BEGIN SELECT RAISE(ABORT,'feed failure'); END");
    assert.throws(()=>integration.associatePendingDocuments(db,options),/feed failure/);
    const doc=integration.listDocuments(db).documents[0];
    assert.equal(doc.bookId,null);assert.equal(doc.associationVersion,0);
    assert.equal(count(db,'reading_logs'),0);assert.equal(count(db,'koreader_events'),1);assert.equal(count(db,'koreader_batches'),1);
    assert.equal(doc.id,receipt.document.id);
  } finally {db.close();}
});
