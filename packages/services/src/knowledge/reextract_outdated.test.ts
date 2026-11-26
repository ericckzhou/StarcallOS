import { describe, expect, it } from 'vitest';
import { openDb } from '../core/infra/db';
import { createSource } from './repos/sources';
import { createParseRun } from './repos/parse_runs';
import { currentReextractVersions, planOutdatedSources, runReextractOutdated } from './reextract_outdated';

type Db = ReturnType<typeof openDb>;

function addCandidate(db: Db, sourceId: number) {
  db.prepare(`INSERT INTO concept_candidates (source_id, term, normalized, confidence) VALUES (?, 'Term', 'term', 0.5)`).run(sourceId);
}
function addRun(db: Db, sourceId: number, v: { parser: string; grammar: string; layout: string }, status = 'success') {
  db.prepare(
    `INSERT INTO parse_runs (source_id, status, mode, parser_version, grammar_version, layout_version, contract_version)
     VALUES (?, ?, 'deterministic', ?, ?, ?, '1.0.0')`,
  ).run(sourceId, status, v.parser, v.grammar, v.layout);
}
function recordCurrentRun(db: Db, sourceId: number) {
  createParseRun(db, {
    source_id: sourceId, status: 'success', mode: 'deterministic', page_count: 1, block_count: 1,
    candidate_count: 1, relation_count: 0, equation_count: 0, misconception_count: 0, duration_ms: 1,
    llm_call_count: 0, llm_input_tokens: 0, llm_output_tokens: 0, diagnostics: {},
  });
}

const cur = currentReextractVersions();
const old = { ...cur, layout: '0.0.1' };

// current · old layout · no run (legacy) · never processed · old run superseded by a current one · current run but latest FAILED old
function seed() {
  const db = openDb(':memory:');
  const mk = (name: string, pages: number) => {
    const s = createSource(db, { filename: `${name}.pdf`, file_path: `${name}.pdf`, title: name });
    db.prepare('UPDATE sources SET page_count = ? WHERE id = ?').run(pages, s.id);
    return s.id;
  };
  const ids = {
    current: mk('current', 10), stale: mk('stale', 300), legacy: mk('legacy', 50),
    unprocessed: mk('unprocessed', 5), superseded: mk('superseded', 20), failedLatest: mk('failedLatest', 30),
  };
  for (const id of [ids.current, ids.stale, ids.legacy, ids.superseded, ids.failedLatest]) addCandidate(db, id);
  recordCurrentRun(db, ids.current);
  addRun(db, ids.stale, old);
  addRun(db, ids.superseded, old);
  recordCurrentRun(db, ids.superseded);
  recordCurrentRun(db, ids.failedLatest);
  addRun(db, ids.failedLatest, old, 'failed');
  return { db, ids };
}

describe('planOutdatedSources', () => {
  it('flags processed sources whose latest successful run is old or unknown, smallest first', () => {
    const { db, ids } = seed();
    const plan = planOutdatedSources(db);
    expect(plan.processed_sources).toBe(5);
    expect(plan.items.map(i => i.source_id)).toEqual([ids.legacy, ids.stale]);
    expect(plan.items.find(i => i.source_id === ids.stale)?.reasons).toEqual(['layout']);
    expect(plan.items.find(i => i.source_id === ids.legacy)).toMatchObject({ versions: null, reasons: ['unknown'] });
    expect(plan.done).toBe(false);
  });

  it('compares against the per-source expected layout', () => {
    const { db, ids } = seed();
    // Docling selected for PDFs: every built-in-stamped PDF is outdated by layout.
    const plan = planOutdatedSources(db, cur, s => (s.file_path.endsWith('.pdf') ? 'docling-0.1.0' : cur.layout));
    expect(plan.items.find(i => i.source_id === ids.current)?.reasons).toEqual(['layout']);
    expect(plan.outdated).toBe(5);
  });

  it('reports every differing version', () => {
    const { db } = seed();
    const plan = planOutdatedSources(db, { parser: 'x', grammar: 'y', layout: cur.layout });
    expect(plan.items.every(i => i.reasons.includes('parser') || i.reasons.includes('unknown'))).toBe(true);
    expect(plan.outdated).toBe(5);
  });
});

describe('runReextractOutdated', () => {
  it('re-extracts outdated sources, skips failures, and a re-run finds nothing', async () => {
    const { db, ids } = seed();
    const calls: number[] = [];
    const progress: number[] = [];
    const s = await runReextractOutdated(db, {
      reextract: async (id) => {
        calls.push(id);
        if (id === ids.legacy) throw new Error('The source file no longer exists.');
        recordCurrentRun(db, id);
      },
      onProgress: p => progress.push(p.sourceIndex),
    });
    expect(calls).toEqual([ids.legacy, ids.stale]);
    expect(progress).toEqual([1, 2]);
    expect(s).toEqual({
      stopped: false, reextracted: 1,
      failures: [{ source_id: ids.legacy, title: 'legacy', error: 'The source file no longer exists.' }],
    });
    // Only the failed source remains outdated.
    expect(planOutdatedSources(db).items.map(i => i.source_id)).toEqual([ids.legacy]);
  });

  it('stops between sources and runs each under the source lock', async () => {
    const { db } = seed();
    const locked: number[] = [];
    let n = 0;
    const s = await runReextractOutdated(db, {
      reextract: async (id) => { recordCurrentRun(db, id); },
      withSourceLock: async (id, fn) => { locked.push(id); return fn(); },
      shouldStop: () => n++ >= 1,
    });
    expect(s.stopped).toBe(true);
    expect(s.reextracted).toBe(1);
    expect(locked).toHaveLength(1);
    expect(planOutdatedSources(db).outdated).toBe(1);   // resumable: the rest is still planned
  });
});
