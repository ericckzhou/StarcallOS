import { DatabaseSync } from './sqlite';
import type { DatabaseSync as DB } from './sqlite';
import fs from 'fs';
import path from 'path';
import { runMigrations } from './migrate';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');

// Snapshot the DB file before pending migrations run, so a failed/partial
// upgrade is recoverable. Best-effort: a backup failure must not block opening
// the app. Skipped for in-memory DBs (no file) and when the file doesn't exist
// yet (first launch — nothing to lose). WAL is checkpointed first so the copied
// main DB file is complete and not missing data still sitting in the -wal file.
function backupBeforeMigrate(db: DB, dbPath: string): void {
  if (dbPath === ':memory:' || !fs.existsSync(dbPath)) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(dbPath, `${dbPath}.${stamp}.pre-migrate.bak`);
  } catch {
    // Don't block startup on a backup failure; the migration itself is
    // transactional, so the DB is never left half-migrated regardless.
  }
}

export function openDb(dbPath = ':memory:'): DB {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, MIGRATIONS_DIR, () => backupBeforeMigrate(db, dbPath));
  return db;
}
