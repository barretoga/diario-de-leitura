import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncStore } from '../src/sync/store.ts';
import { SyncEngine } from '../src/sync/engine.ts';
import { AUTH_ERROR, SERVER_MISMATCH, NEEDS_IDENTITY, OTHER_SERVER, SAME_URL, sendSync, fetchServerInfo, migrateServer, SyncError, normalizeUrl, validateResponse } from '../src/sync/transport.ts';
import { openStore, sync } from '../../server/src/store.js';
import { createAppServer } from '../../server/src/server.js';
import { getServerId } from '../../server/src/identity.js';

const date = '2026-09-21T12:00:00.000Z';
const bookData = { title: 'Livro', author: 'Autora', created_at: date };
const logData = { book_id: 'book-0001', started_at: date, minutes: 20,
  progress_value: 10, progress_unit: 'percent', note: 'Nota', created_at: date };
const token = 'test-token-with-at-least-thirty-two-characters';

function adapter(path = ':memory:') {
  const raw = new DatabaseSync(path);
  const api = {
    fail: null,
    async execAsync(sql) { if (api.fail?.(sql)) throw new Error('Injected failure'); raw.exec(sql); },
    async runAsync(sql, ...args) { if (api.fail?.(sql)) throw new Error('Injected failure'); return raw.prepare(sql).run(...args); },
    async getFirstAsync(sql, ...args) { return raw.prepare(sql).get(...args) ?? null; },
    async getAllAsync(sql, ...args) { return raw.prepare(sql).all(...args); },
  };
  return { raw, api };
}
async function client(t, path) {
  const db = adapter(path);
  t.after(() => db.raw.close());
  const store = new SyncStore(db.api);
  await store.initialize();
  await store.configure('https://reading.example');
  return { ...db, store };
}
function server(t) { const db = openStore(':memory:'); t.after(() => db.close()); return db; }
async function exchange(store, remote, request) {
  request ??= await store.prepare();
  const response = sync(remote, request);
  validateResponse(response, request);
  await store.apply(request, response);
  return response;
}
async function drain(store, remote) {
  let request = await store.prepare();
  for (let i = 0; i < 100; i++) {
    const response = await exchange(store, remote, request);
    request = response.hasMore ? { cursor: response.cursor, operations: [] } : await store.prepare();
    if (!response.hasMore && request.operations.length === 0) return;
  }
  assert.fail('Sync failed to converge');
}
function legacy(raw, title = 'Livro') {
  raw.exec(`CREATE TABLE books(id TEXT PRIMARY KEY,title TEXT NOT NULL,author TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE reading_logs(id TEXT PRIMARY KEY,book_id TEXT REFERENCES books(id),started_at TEXT,minutes INTEGER,
    progress_value REAL,progress_unit TEXT,note TEXT,created_at TEXT);`);
  raw.prepare('INSERT INTO books VALUES(?,?,?,?)').run('book-0001', title, 'Autora', date);
  raw.prepare('INSERT INTO reading_logs VALUES(?,?,?,?,?,?,?,?)').run('log-00001', 'book-0001', date, 20, 10, 'percent', 'Nota', date);
}

test('legacy migration preserves IDs/content, queues dependencies and can run twice', async t => {
  const db = adapter(); t.after(() => db.raw.close()); legacy(db.raw);
  const store = new SyncStore(db.api);
  await store.initialize(); await store.initialize();
  assert.equal(db.raw.prepare('PRAGMA user_version').get().user_version, 8);
  assert.equal(await store.pendingCount(), 2);
  assert.equal((await store.listLogs())[0].created_at, date);
  const request = await store.prepare();
  assert.deepEqual(request.operations.map(op => op.entity), ['book']);
  await exchange(store, server(t), request);
  assert.equal((await store.prepare()).operations[0].entity, 'log');
});

