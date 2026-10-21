import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SyncStore } from '../src/sync/store.ts';
import { MAX_BACKUP_BYTES, parseBackup, serializeBackup, utf8Bytes } from '../src/backup/format.ts';
import { openStore, sync } from '../../server/src/store.js';

const date = '2026-09-21T12:00:00.000Z';
const book = { id: 'book-0001', title: 'Memórias 📚', author: 'Autora', created_at: date };
const log = { id: 'log-00001', book_id: book.id, started_at: date, minutes: 30,
  progress_value: 23.5, progress_unit: 'percent', note: 'Anotação\ncom duas linhas', created_at: date };
const backup = () => ({ format: 'reading-log-backup', version: 1, exportedAt: date, books: [{ ...book }], logs: [{ ...log }] });
async function client(t) {
  const raw = new DatabaseSync(':memory:'); t.after(() => raw.close());
  const adapter = {
    fail: null,
    async execAsync(sql) { raw.exec(sql); },
    async runAsync(sql, ...params) { if (adapter.fail?.(sql)) throw new Error('Disk failure'); return raw.prepare(sql).run(...params); },
    async getFirstAsync(sql, ...params) { return raw.prepare(sql).get(...params) ?? null; },
    async getAllAsync(sql, ...params) { return raw.prepare(sql).all(...params); },
  };
  const store = new SyncStore(adapter); await store.initialize();
  return { store, raw, adapter };
}
async function seed(store) { await store.save('book', book.id, book); await store.save('log', log.id, log); }

test('export/import round trip preserves all portable content and queues restored records', async t => {
  const a = await client(t), b = await client(t); await seed(a.store);
  await a.store.configure('https://private.example'); await a.store.pause(true); await a.store.block('private failure');
  const text = serializeBackup(await a.store.exportBackup());
  for (const forbidden of ['private.example', 'private failure', 'operation_json', 'local_revision', 'deleted_at', 'cursor', 'token']) assert.equal(text.includes(forbidden), false);
  const parsed = parseBackup(text);
  assert.deepEqual(parsed.books, [book]); assert.deepEqual(parsed.logs, [log]);
  const preview = await b.store.previewRestore(parsed);
  assert.deepEqual(preview, { booksAdded: 1, logsAdded: 1, annotationsAdded: 0, metadataAdded: 0, googleLinksAdded: 0, unchanged: 0, skipped: [] });
  assert.equal((await b.store.listBooks()).length, 0);
  assert.deepEqual(await b.store.restoreBackup(parsed), preview);
  assert.equal((await b.store.get('log', log.id)).note, log.note);
  assert.equal((await b.store.get('book', book.id)).version, 0);
  assert.equal(await b.store.pendingCount(), 2);
  assert.deepEqual(await b.store.settings(), { url: '', paused: false, cursor: 0, lastSuccess: null, fatal: null, serverId: null });
});

test('repeated restoration is idempotent, preserving pending frozen operations and settings', async t => {
  const { store, raw } = await client(t); await seed(store);
  await store.configure('https://current.example'); await store.pause(true);
  const request = await store.prepare();
  const before = raw.prepare('SELECT * FROM sync_pending ORDER BY entity,id').all();
  const result = await store.restoreBackup(backup());
  assert.deepEqual(result, { booksAdded: 0, logsAdded: 0, annotationsAdded: 0, metadataAdded: 0, googleLinksAdded: 0, unchanged: 2, skipped: [] });
  assert.deepEqual(raw.prepare('SELECT * FROM sync_pending ORDER BY entity,id').all(), before);
  assert.deepEqual(await store.prepare(), request);
  assert.equal((await store.settings()).url, 'https://current.example');
  assert.equal((await store.settings()).paused, true);
});

