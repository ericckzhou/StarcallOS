// Bulk "re-extract outdated sources": re-run deterministic candidate
// extraction for every processed source whose candidates were produced by an
// older parser, grammar or layout version.
//
// A source is OUTDATED when it has candidates and its most recent successful
// parse run is stamped with a different PARSER/GRAMMAR/LAYOUT version than the
// current build, or when it has candidates but no parse run at all (extracted
// before parse runs existed, so its versions are unknown). Sources never
// processed are not outdated: extracting them is a separate, explicit action.
//
// Re-extract already preserves promoted concepts with evidence and concepts
// with study history, so this job is safe to run on a whole library. Like the
// passage index it is user-started only, Stop-able, and resumable without a
// job table: every finished source records a parse run with the current
// versions, so it drops out of the next plan.

import type { DatabaseSync } from '../core/infra/sqlite';
import { GRAMMAR_VERSION, LAYOUT_VERSION, PARSER_VERSION } from '../core/version';

export interface ReextractVersions { parser: string; grammar: string; layout: string }

export interface OutdatedSource {
  source_id: number;
  title: string;
  page_count: number | null;
  // Versions of the latest successful parse run; null = no parse run recorded.
  versions: ReextractVersions | null;
  reasons: Array<'parser' | 'grammar' | 'layout' | 'unknown'>;
}

export interface ReextractPlan {
  items: OutdatedSource[];     // in run order (smallest first)
  processed_sources: number;   // sources with candidates
  outdated: number;
  current: ReextractVersions;
  done: boolean;
}

export function currentReextractVersions(): ReextractVersions {
  return { parser: PARSER_VERSION, grammar: GRAMMAR_VERSION, layout: LAYOUT_VERSION };
}

// Expected layout stamp for one source. The layout version depends on which
// PDF parser is configured (built-in vs Docling) and on the source kind (text
// sources always use the built-in segmenter), so the caller can supply it per
// source; by default every source expects `current.layout`.
export type ExpectLayout = (source: { source_id: number; file_path: string }) => string;

export function planOutdatedSources(
  db: DatabaseSync,
  current: ReextractVersions = currentReextractVersions(),
  expectLayout?: ExpectLayout,
): ReextractPlan {
  const rows = db.prepare(
    `SELECT s.id AS id, COALESCE(s.title, s.filename) AS title, s.page_count AS page_count, s.file_path AS file_path,
            r.parser_version AS parser_version, r.grammar_version AS grammar_version, r.layout_version AS layout_version
       FROM sources s
       LEFT JOIN parse_runs r ON r.id = (
         SELECT r2.id FROM parse_runs r2
          WHERE r2.source_id = s.id AND r2.status = 'success'
          ORDER BY r2.id DESC LIMIT 1)
      WHERE EXISTS (SELECT 1 FROM concept_candidates c WHERE c.source_id = s.id)`,
  ).all() as Array<{
    id: number; title: string; page_count: number | null; file_path: string;
    parser_version: string | null; grammar_version: string | null; layout_version: string | null;
  }>;

  const items: OutdatedSource[] = [];
  for (const r of rows) {
    const versions = r.parser_version == null ? null : {
      parser: r.parser_version, grammar: r.grammar_version ?? '', layout: r.layout_version ?? '',
    };
    const reasons: OutdatedSource['reasons'] = [];
    if (!versions) reasons.push('unknown');
    else {
      if (versions.parser !== current.parser) reasons.push('parser');
      if (versions.grammar !== current.grammar) reasons.push('grammar');
      const layout = expectLayout ? expectLayout({ source_id: Number(r.id), file_path: r.file_path }) : current.layout;
      if (versions.layout !== layout) reasons.push('layout');
    }
    if (reasons.length) {
      items.push({
        source_id: Number(r.id), title: r.title ?? '', page_count: r.page_count == null ? null : Number(r.page_count),
        versions, reasons,
      });
    }
  }
  items.sort((a, b) =>
    (a.page_count ?? Number.MAX_SAFE_INTEGER) - (b.page_count ?? Number.MAX_SAFE_INTEGER) || a.source_id - b.source_id);
  return { items, processed_sources: rows.length, outdated: items.length, current, done: items.length === 0 };
}

export interface ReextractProgress {
  sourceId: number;
  title: string;
  sourceIndex: number;   // 1-based position in the run
  sourceCount: number;
}

export interface ReextractFailure { source_id: number; title: string; error: string }

export interface ReextractSummary {
  stopped: boolean;
  reextracted: number;
  failures: ReextractFailure[];
}

export interface ReextractDeps {
  // Re-extract one source's candidates (and record a parse run with the
  // current versions). Throws with a user-facing message on failure.
  reextract: (sourceId: number) => Promise<void>;
  // Serialize with other per-source work (passage index, Ask, single Re-extract).
  withSourceLock?: <T>(sourceId: number, fn: () => Promise<T>) => Promise<T>;
  onProgress?: (p: ReextractProgress) => void;
  shouldStop?: () => boolean;
  expectLayout?: ExpectLayout;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Sequential: one source at a time keeps memory bounded and leaves the app
// responsive. A failed source is reported and skipped; Stop takes effect
// between sources (a source in progress always finishes or fails whole).
export async function runReextractOutdated(db: DatabaseSync, deps: ReextractDeps): Promise<ReextractSummary> {
  const plan = planOutdatedSources(db, currentReextractVersions(), deps.expectLayout);
  const lock = deps.withSourceLock ?? (<T>(_id: number, fn: () => Promise<T>) => fn());
  const summary: ReextractSummary = { stopped: false, reextracted: 0, failures: [] };
  for (let i = 0; i < plan.items.length; i++) {
    if (deps.shouldStop?.()) { summary.stopped = true; break; }
    const item = plan.items[i];
    deps.onProgress?.({ sourceId: item.source_id, title: item.title, sourceIndex: i + 1, sourceCount: plan.items.length });
    try {
      await lock(item.source_id, () => deps.reextract(item.source_id));
      summary.reextracted++;
    } catch (e) {
      summary.failures.push({ source_id: item.source_id, title: item.title, error: msg(e) });
    }
  }
  return summary;
}