test('migration failure rolls back schema/data and permits a clean retry', async t => {
  const db = adapter(); t.after(() => db.raw.close()); legacy(db.raw);
  db.api.fail = sql => sql.includes('PRAGMA user_version=1');
  const store = new SyncStore(db.api);
  await assert.rejects(store.initialize(), /Injected/);
  assert.equal(db.raw.prepare('PRAGMA user_version').get().user_version, 0);
  assert.equal(db.raw.prepare('SELECT title FROM books').get().title, 'Livro');
  assert.equal(db.raw.prepare('PRAGMA table_info(books)').all().some(c => c.name === 'version'), false);
  db.api.fail = null;
  await store.initialize(); assert.equal(await store.pendingCount(), 2);
});

test('daily goal survives restart, validates bounds and upgrades a version 2 database atomically', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'reading-goal-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'local.db');
  let db = adapter(path);
  let store = new SyncStore(db.api);
  await store.initialize();
  await store.save('book', 'book-0001', bookData);
  await store.setDailyGoal(25);
  assert.equal(await store.dailyGoal(), 25);
  for (const invalid of [0, -1, 1441, 1.5, NaN, Infinity]) {
    await assert.rejects(store.setDailyGoal(invalid), /1 a 1.440/);
  }
  assert.equal(await store.dailyGoal(), 25);
  db.raw.close();
  db = adapter(path); store = new SyncStore(db.api);
  await store.initialize();
  assert.equal(await store.dailyGoal(), 25);
  assert.equal((await store.listBooks())[0].id, 'book-0001');
  await store.setDailyGoal(null);
  assert.equal(await store.dailyGoal(), null);
  db.raw.exec('DROP TABLE google_catalog; DROP TABLE book_catalog; DROP TABLE reading_timer; DROP TABLE reading_preferences; PRAGMA user_version=2;');
  db.api.fail = sql => sql.includes('PRAGMA user_version=3');
  await assert.rejects(store.initialize(), /Injected/);
  assert.equal(db.raw.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(db.raw.prepare("SELECT name FROM sqlite_master WHERE name='reading_preferences'").get(), undefined);
  db.api.fail = null;
  await store.initialize(); await store.initialize();
  assert.equal(db.raw.prepare('PRAGMA user_version').get().user_version, 8);
  assert.equal(await store.dailyGoal(), null);
  assert.equal((await store.listBooks())[0].id, 'book-0001');
  db.raw.close();
});

test('invalid legacy values remain correctable without blocking other books', async t => {
  const db = adapter(); t.after(() => db.raw.close()); legacy(db.raw, 'x'.repeat(501));
  const store = new SyncStore(db.api); await store.initialize();
  await store.save('book', 'book-0002', bookData);
  const request = await store.prepare();
  assert.deepEqual(request.operations.map(op => op.id), ['book-0002']);
  assert.equal((await store.issues())[0].local.title.length, 501);
  await store.save('book', 'book-0001', bookData);
  await drain(store, server(t)); assert.equal(await store.pendingCount(), 0);
});

test('offline CRUD survives restart; response loss retries exact operation, preserving newer edits', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'reading-sync-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'local.db');
  let db = adapter(path); let store = new SyncStore(db.api); await store.initialize();
  await store.save('book', 'book-0001', bookData);
  await store.save('log', 'log-00001', logData);
  await store.save('log', 'log-00001', { ...logData, minutes: 42 });
  db.raw.close();
  db = adapter(path); store = new SyncStore(db.api); await store.initialize();
  try {
    const remote = server(t);
    const first = await store.prepare();
    sync(remote, first); // Server committed; client never received response.
    await store.save('book', 'book-0001', { ...bookData, title: 'Editado durante a requisição' });
    const retry = await store.prepare();
    assert.deepEqual(retry, first);
    await exchange(store, remote, retry);
    assert.equal((await store.listBooks())[0].title, 'Editado durante a requisição');
    await drain(store, remote);
    assert.equal(remote.prepare('SELECT COUNT(*) AS n FROM books').get().n, 1);
    assert.equal(remote.prepare('SELECT minutes FROM reading_logs').get().minutes, 42);
    assert.equal(remote.prepare('SELECT version FROM books').get().version, 2);
    await store.remove('log', 'log-00001');
    assert.equal((await store.listLogs()).length, 0);
    db.raw.close(); db = adapter(path); store = new SyncStore(db.api); await store.initialize();
    await drain(store, remote);
    assert.ok(remote.prepare('SELECT deleted_at FROM reading_logs').get().deleted_at);
  } finally { db.raw.close(); }
});