test('catalog links survive backup, restore onto existing books, and never overwrite a different choice', async t => {
  const a = await client(t), b = await client(t);
  await seed(a.store); await seed(b.store);
  const metadata = { book_id: book.id, work_key: '/works/OL123W', cover_id: 123,
    subjects: ['Fiction'], first_publish_year: 1999 };
  await a.store.setBookMetadata(metadata);
  const exported = parseBackup(serializeBackup(await a.store.exportBackup()));
  assert.equal(exported.version, 4);
  assert.deepEqual(exported.catalog, [metadata]);
  assert.equal((await b.store.previewRestore(exported)).metadataAdded, 1);
  assert.equal((await b.store.restoreBackup(exported)).metadataAdded, 1);
  assert.deepEqual(await b.store.listBookMetadata(), [metadata]);
  assert.equal((await b.store.restoreBackup(exported)).metadataAdded, 0);
  await b.store.setBookMetadata({ ...metadata, work_key: '/works/OL456W' });
  const result = await b.store.restoreBackup(exported);
  assert.equal(result.skipped.find(item => item.kind === 'Catálogo').reason, 'Já existem dados do catálogo diferentes neste aparelho.');
  assert.equal((await b.store.listBookMetadata())[0].work_key, '/works/OL456W');
});

test('catalog backup validates references, reads v2, and rolls back metadata write failures', async t => {
  const source = await client(t); await seed(source.store);
  await source.store.setBookMetadata({ book_id: book.id, work_key: '/works/OL123W', cover_id: 123,
    subjects: ['Fiction'], first_publish_year: 1999 });
  const exported = await source.store.exportBackup();
  const old = { ...exported, version: 2 };
  delete old.catalog; delete old.googleCatalog;
  assert.equal(parseBackup(serializeBackup(old)).version, 2);
  assert.throws(() => parseBackup(JSON.stringify({ ...exported, catalog: [{ ...exported.catalog[0], book_id: 'other-book' }] })), /catálogo sem livro/);
  const destination = await client(t);
  destination.adapter.fail = sql => sql.startsWith('INSERT INTO book_catalog');
  await assert.rejects(destination.store.restoreBackup(exported), /Disk failure/);
  assert.equal((await destination.store.listBooks()).length, 0);
  assert.equal((await destination.store.listBookMetadata()).length, 0);
  assert.equal(await destination.store.pendingCount(), 0);
});

test('different records and tombstones are never overwritten or resurrected', async t => {
  const { store } = await client(t); await seed(store);
  await store.save('book', book.id, { ...book, title: 'Título atual' });
  await store.remove('log', log.id);
  const result = await store.restoreBackup(backup());
  assert.equal(result.skipped.length, 2);
  assert.equal((await store.get('book', book.id)).title, 'Título atual');
  assert.ok((await store.get('log', log.id)).deleted_at);
  const another = backup(); another.logs[0].id = 'log-00002';
  const next = await store.restoreBackup(another);
  assert.equal(next.skipped.length, 2); assert.equal(next.logsAdded, 0);
  assert.equal(await store.get('log', 'log-00002'), null);
});

test('confirmation recomputes preview to preserve an edit made in the meantime', async t => {
  const { store } = await client(t);
  assert.equal((await store.previewRestore(backup())).booksAdded, 1);
  await store.save('book', book.id, { ...book, title: 'Criado após a prévia' });
  const result = await store.restoreBackup(backup());
  assert.equal(result.booksAdded, 0); assert.equal(result.logsAdded, 0); assert.equal(result.skipped.length, 2);
  assert.equal((await store.get('book', book.id)).title, 'Criado após a prévia');
});

test('restoration rolls back both data and queue when writing fails midway', async t => {
  const { store, adapter } = await client(t);
  adapter.fail = sql => sql.startsWith('INSERT INTO reading_logs');
  await assert.rejects(store.restoreBackup(backup()), /Disk failure/);
  assert.equal((await store.listBooks()).length, 0); assert.equal(await store.pendingCount(), 0);
  adapter.fail = null;
  assert.equal((await store.restoreBackup(backup())).logsAdded, 1);
});

test('export omits deleted logs and includes deleted parents needed by active logs', async t => {
  const { store, raw } = await client(t); await seed(store);
  await store.save('log', 'log-00002', log); await store.remove('log', 'log-00002');
  raw.prepare('UPDATE books SET deleted_at=? WHERE id=?').run(date, book.id);
  const exported = await store.exportBackup();
  assert.equal(exported.books.length, 1); assert.deepEqual(exported.logs, [log]);
  const destination = await client(t); await destination.store.restoreBackup(exported);
  assert.equal((await destination.store.listBooks()).length, 1);
});

