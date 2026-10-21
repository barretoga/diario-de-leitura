import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SyncStore } from '../src/sync/store.ts';
import { googleVolumeUrl, validVolumeId } from '../src/catalog/googleBooks.ts';
import { parseBackup, serializeBackup } from '../src/backup/format.ts';

function client(t) {
  const raw = new DatabaseSync(':memory:'); t.after(() => raw.close());
  const api = {
    fail: null,
    async execAsync(sql) { if (api.fail?.(sql)) throw new Error('Injected failure'); raw.exec(sql); },
    async runAsync(sql, ...args) { if (api.fail?.(sql)) throw new Error('Injected failure'); return raw.prepare(sql).run(...args); },
    async getFirstAsync(sql, ...args) { return raw.prepare(sql).get(...args) ?? null; },
    async getAllAsync(sql, ...args) { return raw.prepare(sql).all(...args); },
  };
  return { raw, api, store: new SyncStore(api) };
}

const date = '2026-09-21T12:00:00Z';
test('Google source links only accept volume IDs', () => {
  assert.equal(validVolumeId('abc_123'), true);
  assert.equal(validVolumeId('https://evil.example'), false);
  assert.equal(googleVolumeUrl('abc_123'), 'https://books.google.com/books?id=abc_123');
});

test('Google choice is atomic, preserves reading IDs, and portable backup keeps only the volume link', async t => {
  const a = client(t), b = client(t); await a.store.initialize(); await b.store.initialize();
  await a.store.save('book', 'book-0001', { title: 'Original', author: 'Outro', created_at: date });
  await a.store.save('log', 'log-00001', { book_id: 'book-0001', started_at: date, minutes: 20,
    progress_value: null, progress_unit: null, note: '', created_at: date });
  const link = { book_id: 'book-0001', volume_id: 'abc_123' };
  a.api.fail = sql => sql.startsWith('INSERT INTO google_catalog');
  await assert.rejects(a.store.saveBookFromGoogle('book-0001', { title: 'O Livro', author: 'Autora', created_at: date }, link), /Injected failure/);
  assert.equal((await a.store.listBooks())[0].title, 'Original');
  a.api.fail = null;
  await a.store.saveBookFromGoogle('book-0001', { title: 'O Livro', author: 'Autora', created_at: date }, link);
  assert.equal((await a.store.listLogs())[0].book_title, 'O Livro');
  assert.deepEqual(await a.store.listGoogleBookLinks(), [link]);
  const exported = parseBackup(serializeBackup(await a.store.exportBackup()));
  assert.equal(exported.version, 4);
  assert.deepEqual(exported.googleCatalog, [link]);
  assert.equal(JSON.stringify(exported).includes('google_books_api_key'), false);
  assert.equal((await b.store.restoreBackup(exported)).googleLinksAdded, 1);
  assert.deepEqual(await b.store.listGoogleBookLinks(), [link]);
  assert.equal((await b.store.restoreBackup(exported)).googleLinksAdded, 0);
  assert.throws(() => parseBackup(JSON.stringify({ ...exported, googleCatalog: [{ ...link, volume_id: 'https://evil.example' }] })), /identificador do Google Books/);
  const openLink = { book_id: 'book-0001', work_key: '/works/OL123W', cover_id: null, subjects: [], first_publish_year: null };
  await a.store.setBookMetadata(openLink);
  assert.deepEqual(await a.store.listGoogleBookLinks(), []);
  assert.deepEqual(await a.store.listBookMetadata(), [openLink]);
  await a.store.saveBookFromGoogle('book-0001', { title: 'O Livro', author: 'Autora', created_at: date }, link);
  assert.deepEqual(await a.store.listBookMetadata(), []);
  assert.deepEqual(await a.store.listGoogleBookLinks(), [link]);
  assert.throws(() => parseBackup(JSON.stringify({ ...exported, catalog: [openLink] })), /duas fontes/);
});

test('v5 to v6 migration rolls back and retries without losing catalog data', async t => {
  const { raw, api, store } = client(t); await store.initialize();
  await store.save('book', 'book-0001', { title: 'Livro', author: '', created_at: date });
  raw.exec('DROP TABLE google_catalog; PRAGMA user_version=5;');
  api.fail = sql => sql.includes('PRAGMA user_version=6');
  await assert.rejects(store.initialize(), /Injected failure/);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='google_catalog'").get(), undefined);
  api.fail = null; await store.initialize(); await store.initialize();
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 8);
  assert.equal((await store.listBooks())[0].id, 'book-0001');
});