test('two clients detect conflicts, retain newer server version and honor both resolution choices', async t => {
  const a = (await client(t)).store, b = (await client(t)).store, remote = server(t);
  await a.save('book', 'book-0001', bookData); await drain(a, remote); await drain(b, remote);
  await a.save('book', 'book-0001', { ...bookData, title: 'A' });
  await b.save('book', 'book-0001', { ...bookData, title: 'B' });
  await drain(a, remote); await drain(b, remote);
  assert.equal((await b.issues())[0].remote.title, 'A');
  assert.equal((await b.listBooks())[0].title, 'B');
  await a.save('book', 'book-0001', { ...bookData, title: 'A2' }); await drain(a, remote); await drain(b, remote);
  assert.equal((await b.issues())[0].remote.title, 'A2');
  await b.resolve('book', 'book-0001', 'local'); await drain(b, remote); await drain(a, remote);
  assert.equal((await a.listBooks())[0].title, 'B');
  await a.save('book', 'book-0001', { ...bookData, title: 'A3' });
  await b.save('book', 'book-0001', { ...bookData, title: 'B3' }); await drain(b, remote); await drain(a, remote);
  await a.resolve('book', 'book-0001', 'remote');
  assert.equal((await a.listBooks())[0].title, 'B3'); assert.equal(await a.pendingCount(), 0);
});

test('editing versus deletion supports resurrection and accepting the tombstone', async t => {
  const a = (await client(t)).store, b = (await client(t)).store, remote = server(t);
  await a.save('book', 'book-0001', bookData); await a.save('log', 'log-00001', logData);
  await drain(a, remote); await drain(b, remote);
  await a.remove('log', 'log-00001'); await b.save('log', 'log-00001', { ...logData, minutes: 30 });
  await drain(a, remote); await drain(b, remote);
  assert.ok((await b.issues())[0].remote.deleted_at);
  await b.resolve('log', 'log-00001', 'local'); await drain(b, remote); await drain(a, remote);
  assert.equal((await a.listLogs())[0].minutes, 30);
  await a.remove('log', 'log-00001'); await b.save('log', 'log-00001', { ...logData, minutes: 40 });
  await drain(a, remote); await drain(b, remote); await b.resolve('log', 'log-00001', 'remote');
  assert.equal((await b.listLogs()).length, 0); assert.equal(await b.pendingCount(), 0);
});

test('book conflict suspends dependent logs while unrelated records synchronize', async t => {
  const a = (await client(t)).store, b = (await client(t)).store, remote = server(t);
  await a.save('book', 'book-0001', bookData); await drain(a, remote); await drain(b, remote);
  await a.save('book', 'book-0001', { ...bookData, title: 'A' }); await drain(a, remote);
  await b.save('book', 'book-0001', { ...bookData, title: 'B' });
  await b.save('log', 'log-00001', logData); await b.save('book', 'book-0002', bookData);
  await drain(b, remote);
  assert.equal(remote.prepare('SELECT COUNT(*) AS n FROM books').get().n, 2);
  assert.equal(remote.prepare('SELECT COUNT(*) AS n FROM reading_logs').get().n, 0);
  await b.resolve('book', 'book-0001', 'remote'); await drain(b, remote);
  assert.equal(await b.pendingCount(), 0);
});

test('batches over 100 and pages over 500 converge without losing pending edits', async t => {
  const a = (await client(t)).store, b = (await client(t)).store, remote = server(t);
  for (let i = 0; i < 510; i++) await a.save('book', `book-${String(i).padStart(5, '0')}`, bookData);
  assert.equal((await a.prepare()).operations.length, 100);
  await drain(a, remote);
  const first = await exchange(b, remote);
  assert.equal(first.changes.length, 500); assert.equal(first.hasMore, true);
  await drain(b, remote);
  assert.equal((await b.listBooks()).length, 510);
  assert.equal((await b.settings()).cursor, 510);
});

