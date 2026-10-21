import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SyncStore } from '../src/sync/store.ts';

const data = { title: 'Duna', author: 'Frank Herbert', created_at: '2026-10-02T12:00:00Z' };
function client(t) {
  const raw = new DatabaseSync(':memory:'); t.after(() => raw.close());
  const api = {
    fail: null,
    async execAsync(sql) { raw.exec(sql); },
    async runAsync(sql, ...args) {
      if (api.fail?.(sql)) throw new Error('Injected failure');
      return raw.prepare(sql).run(...args);
    },
    async getFirstAsync(sql, ...args) { return raw.prepare(sql).get(...args) ?? null; },
    async getAllAsync(sql, ...args) { return raw.prepare(sql).all(...args); },
  };
  return { raw, api, store: new SyncStore(api) };
}

test('new book stores Google link and queues only book fields for synchronization', async t => {
  const { store } = client(t); await store.initialize();
  await store.createBook('book-0001', data, { source: 'google', volume_id: 'duna_123' });
  assert.equal((await store.listBooks())[0].title, 'Duna');
  assert.deepEqual(await store.listGoogleBookLinks(), [{ book_id: 'book-0001', volume_id: 'duna_123' }]);
  assert.deepEqual(await store.listBookMetadata(), []);
  const { operations: [operation] } = await store.prepare();
  assert.equal(operation.entity, 'book');
  assert.deepEqual(operation.data, data);
  assert.equal(await store.pendingCount(), 1);
});

test('failed catalog insert rolls back new book and synchronization queue', async t => {
  const { api, store } = client(t); await store.initialize();
  api.fail = sql => sql.startsWith('INSERT INTO google_catalog');
  await assert.rejects(store.createBook('book-0001', data, { source: 'google', volume_id: 'duna_123' }), /Injected failure/);
  assert.deepEqual(await store.listBooks(), []);
  assert.deepEqual(await store.listGoogleBookLinks(), []);
  assert.equal(await store.pendingCount(), 0);
  api.fail = null;
  await store.createBook('book-0001', data, { source: 'google', volume_id: 'duna_123' });
  assert.equal((await store.listBooks()).length, 1);
  api.fail = sql => sql.startsWith('INSERT INTO book_catalog');
  await assert.rejects(store.createBook('book-0002', data, { source: 'openlibrary', work_key: '/works/OL123W',
    cover_id: 456, subjects: ['Fiction'], first_publish_year: 1965 }), /Injected failure/);
  assert.equal((await store.listBooks()).length, 1);
  assert.deepEqual(await store.listBookMetadata(), []);
  assert.equal(await store.pendingCount(), 1);
});

test('new Open Library book preserves cover and subjects and exports its association', async t => {
  const { store } = client(t); await store.initialize();
  const link = { source: 'openlibrary', work_key: '/works/OL123W', cover_id: 456, subjects: ['Fiction'], first_publish_year: 1965 };
  await store.createBook('book-0001', data, link);
  assert.deepEqual(await store.listBookMetadata(), [{ book_id: 'book-0001', work_key: '/works/OL123W', cover_id: 456, subjects: ['Fiction'], first_publish_year: 1965 }]);
  assert.equal((await store.exportBackup()).catalog.length, 1);
  assert.deepEqual(await store.listGoogleBookLinks(), []);
});

test('manual registration works offline and invalid associations cannot leave partial books', async t => {
  const { store } = client(t); await store.initialize();
  await assert.rejects(store.createBook('book-0001', data, { source: 'google', volume_id: 'https://bad.example' }), /inválido/i);
  await assert.rejects(store.createBook('book-0001', data, { source: 'openlibrary', work_key: '/bad', cover_id: null, subjects: [], first_publish_year: null }), /inválido/i);
  assert.deepEqual(await store.listBooks(), []);
  await store.createBook('book-0001', data);
  await assert.rejects(store.createBook('book-0001', { ...data, title: 'Outro' }), /existe/i);
  assert.equal((await store.listBooks())[0].title, 'Duna');
  assert.equal(await store.pendingCount(), 1);
  assert.deepEqual(await store.listGoogleBookLinks(), []);
});
