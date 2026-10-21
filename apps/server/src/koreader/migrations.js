export function migrateKOReader(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS koreader_schema(version INTEGER PRIMARY KEY)');
    const version = db.prepare('SELECT MAX(version) AS version FROM koreader_schema').get().version ?? 0;
    if (version > 1) throw new Error('Banco KOReader de uma versão mais recente');
    if (version === 0) {
      db.exec(`CREATE TABLE koreader_config(id INTEGER PRIMARY KEY CHECK(id=1), time_zone TEXT NOT NULL)`);
      db.exec(`CREATE TABLE koreader_generations(device_id TEXT NOT NULL, generation_id TEXT NOT NULL,
        activation_unix INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(device_id,generation_id))`);
      db.exec(`CREATE TABLE koreader_documents(id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
        generation_id TEXT NOT NULL, checksum TEXT NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL,
        book_id TEXT REFERENCES books(id), association_version INTEGER NOT NULL DEFAULT 0, error_code TEXT, error_message TEXT,
        UNIQUE(device_id,generation_id,checksum), FOREIGN KEY(device_id,generation_id) REFERENCES koreader_generations(device_id,generation_id))`);
      db.exec(`CREATE TABLE koreader_events(event_key TEXT PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES koreader_documents(id),
        native_book_id INTEGER NOT NULL, page INTEGER NOT NULL, start_time INTEGER NOT NULL, duration_seconds INTEGER NOT NULL,
        total_pages INTEGER NOT NULL, day TEXT NOT NULL, content_json TEXT NOT NULL, projection_eligible INTEGER NOT NULL CHECK(projection_eligible IN(0,1)))`);
      db.exec(`CREATE TABLE koreader_progress(document_id INTEGER NOT NULL REFERENCES koreader_documents(id), sequence INTEGER NOT NULL,
        captured_at TEXT NOT NULL, percent REAL NOT NULL, day TEXT NOT NULL, content_json TEXT NOT NULL, PRIMARY KEY(document_id,sequence))`);
      db.exec(`CREATE TABLE koreader_batches(device_id TEXT NOT NULL, generation_id TEXT NOT NULL, batch_id TEXT NOT NULL,
        canonical_json TEXT NOT NULL, response_json TEXT NOT NULL, received_at TEXT NOT NULL,
        PRIMARY KEY(device_id,generation_id,batch_id), FOREIGN KEY(device_id,generation_id) REFERENCES koreader_generations(device_id,generation_id))`);
      db.exec(`CREATE TABLE koreader_projections(document_id INTEGER NOT NULL REFERENCES koreader_documents(id), day TEXT NOT NULL,
        log_id TEXT NOT NULL UNIQUE REFERENCES reading_logs(id), total_seconds INTEGER NOT NULL, PRIMARY KEY(document_id,day))`);
      db.exec('CREATE INDEX koreader_events_day ON koreader_events(document_id,day); CREATE INDEX koreader_progress_day ON koreader_progress(document_id,day,captured_at,sequence); INSERT INTO koreader_schema VALUES(1)');
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
