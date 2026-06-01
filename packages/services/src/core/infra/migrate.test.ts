import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from './sqlite';
import { runMigrations } from './migrate';

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}
function appliedNames(db: DatabaseSync): string[] {
  return (db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]).map(r => r.name);
}

describe('runMigrations', () => {
  let dir: string;
  let db: DatabaseSync;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starcall-migrate-'));
    db = new DatabaseSync(':memory:');
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, sql: string) { fs.writeFileSync(path.join(dir, name), sql); }

  it('applies pending migrations in filename order and records them', () => {
    write('0001_a.sql', 'CREATE TABLE a (id INTEGER);');
    write('0002_b.sql', 'CREATE TABLE b (id INTEGER);');
    const applied = runMigrations(db, dir);
    expect(applied).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(appliedNames(db)).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('rolls back a failed migration entirely and does not record it', () => {
    // Second statement fails (duplicate table) — the first CREATE in the SAME
    // file must be rolled back, not left committed.
    write('0001_ok.sql', 'CREATE TABLE ok (id INTEGER);');
    write('0002_bad.sql', 'CREATE TABLE partial (id INTEGER);\nCREATE TABLE partial (id INTEGER);');

    expect(() => runMigrations(db, dir)).toThrow(/0002_bad\.sql failed and was rolled back/);

    expect(tableExists(db, 'ok')).toBe(true);        // good migration committed
    expect(tableExists(db, 'partial')).toBe(false);  // bad migration fully rolled back
    expect(appliedNames(db)).toEqual(['0001_ok.sql']); // bad file NOT recorded
  });

  it('re-runs only the unapplied migration after the failure is fixed', () => {
    write('0001_ok.sql', 'CREATE TABLE ok (id INTEGER);');
    write('0002_bad.sql', 'CREATE TABLE partial (id INTEGER);\nCREATE TABLE partial (id INTEGER);');
    expect(() => runMigrations(db, dir)).toThrow();

    // Operator fixes the migration; rerun applies only the previously-failed one.
    write('0002_bad.sql', 'CREATE TABLE partial (id INTEGER);');
    const applied = runMigrations(db, dir);
    expect(applied).toEqual(['0002_bad.sql']);
    expect(tableExists(db, 'partial')).toBe(true);
    expect(appliedNames(db)).toEqual(['0001_ok.sql', '0002_bad.sql']);
  });

  it('calls onBeforeApply once with the pending list, only when there is work', () => {
    write('0001_a.sql', 'CREATE TABLE a (id INTEGER);');
    const calls: string[][] = [];
    runMigrations(db, dir, (pending) => calls.push(pending));
    expect(calls).toEqual([['0001_a.sql']]);

    // Already up to date — hook must not fire again.
    runMigrations(db, dir, (pending) => calls.push(pending));
    expect(calls).toEqual([['0001_a.sql']]);
  });
});
