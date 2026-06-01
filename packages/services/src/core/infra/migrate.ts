import type { DatabaseSync } from './sqlite';
import fs from 'fs';
import path from 'path';

// Apply pending .sql migrations in filename order. Each file runs inside its own
// transaction so a mid-file failure rolls back cleanly instead of leaving the
// DB half-migrated: previously a bare `db.exec(sql)` autocommitted each statement
// and only recorded the file as applied afterwards, so a failure on statement N
// committed statements 1..N-1 but never marked the file done — the next launch
// re-ran it from the top and died on "table already exists", bricking an
// irreplaceable local DB.
//
// `onBeforeApply` is called once, only when there is at least one pending
// migration, before any are applied — the caller uses it to snapshot the DB
// file. It is not called for an already-up-to-date DB. Returns the list of
// migration filenames that were applied this run.
export function runMigrations(
  db: DatabaseSync,
  migrationsDir: string,
  onBeforeApply?: (pending: string[]) => void,
): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      name   TEXT    NOT NULL UNIQUE,
      run_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map(r => r.name)
  );

  const pending = fs.readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith('.sql'))
    .sort()
    .filter((f: string) => !applied.has(f));

  if (pending.length === 0) return [];

  if (onBeforeApply) onBeforeApply(pending);

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(
        `Migration ${file} failed and was rolled back; DB left at the previous ` +
        `migration. Cause: ${(err as Error).message}`,
      );
    }
  }

  return pending;
}
