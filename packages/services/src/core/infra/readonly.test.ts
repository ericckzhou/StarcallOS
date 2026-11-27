import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MIGRATIONS_DIR, openDb } from './db';
import { SchemaMismatchError, assertSchemaCurrent, migrationStatus, openDbReadOnly } from './readonly';
import { createSource, listSources } from '../../knowledge/repos/sources';
import { createConcept, listConceptSourceEvidence } from '../../knowledge/repos/concepts';
import { createChunk } from '../../knowledge/repos/evidence';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starcall-ro-'));
  dbPath = path.join(dir, 'stellaria.db');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeMigrationsDir(names: string[]): string {
  const d = fs.mkdtempSync(path.join(dir, 'mig-'));
  for (const n of names) fs.writeFileSync(path.join(d, n), '-- test');
  return d;
}

describe('openDbReadOnly', () => {
  it('reads data written by the app and rejects every write', () => {
    const w = openDb(dbPath);
    createSource(w, { filename: 'a.pdf', file_path: 'a.pdf', title: 'A' });
    w.close();

    const before = fs.readFileSync(dbPath);
    const db = openDbReadOnly(dbPath);
    try {
      expect(listSources(db).map(s => s.title)).toEqual(['A']);
      expect(() => createSource(db, { filename: 'b.pdf', file_path: 'b.pdf', title: 'B' })).toThrow(/readonly/i);
      expect(() => db.exec('CREATE TABLE t (x)')).toThrow(/readonly/i);
    } finally {
      db.close();
    }
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });

  it('sees commits made by a writer while it stays open (WAL)', () => {
    const w = openDb(dbPath);
    const db = openDbReadOnly(dbPath);
    expect(listSources(db)).toHaveLength(0);
    createSource(w, { filename: 'a.pdf', file_path: 'a.pdf', title: 'A' });
    expect(listSources(db)).toHaveLength(1);
    db.close();
    w.close();
  });

  it('refuses a missing file instead of creating one', () => {
    expect(() => openDbReadOnly(dbPath)).toThrow(/not found/);
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});

describe('migration version check', () => {
  it('passes for a DB migrated by this code', () => {
    const w = openDb(dbPath);
    w.close();
    const db = openDbReadOnly(dbPath);
    const s = assertSchemaCurrent(db);
    expect(s.missing).toEqual([]);
    expect(s.unknown).toEqual([]);
    db.close();
  });

  it('reports a DB that is behind (app not opened since an upgrade)', () => {
    openDb(dbPath).close();
    const shipped = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));
    const ahead = fakeMigrationsDir([...shipped, '9999_future.sql']);
    const db = openDbReadOnly(dbPath);
    expect(migrationStatus(db, ahead).missing).toEqual(['9999_future.sql']);
    expect(() => assertSchemaCurrent(db, ahead)).toThrow(SchemaMismatchError);
    expect(() => assertSchemaCurrent(db, ahead)).toThrow(/Open StarcallOS once/);
    db.close();
  });

  it('reports a DB upgraded by a newer app', () => {
    openDb(dbPath).close();
    const shipped = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    const older = fakeMigrationsDir(shipped.slice(0, -1));
    const db = openDbReadOnly(dbPath);
    expect(migrationStatus(db, older).unknown).toEqual([shipped[shipped.length - 1]]);
    expect(() => assertSchemaCurrent(db, older)).toThrow(/newer version/);
    db.close();
  });

  it('rejects a file that is not a StarcallOS database', () => {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const other = new DatabaseSync(dbPath);
    other.exec('CREATE TABLE t (x)');
    other.close();
    const db = openDbReadOnly(dbPath);
    expect(() => assertSchemaCurrent(db)).toThrow(/not a StarcallOS database/);
    db.close();
  });
});

describe('listConceptSourceEvidence read-only path', () => {
  it('returns derived evidence without persisting it when persistSeed is false', () => {
    const w = openDb(dbPath);
    const src = createSource(w, { filename: 'a.pdf', file_path: 'a.pdf', title: 'A' });
    const chunk = createChunk(w, {
      source_id: src.id, content: 'Entropy measures uncertainty.', page_start: 4, page_end: 4,
      block_type: 'definition', section_path: [], claim: 'Entropy measures uncertainty.',
      assumptions: [], example_quote: 'Entropy measures uncertainty.',
    });
    const c = createConcept(w, {
      source_id: src.id, name: 'Entropy', slug: 'entropy', importance: 'core',
      definition_text: '', why_exists: '', what_breaks: '', where_reappears: [],
      chunk_ids: [chunk.id], section_path: [], exam_value: 0, misconception_risk: 0, centrality_score: 0,
    });
    w.close();

    const db = openDbReadOnly(dbPath);
    const ev = listConceptSourceEvidence(db, c.id, { persistSeed: false });
    expect(ev?.evidence.some(e => e.page === 4)).toBe(true);
    // The default (seeding) path would write, which a read-only handle refuses.
    expect(() => listConceptSourceEvidence(db, c.id)).toThrow(/readonly/i);
    const stored = db.prepare('SELECT evidence_json FROM concepts WHERE id = ?').get(c.id) as { evidence_json: string };
    expect(JSON.parse(stored.evidence_json || '[]')).toEqual([]);
    db.close();
  });
});
