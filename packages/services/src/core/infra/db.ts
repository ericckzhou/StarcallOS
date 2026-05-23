import { DatabaseSync } from './sqlite';
import type { DatabaseSync as DB } from './sqlite';
import path from 'path';
import { runMigrations } from './migrate';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');

export function openDb(dbPath = ':memory:'): DB {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}