test('apply is atomic; failed cursor update rolls back acknowledgements and changes', async t => {
  const { store, api } = await client(t), remote = server(t);
  await store.save('book', 'book-0001', bookData);
  const request = await store.prepare(), response = sync(remote, request);
  api.fail = sql => sql.startsWith('UPDATE sync_settings SET cursor');
  await assert.rejects(store.apply(request, response), /Injected/);
  assert.equal((await store.settings()).cursor, 0); assert.equal(await store.pendingCount(), 1);
  assert.equal((await store.get('book', 'book-0001')).version, 0);
  api.fail = null; await exchange(store, remote);
  assert.equal(await store.pendingCount(), 0);
});

test('local data and queue writes roll back together', async t => {
  const { store, api } = await client(t);
  api.fail = sql => sql.includes('INSERT INTO sync_pending');
  await assert.rejects(store.save('book', 'book-0001', bookData), /Injected/);
  assert.equal((await store.listBooks()).length, 0);
  assert.equal(await store.pendingCount(), 0);
});

test('HTTPS normalization and immutable server binding; auth recovery does not clear cursor block', async t => {
  assert.equal(normalizeUrl(' https://EXAMPLE.com/base/ '), 'https://example.com/base');
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com?token=x', 'bad']) assert.throws(() => normalizeUrl(url));
  const { store } = await client(t);
  await assert.rejects(store.configure('https://other.example'), /vinculado/);
  await store.block('Cursor inválido'); await store.clearBlock(AUTH_ERROR);
  assert.equal((await store.settings()).fatal, 'Cursor inválido');
});

test('transport handles authentication, timeout, future cursor and malformed response without leaking tokens', async t => {
  const http = createAppServer({ token, databasePath: ':memory:' });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const url = `http://127.0.0.1:${http.address().port}`;
  const request = { cursor: 0, operations: [] };
  await assert.rejects(sendSync(url, 'secret-wrong', request), error => error.kind === 'auth' && !error.message.includes('secret-wrong'));
  await assert.rejects(sendSync(url, token, { ...request, cursor: 99 }), error => error.kind === 'cursor');
  await assert.rejects(sendSync(url, token, request, { timeoutMs: 5, fetcher: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('timeout')));
  }) }), error => error.kind === 'network');
  await assert.rejects(sendSync(url, token, request, { fetcher: async () => new Response('{"results":[]}', { status: 200 }) }), error => error.kind === 'protocol');
  assert.equal((await sendSync(url, token, request)).cursor, 0);
});

test('engine synchronizes automatically, serializes overlapping requests and preserves in-flight edits', async t => {
  const { store } = await client(t), remote = server(t);
  await store.save('book', 'book-0001', bookData);
  let release; const gate = new Promise(resolve => { release = resolve; });
  let calls = 0, concurrent = 0, maxConcurrent = 0;
  const engine = new SyncEngine(store, async () => token, async (_url, _token, request) => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); calls++;
    if (calls === 1) await gate;
    const response = sync(remote, request); concurrent--; return response;
  });
  t.after(() => engine.setActive(false));
  engine.setActive(true);
  await new Promise(resolve => setTimeout(resolve, 5));
  await store.save('book', 'book-0001', { ...bookData, title: 'Latest' });
  const overlapping = engine.request(); release(); await overlapping;
  assert.equal(maxConcurrent, 1);
  assert.equal(remote.prepare('SELECT title FROM books').get().title, 'Latest');
  assert.equal(await store.pendingCount(), 0); assert.ok((await store.settings()).lastSuccess);
});

test('engine pauses, blocks auth persistently, and never resets an invalid cursor', async t => {
  const { store } = await client(t);
  let calls = 0;
  const engine = new SyncEngine(store, async () => token, async () => { calls++; throw new SyncError('auth', AUTH_ERROR); });
  t.after(() => engine.setActive(false));
  await store.pause(true); engine.setActive(true); await engine.settled(); assert.equal(calls, 0);
  await engine.pause(false); assert.equal(calls, 1); assert.equal((await store.settings()).fatal, AUTH_ERROR);
  await engine.request(); assert.equal(calls, 1);
  await store.clearBlock(AUTH_ERROR);
  const cursorEngine = new SyncEngine(store, async () => token, async () => { throw new SyncError('cursor', 'Cursor inválido'); });
  cursorEngine.setActive(true); await cursorEngine.settled(); cursorEngine.setActive(false);
  assert.equal((await store.settings()).fatal, 'Cursor inválido'); assert.equal((await store.settings()).cursor, 0);
});

