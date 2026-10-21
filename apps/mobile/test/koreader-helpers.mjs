import { DatabaseSync } from 'node:sqlite';
import { SyncStore } from '../src/sync/store.ts';
export async function client(t) {
  const raw = new DatabaseSync(':memory:'); t.after(() => raw.close());
  const api = {
    async execAsync(sql) { raw.exec(sql); },
    async runAsync(sql, ...args) { return raw.prepare(sql).run(...args); },
    async getFirstAsync(sql, ...args) { return raw.prepare(sql).get(...args) ?? null; },
    async getAllAsync(sql, ...args) { return raw.prepare(sql).all(...args); },
  };
  const store = new SyncStore(api); await store.initialize(); await store.configure('https://books.example');
  return { raw, store };
}
