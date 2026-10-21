import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncStore } from '../src/sync/store.ts';
import { timerClock, timerElapsedMs, timerLogMinutes } from '../src/timer/readingTimer.ts';

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
const start = '2026-09-22T12:00:00.000Z';
const book = { title: 'Livro', author: '', created_at: start };
const log = { book_id: 'book-0001', started_at: start, minutes: 2, progress_value: null,
  progress_unit: null, note: '', created_at: start };

test('timer counts wall time while away, pauses, resumes and survives a database restart', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'reading-timer-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'local.db');
  let db = adapter(path), store = new SyncStore(db.api);
  await store.initialize();
  assert.equal(await store.timer(), null);
  await store.startTimer(start);
  await assert.rejects(store.startTimer(start), /Já existe/);
  db.raw.close();
  db = adapter(path); store = new SyncStore(db.api); await store.initialize();
  assert.equal(timerClock(await store.timer(), new Date('2026-09-22T12:01:30.000Z')), '00:01:30');
  const paused = await store.pauseTimer('2026-09-22T12:01:30.000Z');
  assert.equal(paused.elapsed_ms, 90000);
  assert.equal((await store.pauseTimer('2026-09-22T12:04:00.000Z')).elapsed_ms, 90000);
  assert.equal(timerLogMinutes(paused, new Date('2026-09-22T12:04:00.000Z')), 2);
  await store.resumeTimer('2026-09-22T12:05:00.000Z');
  assert.equal((await store.resumeTimer('2026-09-22T12:07:00.000Z')).resumed_at, '2026-09-22T12:05:00.000Z');
  assert.equal((await store.pauseTimer('2026-09-22T12:05:30.000Z')).elapsed_ms, 120000);
  await store.discardTimer();
  assert.equal(await store.timer(), null);
  assert.equal(await store.pendingCount(), 0);
  db.raw.close();
});

test('registering a paused timer saves one log and clears the timer in the same transaction', async t => {
  const db = adapter(); t.after(() => db.raw.close());
  const store = new SyncStore(db.api); await store.initialize();
  await store.save('book', 'book-0001', book);
  await store.startTimer(start);
  await store.pauseTimer('2026-09-22T12:01:01.000Z');
  db.api.fail = sql => sql.includes('DELETE FROM reading_timer');
  await assert.rejects(store.saveTimedLog('log-00001', log), /Injected/);
  assert.equal((await store.listLogs()).length, 0);
  assert.equal(await store.pendingCount(), 1);
  assert.ok(await store.timer());
  db.api.fail = null;
  await store.saveTimedLog('log-00001', log);
  assert.equal((await store.listLogs())[0].minutes, 2);
  assert.equal(await store.timer(), null);
  assert.equal(await store.pendingCount(), 2);
  await assert.rejects(store.saveTimedLog('log-00002', log), /Pause o cronômetro/);
  assert.equal((await store.listLogs()).length, 1);
});

test('version 3 to 4 migration rolls back fully on failure and retries', async t => {
  const db = adapter(); t.after(() => db.raw.close());
  const store = new SyncStore(db.api); await store.initialize();
  await store.save('book', 'book-0001', book);
  db.raw.exec('DROP TABLE google_catalog; DROP TABLE book_catalog; DROP TABLE reading_timer; PRAGMA user_version=3;');
  db.api.fail = sql => sql.includes('PRAGMA user_version=4');
  await assert.rejects(store.initialize(), /Injected/);
  assert.equal(db.raw.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(db.raw.prepare("SELECT name FROM sqlite_master WHERE name='reading_timer'").get(), undefined);
  db.api.fail = null;
  await store.initialize(); await store.initialize();
  assert.equal(db.raw.prepare('PRAGMA user_version').get().user_version, 8);
  assert.equal((await store.listBooks())[0].title, 'Livro');
});

test('elapsed time clamps a clock moved backwards and rounds seconds up for a log', () => {
  const active = { started_at: start, resumed_at: start, elapsed_ms: 15000 };
  assert.equal(timerElapsedMs(active, new Date('2026-09-22T11:00:00.000Z')), 15000);
  assert.equal(timerLogMinutes(active, new Date(start)), 1);
  assert.equal(timerLogMinutes({ ...active, elapsed_ms: 0 }, new Date(start)), 0);
  assert.equal(timerClock(active, new Date('2026-09-22T12:00:45.000Z')), '00:01:00');
});
