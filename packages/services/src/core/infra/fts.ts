import type { DatabaseSync } from './sqlite';

// Runtime FTS5 capability check. The bundled SQLite of both runtimes that open
// the app DB was verified to include FTS5 (Node 22.16 / SQLite 3.49.1 for
// tests; Electron 42 / Node 24.16 / SQLite 3.53.0 for the app), and migration
// 0036 depends on it. This check exists so a future runtime upgrade that drops
// the module fails loudly in tests and startup logs instead of surfacing as an
// opaque "no such module: fts5" migration error.
export function hasFts5(db: DatabaseSync): boolean {
  try {
    const opts = db.prepare(`SELECT compile_options AS o FROM pragma_compile_options`).all() as Array<{ o: string }>;
    if (opts.some(r => r.o === 'ENABLE_FTS5')) return true;
    // Some builds register fts5 without advertising the compile option.
    db.exec(`CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(x)`);
    db.exec(`DROP TABLE temp.__fts5_probe`);
    return true;
  } catch {
    return false;
  }
}