test('offline errors schedule retry only while active; foreground retries frozen operations', async t => {
  const { store } = await client(t), remote = server(t);
  await store.save('book', 'book-0001', bookData);
  let calls = 0, lost;
  const engine = new SyncEngine(store, async () => token, async (_url, _token, request) => {
    calls++;
    if (calls === 1) { lost = request; sync(remote, request); throw new SyncError('network', 'offline'); }
    assert.deepEqual(request.operations, lost.operations);
    return sync(remote, request);
  });
  t.after(() => engine.setActive(false));
  engine.setActive(true); await engine.settled(); assert.equal(engine.status.phase, 'offline');
  engine.setActive(false); assert.equal(await store.pendingCount(), 1);
  engine.setActive(true); await engine.settled(); assert.equal(await store.pendingCount(), 0);
});

test('deleting an unsent log requires no remote tombstone; deleting a sent creation retries then deletes', async t => {
  const { store } = await client(t), remote = server(t);
  await store.save('book', 'book-0001', bookData); await drain(store, remote);
  await store.save('log', 'log-00001', logData); await store.remove('log', 'log-00001'); await drain(store, remote);
  assert.equal(remote.prepare('SELECT COUNT(*) AS n FROM reading_logs').get().n, 0);
  await store.save('log', 'log-00002', logData);
  const sent = await store.prepare(); sync(remote, sent);
  await store.remove('log', 'log-00002');
  assert.deepEqual((await store.prepare()).operations, sent.operations);
  await drain(store, remote);
  assert.ok(remote.prepare('SELECT deleted_at FROM reading_logs WHERE id=?').get('log-00002').deleted_at);
  assert.equal(await store.pendingCount(), 0);
});

test('remote deletion of a parent preserves local child as a correctable issue', async t => {
  const a = (await client(t)).store, b = (await client(t)).store, remote = server(t);
  await a.save('book', 'book-0001', bookData); await drain(a, remote); await drain(b, remote);
  await a.remove('book', 'book-0001'); await drain(a, remote);
  await b.save('log', 'log-00001', logData); await drain(b, remote);
  assert.equal((await b.listLogs()).length, 1);
  assert.equal((await b.issues()).length, 1);
  await b.save('book', 'book-0002', bookData);
  await b.save('log', 'log-00001', { ...logData, book_id: 'book-0002' }); await drain(b, remote);
  assert.equal(await b.pendingCount(), 0);
  assert.equal(remote.prepare('SELECT book_id FROM reading_logs').get().book_id, 'book-0002');
});

test('server validation rejection can be corrected without replaying the rejected operation', async t => {
  const { store } = await client(t), remote = server(t);
  await store.save('book', 'book-0001', bookData);
  const request = await store.prepare();
  await store.apply(request, { results: [{ opId: request.operations[0].opId, status: 'invalid', reason: 'Título inválido' }], changes: [], cursor: 0, hasMore: false });
  assert.equal((await store.prepare()).operations.length, 0);
  assert.equal((await store.issues())[0].error, 'Título inválido');
  await store.save('book', 'book-0001', { ...bookData, title: 'Corrigido' });
  const corrected = await store.prepare();
  assert.notEqual(corrected.operations[0].opId, request.operations[0].opId);
  await exchange(store, remote, corrected); assert.equal(await store.pendingCount(), 0);
});

test('conflict resolution raced by another client produces a new conflict', async t => {
  const a = (await client(t)).store, b = (await client(t)).store, remote = server(t);
  await a.save('book', 'book-0001', bookData); await drain(a, remote); await drain(b, remote);
  await a.save('book', 'book-0001', { ...bookData, title: 'A' }); await drain(a, remote);
  await b.save('book', 'book-0001', { ...bookData, title: 'B' }); await drain(b, remote);
  await b.resolve('book', 'book-0001', 'local');
  await a.save('book', 'book-0001', { ...bookData, title: 'A2' }); await drain(a, remote); await drain(b, remote);
  assert.equal((await b.issues())[0].remote.title, 'A2'); assert.equal((await b.listBooks())[0].title, 'B');
});

