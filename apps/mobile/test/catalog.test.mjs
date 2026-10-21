import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SyncStore } from '../src/sync/store.ts';
import { coverUrl, workUrl } from '../src/catalog/openLibrary.ts';

function adapter() {
  const raw = new DatabaseSync(':memory:');
  const api = {
    fail: null,
    async execAsync(sql) { if (api.fail?.(sql)) throw new Error('Injected failure'); raw.exec(sql); },
    async runAsync(sql, ...args) { if (api.fail?.(sql)) throw new Error('Injected failure'); return raw.prepare(sql).run(...args); },
    async getFirstAsync(sql, ...args) { return raw.prepare(sql).get(...args) ?? null; },
    async getAllAsync(sql, ...args) { return raw.prepare(sql).all(...args); },
  };
  return { raw, api };
}

test('Open Library links use provider origins', () => {
  assert.equal(workUrl('/works/OL123W'), 'https://openlibrary.org/works/OL123W');
  assert.equal(coverUrl(456), 'https://covers.openlibrary.org/b/id/456-M.jpg?default=false');
});

test('catalog choice updates book and log titles without changing IDs; failure rolls back both changes', async t => {
  const { raw, api } = adapter(); t.after(() => raw.close());
  const store = new SyncStore(api); await store.initialize();
  const created_at = '2026-09-21T12:00:00Z';
  await store.save('book', 'book-0001', { title: 'Original', author: 'Outro', created_at });
  await store.save('log', 'log-00001', { book_id: 'book-0001', started_at: created_at, minutes: 20,
    progress_value: null, progress_unit: null, note: '', created_at });
  const frozen = await store.prepare();
  const metadata = { book_id: 'book-0001', work_key: '/works/OL123W', cover_id: 456,
    subjects: ['Fiction'], first_publish_year: 1999 };
  api.fail = sql => sql.startsWith('INSERT INTO book_catalog');
  await assert.rejects(store.saveBookFromCatalog('book-0001', { title: 'O Livro', author: 'Autora', created_at }, metadata), /Injected failure/);
  assert.equal((await store.listBooks())[0].title, 'Original');
  assert.deepEqual(await store.listBookMetadata(), []);
  assert.deepEqual(await store.prepare(), frozen);
  api.fail = null;
  await store.saveBookFromCatalog('book-0001', { title: 'O Livro', author: 'Autora', created_at }, metadata);
  const updated = (await store.listBooks())[0];
  assert.equal(updated.id, 'book-0001');
  assert.equal(updated.author, 'Autora');
  assert.equal(updated.created_at, created_at);
  assert.equal((await store.listLogs())[0].book_title, 'O Livro');
  assert.deepEqual(await store.listBookMetadata(), [metadata]);
  assert.deepEqual(await store.prepare(), frozen);
});

test('v4 catalog migration is atomic, idempotent, and metadata stays local', async t => {
  const { raw, api } = adapter(); t.after(() => raw.close());
  const store = new SyncStore(api);
  await store.initialize();
  await store.save('book', 'book-0001', { title: 'Livro', author: 'Autora', created_at: '2026-09-21T12:00:00Z' });
  raw.exec('DROP TABLE google_catalog; DROP TABLE book_catalog; PRAGMA user_version=4;');
  api.fail = sql => sql.includes('PRAGMA user_version=5');
  await assert.rejects(store.initialize(), /Injected failure/);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='book_catalog'").get(), undefined);
  api.fail = null;
  await store.initialize(); await store.initialize();
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 8);
  const before = await store.pendingCount();
  const metadata = { book_id: 'book-0001', work_key: '/works/OL123W', cover_id: 123,
    subjects: ['Fiction'], first_publish_year: 1999 };
  await store.setBookMetadata(metadata);
  assert.deepEqual(await store.listBookMetadata(), [metadata]);
  assert.equal(await store.pendingCount(), before);
  await assert.rejects(store.setBookMetadata({ ...metadata, book_id: 'missing-book' }), /não encontrado/);
  assert.deepEqual(await store.listBookMetadata(), [metadata]);
});
