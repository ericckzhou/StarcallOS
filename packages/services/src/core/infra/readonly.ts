// Read-only access to the app database for out-of-process readers (the MCP
// server). Unlike `openDb`, this never runs migrations, never snapshots the
// file, and opens the SQLite handle with `readOnly: true`, so any write —
// including a WAL checkpoint — fails at the SQLite layer.
//
// WAL notes (verified on Windows against a live writer): a read-only reader
// sees each committed write, keeps snapshot isolation inside a transaction,
// and does not block the app's checkpoints. When the -wal/-shm sidecars are
// absent, SQLite creates empty ones on open; the main file is never modified.

import fs from 'fs';
import { DatabaseSync } from './sqlite';
import { MIGRATIONS_DIR } from './db';

export class SchemaMismatchError extends Error {}

export interface MigrationStatus {
  applied: number;
  // Migrations this code ships that the DB has not run (the app has not been
  // opened since an upgrade).
  missing: string[];
  // Migrations the DB has run that this code does not know (the DB was
  // upgraded by a newer app than this reader).
  unknown: string[];
}

export function openDbReadOnly(dbPath: string): DatabaseSync {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`StarcallOS database not found at ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // A reader can briefly hit SQLITE_BUSY while the app recovers or resets the
  // WAL; wait instead of failing the call.
  db.exec('PRAGMA busy_timeout = 2000');
  return db;
}

export function migrationStatus(db: DatabaseSync, migrationsDir = MIGRATIONS_DIR): MigrationStatus {
  const hasTable = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = '_migrations'`)
    .get();
  if (!hasTable) {
    throw new SchemaMismatchError('This file is not a StarcallOS database (no _migrations table).');
  }
  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map(r => r.name),
  );
  const shipped = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const shippedSet = new Set(shipped);
  return {
    applied: applied.size,
    missing: shipped.filter(f => !applied.has(f)),
    unknown: [...applied].filter(f => !shippedSet.has(f)).sort(),
  };
}

// Refuse to serve a schema this code was not written against. The app owns
// migrations; a reader must never apply them.
export function assertSchemaCurrent(db: DatabaseSync, migrationsDir = MIGRATIONS_DIR): MigrationStatus {
  const s = migrationStatus(db, migrationsDir);
  if (s.missing.length > 0) {
    throw new SchemaMismatchError(
      `The StarcallOS database is ${s.missing.length} migration(s) behind this code ` +
      `(next: ${s.missing[0]}). Open StarcallOS once so it can upgrade the database, then retry.`,
    );
  }
  if (s.unknown.length > 0) {
    throw new SchemaMismatchError(
      `The StarcallOS database was upgraded by a newer version (${s.unknown[s.unknown.length - 1]}). ` +
      `Update this checkout before reading it.`,
    );
  }
  return s;
}