test('foreign keys reject remote orphan and roll back the entire page', async t => {
  const { store } = await client(t);
  await assert.rejects(store.apply({ cursor: 0, operations: [] }, {
    results: [], changes: [{ seq: 1, entity: 'log', id: 'log-00001', payload: {
      ...logData, id: 'log-00001', version: 1, updated_at: date, deleted_at: null,
    } }], cursor: 1, hasMore: false,
  }), /FOREIGN KEY/);
  assert.equal((await store.settings()).cursor, 0); assert.equal((await store.listLogs()).length, 0);
});

test('payload size cap keeps batches of long Unicode notes below 1 MB', async t => {
  const { store } = await client(t), remote = server(t);
  await store.save('book', 'book-0001', bookData); await drain(store, remote);
  for (let i = 0; i < 100; i++) await store.save('log', `log-${String(i).padStart(5, '0')}`, { ...logData, note: '漢'.repeat(10000) });
  const request = await store.prepare();
  assert.ok(request.operations.length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify(request)) < 1000000);
  await drain(store, remote); assert.equal(await store.pendingCount(), 0);
});

test('acknowledgement on a later page does not overwrite a newer local edit', async t => {
  const { store } = await client(t), remote = server(t);
  for (let i = 0; i < 505; i++) {
    sync(remote, { cursor: 0, operations: [{ opId: `seed-op-${i}`, entity: 'book', id: `seed-book-${i}`, baseVersion: 0, deleted: false, data: bookData }] });
  }
  await store.save('book', 'book-0001', bookData);
  const request = await store.prepare(); const response = sync(remote, request);
  await store.save('book', 'book-0001', { ...bookData, title: 'New local edit' });
  await store.apply(request, response);
  assert.equal(response.hasMore, true);
  await exchange(store, remote, { cursor: response.cursor, operations: [] });
  assert.equal((await store.get('book', 'book-0001')).title, 'New local edit');
  assert.equal((await store.issues()).length, 0);
  await drain(store, remote);
  assert.equal(remote.prepare('SELECT title FROM books WHERE id=?').get('book-0001').title, 'New local edit');
});

test('network backoff increases, stops in background, and resets after success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store } = await client(t), remote = server(t);
  let calls = 0;
  const engine = new SyncEngine(store, async () => token, async (_url, _token, request) => {
    calls++;
    if (calls <= 2 || calls === 4) throw new SyncError('network', 'offline');
    return sync(remote, request);
  });
  t.after(() => engine.setActive(false));
  engine.setActive(true); await engine.settled(); assert.equal(calls, 1);
  t.mock.timers.tick(999); assert.equal(calls, 1);
  t.mock.timers.tick(1); await engine.settled(); assert.equal(calls, 2);
  t.mock.timers.tick(1999); assert.equal(calls, 2);
  t.mock.timers.tick(1); await engine.settled(); assert.equal(calls, 3);
  await engine.request(); assert.equal(calls, 4);
  t.mock.timers.tick(1000); await engine.settled(); assert.equal(calls, 5);
  engine.setActive(false); t.mock.timers.tick(60000); assert.equal(calls, 5);
});

test('leaving foreground aborts active transport without a permanent block or stuck status', async t => {
  const { store } = await client(t);
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const engine = new SyncEngine(store, async () => token, async (_url, _token, _request, { signal }) => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new SyncError('network', 'aborted'))));
  });
  engine.setActive(true); await start; engine.setActive(false); await engine.settled();
  assert.equal(engine.status.phase, 'idle'); assert.equal((await store.settings()).fatal, null);
});

test('validateResponse accepts optional serverId and rejects invalid ones', () => {
  const request = { cursor: 0, operations: [] };
  const base = { results: [], changes: [], cursor: 0, hasMore: false };
  validateResponse({ ...base }, request);
  validateResponse({ ...base, serverId: 'a'.repeat(64) }, request);
  for (const serverId of [42, null, '', 'a'.repeat(65), {}]) {
    assert.throws(() => validateResponse({ ...base, serverId }, request), error => error instanceof SyncError && error.kind === 'protocol');
  }
});

