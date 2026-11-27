// The deterministic part of re-processing a source, shared by the two main-
// process entry points so their database behavior is one tested code path:
//
//   reprocessSourceDeterministic  - sources.process (the Re-extract button):
//                                   wipe derived data, then rebuild candidates
//                                   and retrieval chunks
//   reextractCandidatesForSource  - candidates:extract and the bulk "re-extract
//                                   outdated sources" job: rebuild candidates
//                                   and retrieval chunks without the wipe
//
// Segmentation stays in main (PDFs parse in a worker thread / Docling), so both
// functions take already-segmented blocks. Status updates, events, parse-run
// rows and the LLM extraction modes also stay in main.
//
// What a rebuild may and may not touch is decided by the repos:
// clearDerivedDataForSource (concept/candidate ownership) and
// persistCandidateExtraction (regenerates only parser-owned candidate rows,
// atomically, without duplicating preserved rows).

import type { DatabaseSync } from '../core/infra/sqlite';
import type { SectionNode } from '../core/domain/types';
import { CHUNKER_VERSION, LAYOUT_VERSION } from '../core/version';
import { deriveTopicAnchors } from '../core/topic';
import type { SegmentedBlock } from '../ingestion/layout';
import { buildSectionPath } from '../ingestion/enrichment';
import { extractCandidates, type CandidateExtractionResult } from '../ingestion/candidates';
import { chunkBlocks } from '../ingestion/chunker';
import { persistCandidateExtraction } from './repos/candidates';
import { setTopicAnchors } from './repos/sources';
import { syncSourceChunks } from './repos/rag_chunks';
import { clearDerivedDataForSource, type CleanupCounts } from './cleanup';

export interface SegmentedSource {
  blocks: SegmentedBlock[];
  runningHeaderSections: SectionNode[];
  layoutVersion?: string;
}

export interface CandidateRebuild {
  candidates: CandidateExtractionResult;
  anchors: string[];
}

// Section paths -> topic anchors (persisted) -> candidates (persisted).
export function extractAndPersistCandidates(
  db: DatabaseSync,
  sourceId: number,
  seg: SegmentedSource,
  title: string | null | undefined,
): CandidateRebuild {
  const { paths, sources } = buildSectionPath(seg.blocks, seg.runningHeaderSections);
  const anchors = deriveTopicAnchors(seg.blocks, title);
  setTopicAnchors(db, sourceId, anchors);
  const candidates = extractCandidates(seg.blocks, paths, anchors, sources, seg.runningHeaderSections);
  persistCandidateExtraction(db, sourceId, candidates);
  return { candidates, anchors };
}

// Reconcile the retrieval chunk index. Never throws: a chunking failure must
// not fail processing, so it is returned as diagnostics instead.
export function syncChunksForSource(db: DatabaseSync, sourceId: number, seg: SegmentedSource): Record<string, unknown> {
  try {
    const { chunks, diagnostics } = chunkBlocks(seg.blocks, seg.runningHeaderSections);
    const sync = syncSourceChunks(db, sourceId, chunks, { chunker: CHUNKER_VERSION, layout: seg.layoutVersion ?? LAYOUT_VERSION });
    return { ...diagnostics, sync };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export interface DeterministicReprocess {
  wiped: CleanupCounts;
  rebuild: CandidateRebuild | null;
  candidateError: string | null;
  chunks: Record<string, unknown>;
}

// sources.process: wipe what is disposable, then rebuild, as ONE unit: if the
// candidate rebuild fails, the wipe is rolled back too, so the source keeps its
// previous candidates and concepts instead of being left empty. The failure is
// reported, not thrown (processing goes on to chunks and, in LLM modes,
// enrichment), matching the pipeline's long-standing behavior.
export function reprocessSourceDeterministic(
  db: DatabaseSync,
  sourceId: number,
  seg: SegmentedSource,
  title: string | null | undefined,
): DeterministicReprocess {
  let wiped: CleanupCounts | null = null;
  let rebuild: CandidateRebuild | null = null;
  let candidateError: string | null = null;
  db.exec('SAVEPOINT reprocess_source');
  try {
    wiped = clearDerivedDataForSource(db, sourceId);
    rebuild = extractAndPersistCandidates(db, sourceId, seg, title);
    db.exec('RELEASE reprocess_source');
  } catch (e) {
    db.exec('ROLLBACK TO reprocess_source');
    db.exec('RELEASE reprocess_source');
    candidateError = e instanceof Error ? e.message : String(e);
    wiped = null;
    rebuild = null;
  }
  return { wiped: wiped ?? NOTHING_WIPED, rebuild, candidateError, chunks: syncChunksForSource(db, sourceId, seg) };
}

const NOTHING_WIPED: CleanupCounts = {
  concept_candidates: 0, relation_candidates: 0, equation_candidates: 0, misconception_candidates: 0,
  semantic_chunks: 0, prerequisite_suggestions: 0, concepts_deleted: 0, concepts_preserved: 0,
};

// candidates:extract / bulk re-extract: rebuild candidates and chunks only.
// Extraction errors propagate so the caller records a failed parse run.
export function reextractCandidatesForSource(
  db: DatabaseSync,
  sourceId: number,
  seg: SegmentedSource,
  title: string | null | undefined,
): CandidateRebuild & { chunks: Record<string, unknown> } {
  const rebuild = extractAndPersistCandidates(db, sourceId, seg, title);
  return { ...rebuild, chunks: syncChunksForSource(db, sourceId, seg) };
}
