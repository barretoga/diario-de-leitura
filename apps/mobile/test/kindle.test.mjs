import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseClippings, MAX_CLIPPINGS_BYTES } from '../src/kindle/parser.ts';
import { SyncStore } from '../src/sync/store.ts';
import { validateResponse } from '../src/sync/transport.ts';
import { parseBackup, serializeBackup } from '../src/backup/format.ts';
import { openStore, sync } from '../../server/src/store.js';

const fixture = readFileSync(new URL('./fixtures/clippings.txt', import.meta.url), 'utf8');
const digest = async text => createHash('sha256').update(text).digest('hex');
const parse = (text = fixture) => parseClippings(text, digest);
const newBooks = parsed => Object.fromEntries(parsed.groups.map(group => [group.key, 'new']));
async function client(t) {
  const raw = new DatabaseSync(':memory:'); t.after(() => raw.close());
  const adapter = {
    fail: null,
    async execAsync(sql) { if (adapter.fail?.(sql)) throw new Error('Injected failure'); raw.exec(sql); },
    async runAsync(sql, ...args) { if (adapter.fail?.(sql)) throw new Error('Injected failure'); return raw.prepare(sql).run(...args); },
    async getFirstAsync(sql, ...args) { return raw.prepare(sql).get(...args) ?? null; },
    async getAllAsync(sql, ...args) { return raw.prepare(sql).all(...args); },
  };
  const store = new SyncStore(adapter); await store.initialize();
  return { store, raw, adapter };
}
async function drain(store, remote) {
  let request = await store.prepare();
  for (let i = 0; i < 50; i++) {
    const response = sync(remote, request); validateResponse(response, request); await store.apply(request, response);
    request = response.hasMore ? { cursor: response.cursor, operations: [] } : await store.prepare();
    if (!response.hasMore && !request.operations.length) return;
  }
  assert.fail('Did not converge');
}
test('Portuguese and English highlights, notes and empty bookmarks preserve metadata and multiline text', async () => {
  const result = await parse();
  assert.equal(result.entries.length, 4); assert.equal(result.groups.length, 2); assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.entries.map(row => row.kind), ['highlight', 'note', 'bookmark', 'highlight']);
  assert.equal(result.entries[0].location, '150-152'); assert.equal(result.entries[0].page, '12');
  assert.match(result.entries[0].content, /\nSegunda linha/);
  assert.equal(result.entries[1].source_date, 'segunda-feira, 21 de setembro de 2026 09:16:00');
  assert.equal(result.entries[2].content, ''); assert.equal(result.entries[3].author, 'Example Author');
});
test('BOM, CRLF, missing last separator and exact repeats have stable fingerprints', async () => {
  const first = await parse();
  const variant = await parse('\uFEFF' + fixture.replace(/\n/g, '\r\n').replace(/==========\r\n$/, ''));
  assert.deepEqual(variant.entries, first.entries);
  const repeated = await parse(fixture + fixture.replace('09:15:00', '11:00:00'));
  assert.equal(repeated.entries.length, 4); assert.equal(repeated.duplicates, 4);
});
test('unrecognized blocks, empty highlights, invalid UTF-8 and oversized files do not fabricate annotations', async () => {
  const result = await parse('Broken block\n==========\nBook\n- Your Highlight on page 1\n\n==========\nBuch\n- Ihre Markierung bei Position 1\n\nText\n==========');
  assert.equal(result.entries.length, 0); assert.equal(result.rejected.length, 3);
  await assert.rejects(parse('a\0b'), /UTF-8/);
  await assert.rejects(parse('a'.repeat(MAX_CLIPPINGS_BYTES + 1)), /10 MB/);
  await assert.rejects(parse(('x\n==========\n').repeat(10001)), /10.000/);
});
test('unknown dates remain raw, missing authors are allowed, and different locations are not merged', async () => {
  const text = 'Title without author\n- Your Note on Location 2 | Added on unknown date\n\nSame note\n==========\nTitle without author\n- Your Note on Location 3 | Added on unknown date\n\nSame note';
  const result = await parse(text);
  assert.equal(result.entries.length, 2); assert.equal(result.entries[0].author, '');
  assert.equal(result.entries[0].source_date, 'unknown date');
  assert.notEqual(result.entries[0].fingerprint, result.entries[1].fingerprint);
});
test('import is atomic, creates no reading sessions and remains deduplicated after restart/deletion', async t => {
  const { store, raw, adapter } = await client(t); const parsed = await parse();
  const result = await store.importClippings(parsed, newBooks(parsed));
  assert.deepEqual(result, { added: 4, duplicates: 0, skipped: 0, booksAdded: 2 });
  assert.equal((await store.listLogs()).length, 0); assert.equal(await store.pendingCount(), 6);
  const id = (await store.listAnnotations())[0].id; await store.remove('annotation', id);
  const restarted = new SyncStore(adapter); await restarted.initialize();
  assert.equal((await restarted.importClippings(parsed, newBooks(parsed))).duplicates, 4);
  assert.equal((await restarted.listAnnotations()).length, 3);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM annotations').get().n, 4);
});
test('mapping to an existing book or skipping a title never overwrites the book', async t => {
  const { store } = await client(t), parsed = await parse();
  await store.save('book', 'existing-book', { title: 'Meu título', author: 'Minha autora', created_at: '2026-09-21T12:00:00Z' });
  const map = { [parsed.groups[0].key]: 'existing-book', [parsed.groups[1].key]: 'skip' };
  const result = await store.importClippings(parsed, map);
  assert.equal(result.added, 3); assert.equal(result.skipped, 1); assert.equal(result.booksAdded, 0);
  assert.equal((await store.listBooks())[0].title, 'Meu título');
  assert.equal((await store.listAnnotations())[0].book_id, 'existing-book');
});
test('mid-import failure and a book removed after preview roll back books, annotations and queue', async t => {
  const { store, adapter } = await client(t), parsed = await parse();
  adapter.fail = sql => sql.startsWith('INSERT INTO annotations');
  await assert.rejects(store.importClippings(parsed, newBooks(parsed)), /Injected/);
  assert.equal((await store.listBooks()).length, 0); assert.equal(await store.pendingCount(), 0);
  adapter.fail = null;
  const map = newBooks(parsed); map[parsed.groups[1].key] = 'missing-book';
  await assert.rejects(store.importClippings(parsed, map), /não existe/);
  assert.equal((await store.listAnnotations()).length, 0); assert.equal((await store.listBooks()).length, 0);
});
test('schema v1 upgrades without losing books/queue and failed v2 migration can retry', async t => {
  const { store, raw, adapter } = await client(t);
  await store.save('book', 'existing-book', { title: 'Antes', author: '', created_at: '2026-09-21T12:00:00Z' });
  raw.exec('DROP TABLE google_catalog; DROP TABLE book_catalog; DROP TABLE annotations; DROP TABLE reading_preferences; DROP TABLE reading_timer; PRAGMA user_version=1;');
  adapter.fail = sql => sql.includes('CREATE TABLE annotations');
  const upgraded = new SyncStore(adapter);
  await assert.rejects(upgraded.initialize(), /Injected/);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1);
  adapter.fail = null; await upgraded.initialize(); await upgraded.initialize();
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 8);
  assert.equal((await upgraded.listBooks())[0].title, 'Antes'); assert.equal(await upgraded.pendingCount(), 1);
});
test('annotation backup v3 round trips, retains deduplication and validates references', async t => {
  const a = await client(t), b = await client(t), parsed = await parse();
  await a.store.importClippings(parsed, newBooks(parsed));
  const backup = parseBackup(serializeBackup(await a.store.exportBackup()));
  assert.equal(backup.version, 4); assert.equal(backup.annotations.length, 4);
  assert.equal((await b.store.restoreBackup(backup)).annotationsAdded, 4);
  assert.equal((await b.store.importClippings(parsed, newBooks(parsed))).duplicates, 4);
  assert.deepEqual((await b.store.exportBackup()).annotations, backup.annotations);
  const bad = structuredClone(backup); bad.annotations[0].book_id = 'unknown-book';
  assert.throws(() => parseBackup(JSON.stringify(bad)), /sem livro/);
  const legacy = { format: backup.format, version: 1, exportedAt: backup.exportedAt, books: [], logs: [] };
  assert.equal(parseBackup(JSON.stringify(legacy)).version, 1);
  assert.throws(() => parseBackup(JSON.stringify({ ...legacy, annotations: [] })), /versão 2/);
});
test('two clients synchronize annotations, retry idempotently, resolve moves and propagate deletion', async t => {
  const a = await client(t), b = await client(t), parsed = await parse();
  const remote = openStore(':memory:'); t.after(() => remote.close());
  await a.store.importClippings(parsed, newBooks(parsed));
  const books = await a.store.prepare(); assert.ok(books.operations.every(op => op.entity === 'book'));
  await a.store.apply(books, sync(remote, books));
  const annotations = await a.store.prepare(); sync(remote, annotations);
  assert.deepEqual(await a.store.prepare(), annotations); await a.store.apply(annotations, sync(remote, annotations));
  await drain(b.store, remote); assert.equal((await b.store.listAnnotations()).length, 4);
  const row = (await a.store.listAnnotations())[0];
  const otherBook = (await a.store.listBooks()).find(book => book.id !== row.book_id);
  await a.store.save('annotation', row.id, { ...row, book_id: otherBook.id }); await drain(a.store, remote);
  await b.store.remove('annotation', row.id); await drain(b.store, remote);
  assert.equal((await b.store.issues())[0].entity, 'annotation');
  await b.store.resolve('annotation', row.id, 'local'); await drain(b.store, remote); await drain(a.store, remote);
  assert.equal((await a.store.listAnnotations()).length, 3);
  assert.equal((await a.store.importClippings(parsed, newBooks(parsed))).duplicates, 4);
});
test('server rejects malformed annotations and refuses deleting a book with active annotations', async t => {
  const { store } = await client(t), parsed = await parse();
  const remote = openStore(':memory:'); t.after(() => remote.close());
  await store.importClippings(parsed, newBooks(parsed)); await drain(store, remote);
  const row = (await store.listAnnotations())[0];
  const request = { cursor: 0, operations: [{ opId: 'delete-book-test', entity: 'book', id: row.book_id, baseVersion: 1, deleted: true }] };
  assert.equal(sync(remote, request).results[0].status, 'invalid');
  for (const change of [{ content: 4 }, { kind: 'session' }, { fingerprint: 'bad' }, { book_id: 'missing-book' }, { source_date: 123 }]) {
    const response = sync(remote, { cursor: 0, operations: [{ opId: 'malformed-annotation', entity: 'annotation', id: row.id, baseVersion: row.version, deleted: false, data: { ...row, ...change } }] });
    assert.equal(response.results[0].status, 'invalid');
  }
  assert.equal(sync(remote, { cursor: 0, operations: [{ entity: '__proto__' }] }).results[0].status, 'invalid');
});
