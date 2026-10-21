import { randomUUID } from 'node:crypto';

export function migrateIdentity(db) {
  db.exec('CREATE TABLE IF NOT EXISTS server_identity(id INTEGER PRIMARY KEY CHECK(id=1), server_id TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO server_identity(id, server_id) VALUES(1, ?)').run(randomUUID());
}

export function getServerId(db) {
  return db.prepare('SELECT server_id FROM server_identity WHERE id = 1').get().server_id;
}