test('first sync against the real server memorizes its serverId', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'server-id-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'server.sqlite');
  const http = createAppServer({ token, databasePath });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const url = `http://127.0.0.1:${http.address().port}`;
  const { store } = await client(t);
  assert.equal((await store.settings()).serverId, null);
  await store.save('book', 'book-0001', bookData);
  const engine = new SyncEngine(store, async () => token, (_url, tok, request, options) => sendSync(url, tok, request, options));
  t.after(() => engine.setActive(false));
  engine.setActive(true); await engine.settled();
  const remote = openStore(databasePath); t.after(() => remote.close());
  assert.equal((await store.settings()).serverId, getServerId(remote));
  assert.equal(await store.pendingCount(), 0);
});

test('response from a different server blocks without touching cursor or queue', async t => {
  const { store } = await client(t), remote = server(t);
  await store.save('book', 'book-0001', bookData);
  await exchange(store, remote);
  await store.apply({ cursor: (await store.settings()).cursor, operations: [] }, { results: [], changes: [], cursor: (await store.settings()).cursor, hasMore: false, serverId: 'server-a' });
  assert.equal((await store.settings()).serverId, 'server-a');
  await store.save('book', 'book-0002', { ...bookData, title: 'Outro' });
  const before = await store.settings(), pending = await store.pendingCount();
  const engine = new SyncEngine(store, async () => token, async (_url, _token, request) => ({ ...sync(remote, request), serverId: 'server-b' }));
  t.after(() => engine.setActive(false));
  engine.setActive(true); await engine.settled();
  assert.equal(engine.status.phase, 'blocked');
  const after = await store.settings();
  assert.equal(after.fatal, SERVER_MISMATCH);
  assert.equal(after.cursor, before.cursor);
  assert.equal(after.serverId, 'server-a');
  assert.equal(await store.pendingCount(), pending);
  assert.equal((await store.listBooks()).find(book => book.id === 'book-0002').version, 0);
});

test('response without serverId (old server) is applied and keeps serverId null', async t => {
  const { store } = await client(t), remote = server(t);
  await store.save('book', 'book-0001', bookData);
  await exchange(store, remote);
  assert.equal(await store.pendingCount(), 0);
  assert.equal((await store.settings()).serverId, null);
  assert.ok((await store.settings()).cursor > 0);
});

test('version 7 database migrates to 8 preserving url and cursor', async t => {
  const db = adapter(); t.after(() => db.raw.close());
  const first = new SyncStore(db.api); await first.initialize();
  db.raw.exec("ALTER TABLE sync_settings DROP COLUMN server_id; PRAGMA user_version=7;");
  db.raw.exec("UPDATE sync_settings SET url='https://reading.example', cursor=42 WHERE id=1");
  const store = new SyncStore(db.api); await store.initialize();
  assert.equal(db.raw.prepare('PRAGMA user_version').get().user_version, 8);
  const settings = await store.settings();
  assert.equal(settings.url, 'https://reading.example'); assert.equal(settings.cursor, 42); assert.equal(settings.serverId, null);
});