test('legacy content above sync limits can be backed up/restored and remains correctable', async t => {
  const { store, raw } = await client(t); await seed(store);
  raw.prepare('UPDATE books SET title=?').run('a'.repeat(501));
  raw.prepare('UPDATE reading_logs SET minutes=?,note=?').run(10081, 'n'.repeat(10001));
  const exported = parseBackup(serializeBackup(await store.exportBackup()));
  const b = await client(t); await b.store.restoreBackup(exported); await b.store.prepare();
  assert.equal((await b.store.get('log', log.id)).note.length, 10001);
  assert.equal((await b.store.issues())[0].entity, 'book');
});

test('invalid files are rejected before any mutation', async t => {
  const { store } = await client(t);
  const changes = [
    x => { x.version = 99; }, x => { x.format = 'other'; }, x => { x.books = {}; },
    x => { x.books.push({ ...book }); }, x => { x.logs.push({ ...log }); }, x => { x.books = []; },
    x => { x.logs[0].minutes = -1; }, x => { x.logs[0].minutes = 0.5; },
    x => { x.logs[0].progress_value = 101; }, x => { x.logs[0].progress_unit = null; },
    x => { x.logs[0].note = {}; }, x => { x.books[0].title = ''; }, x => { x.books[0].id = 'x'; },
    x => { x.exportedAt = 'yesterday'; }, x => { x.logs[0].started_at = 'bad'; },
  ];
  for (const change of changes) {
    const value = backup(); change(value);
    assert.throws(() => parseBackup(JSON.stringify(value)), /Backup inválido/);
    await assert.rejects(async () => store.restoreBackup(value), /Backup inválido/);
  }
  assert.throws(() => parseBackup('{broken'), /JSON/);
  assert.equal(await store.pendingCount(), 0); assert.equal((await store.listBooks()).length, 0);
});

test('BOM and Unicode are supported; unsupported extra fields cannot import credentials or sync state', async t => {
  const value = backup(); value.token = 'secret'; value.cursor = 999; value.books[0].version = 900;
  const parsed = parseBackup('\uFEFF' + JSON.stringify(value));
  assert.deepEqual(parsed, backup());
  assert.equal(utf8Bytes('a漢📚'), Buffer.byteLength('a漢📚'));
  const { store } = await client(t); await store.restoreBackup(parsed);
  assert.equal((await store.get('book', book.id)).version, 0);
});

test('file size and record count limits are enforced', () => {
  assert.throws(() => parseBackup(' '.repeat(MAX_BACKUP_BYTES + 1)), /25 MB/);
  const value = backup(); value.books = Array.from({ length: 50001 }, () => book);
  assert.throws(() => parseBackup(JSON.stringify(value)), /50.000/);
});

test('restored records synchronize as books before logs without duplicating remote IDs', async t => {
  const { store } = await client(t); await store.restoreBackup(backup());
  const remote = openStore(':memory:'); t.after(() => remote.close());
  const first = await store.prepare(); assert.deepEqual(first.operations.map(op => op.entity), ['book']);
  await store.apply(first, sync(remote, first));
  const second = await store.prepare(); assert.deepEqual(second.operations.map(op => op.entity), ['log']);
  await store.apply(second, sync(remote, second));
  await store.restoreBackup(backup()); assert.equal(await store.pendingCount(), 0);
  assert.equal(remote.prepare('SELECT COUNT(*) AS n FROM reading_logs').get().n, 1);
});

test('restoring old synchronized IDs into a new client produces explicit sync conflicts', async t => {
  const remote = openStore(':memory:'); t.after(() => remote.close());
  const a = await client(t), b = await client(t); await seed(a.store);
  for (let i = 0; i < 2; i++) { const request = await a.store.prepare(); await a.store.apply(request, sync(remote, request)); }
  const file = await a.store.exportBackup(); await b.store.restoreBackup(file);
  const request = await b.store.prepare(); await b.store.apply(request, sync(remote, request));
  assert.ok((await b.store.issues()).some(issue => issue.conflict));
  assert.equal(remote.prepare('SELECT COUNT(*) AS n FROM books').get().n, 1);
  assert.equal(remote.prepare('SELECT COUNT(*) AS n FROM reading_logs').get().n, 1);
});