const json = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
test('fetchServerInfo reads GET /v1/server with bearer token and no redirects', async () => {
  const calls = [];
  const info = await fetchServerInfo('https://new.example', token, { fetcher: async (url, init) => {
    calls.push({ url, init }); return new Response(JSON.stringify({ protocolVersion: 1, serverId: 'server-a' }), { status: 200 });
  } });
  assert.deepEqual(info, { serverId: 'server-a' });
  assert.equal(calls[0].url, 'https://new.example/v1/server');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].init.redirect, 'error');
});
test('fetchServerInfo maps errors like sendSync', async () => {
  await assert.rejects(fetchServerInfo('https://new.example', token, { fetcher: json({ error: 'x' }, 401) }), error => error instanceof SyncError && error.kind === 'auth' && error.message === AUTH_ERROR);
  await assert.rejects(fetchServerInfo('https://new.example', token, { fetcher: json({}, 503) }), error => error.kind === 'network');
  await assert.rejects(fetchServerInfo('https://new.example', token, { fetcher: async () => { throw new TypeError('offline'); } }), error => error.kind === 'network');
  for (const body of [{ protocolVersion: 1 }, { protocolVersion: 1, serverId: '' }, { protocolVersion: 1, serverId: 'a'.repeat(65) }, { protocolVersion: 2, serverId: 'a' }]) {
    await assert.rejects(fetchServerInfo('https://new.example', token, { fetcher: json(body) }), error => error.kind === 'protocol');
  }
  await assert.rejects(fetchServerInfo('https://new.example', token, { timeoutMs: 5, fetcher: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }) }), error => error.kind === 'network');
});
async function bound(t, serverId = 'server-a') {
  const { store, raw } = await client(t), remote = server(t);
  await store.save('book', 'book-0001', bookData);
  await exchange(store, remote);
  if (serverId) await store.apply({ cursor: (await store.settings()).cursor, operations: [] }, { results: [], changes: [], cursor: (await store.settings()).cursor, hasMore: false, serverId });
  await store.save('book', 'book-0002', { ...bookData, title: 'Pendente' });
  raw.prepare("INSERT INTO sync_conflicts(entity,id,current_json) VALUES('book','book-0001','null')").run();
  return { store, raw };
}
const state = async (store, raw) => ({ settings: await store.settings(), pending: raw.prepare('SELECT * FROM sync_pending ORDER BY id').all(),
  conflicts: raw.prepare('SELECT * FROM sync_conflicts').all() });
test('store.migrate with the same serverId changes only the url and clears mismatch/auth blocks', async t => {
  const { store, raw } = await bound(t);
  for (const fatal of [SERVER_MISMATCH, AUTH_ERROR]) {
    await store.block(fatal);
    const before = await state(store, raw);
    await store.migrate('https://new.example', 'server-a');
    const after = await state(store, raw);
    assert.equal(after.settings.url, 'https://new.example');
    assert.equal(after.settings.fatal, null);
    assert.equal(after.settings.cursor, before.settings.cursor);
    assert.equal(after.settings.serverId, 'server-a');
    assert.deepEqual(after.pending, before.pending); assert.ok(after.pending.length > 0);
    assert.deepEqual(after.conflicts, before.conflicts);
  }
  await store.block('Cursor inválido');
  await store.migrate('https://other.example', 'server-a');
  assert.equal((await store.settings()).fatal, 'Cursor inválido');
});
test('store.migrate refuses a different or missing serverId and keeps the old url', async t => {
  const { store, raw } = await bound(t);
  const before = await state(store, raw);
  await assert.rejects(store.migrate('https://new.example', 'server-b'), { message: OTHER_SERVER });
  assert.deepEqual(await state(store, raw), before);
  const unbound = await bound(t, null);
  await assert.rejects(unbound.store.migrate('https://new.example', 'server-a'), { message: OTHER_SERVER });
  assert.equal((await unbound.store.settings()).url, 'https://reading.example');
});
test('migrateServer checks url, identity and remote serverId before migrating', async t => {
  const { store, raw } = await bound(t);
  const info = id => ({ fetcher: json({ protocolVersion: 1, serverId: id }) });
  await assert.rejects(migrateServer(store, 'http://new.example', token, info('server-a')), /HTTPS/);
  let fetched = false;
  await assert.rejects(migrateServer(store, 'https://Reading.Example/', token, { fetcher: async () => { fetched = true; } }), { message: SAME_URL });
  assert.equal(fetched, false);
  const before = await state(store, raw);
  await assert.rejects(migrateServer(store, 'https://new.example', token, info('server-b')), { message: OTHER_SERVER });
  await assert.rejects(migrateServer(store, 'https://new.example', token, { fetcher: async () => { throw new TypeError('offline'); } }), error => error.kind === 'network');
  assert.deepEqual(await state(store, raw), before);
  await migrateServer(store, 'https://New.Example/', token, info('server-a'));
  assert.equal((await store.settings()).url, 'https://new.example');
  const unbound = await bound(t, null);
  await assert.rejects(migrateServer(unbound.store, 'https://new.example', token, { fetcher: async () => { fetched = true; } }), { message: NEEDS_IDENTITY });
  assert.equal(fetched, false);
});
