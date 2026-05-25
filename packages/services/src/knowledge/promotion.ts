// Pure-DB promotion: candidate row → first-class concept row.
// No LLM call. Promotion means "this evidence-backed candidate is accepted
// as a concept I want to learn." LLM-derived fields stay empty and can be
// filled later by an on-demand enrichment pass.

import type { DatabaseSync } from '../core/infra/sqlite';
import type { Concept, ConceptImportance } from '../core/domain/types';
import { createConcept, getConceptBySlug } from './repos/concepts';
import {
  getConceptCandidateById,
  deleteConceptCandidate,
} from './repos/candidates';
import { upsertMastery } from './repos/evidence';
import { emitEvent } from '../core/events';

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function importanceFromConfidence(confidence: number): ConceptImportance {
  if (confidence >= 0.9) return 'core';
  if (confidence >= 0.55) return 'supporting';
  return 'peripheral';
}

export function promoteCandidate(db: DatabaseSync, candidateId: number): Concept {
  const cand = getConceptCandidateById(db, candidateId);
  if (!cand) throw new Error(`candidate ${candidateId} not found`);

  const slug = slugify(cand.term) || `candidate-${candidateId}`;
  const existing = getConceptBySlug(db, cand.source_id, slug);
  if (existing) {
    // Already promoted (or LLM extractor produced a matching slug) — just
    // drop the candidate row so the user sees it disappear from the queue.
    deleteConceptCandidate(db, candidateId);
    return existing;
  }

  // Seed definition_text with the strongest evidence quote we have.
  //   - Skip 'repetition' / 'capitalized_phrase' — those signals carry synthetic
  //     count labels (e.g., "appears 107×"), not real prose.
  //   - Skip tautological quotes (just the term repeated — heading evidence
  //     usually is).
  // If nothing real survives, leave the field empty so the UI shows the
  // empty-state hint instead of misleading text.
  const termNorm = cand.term.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
  const isTautology = (q: string): boolean => {
    const qn = q.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
    return qn === termNorm || qn.length < termNorm.length + 6;
  };
  const SYNTHETIC_SOURCES = new Set(['repetition', 'capitalized_phrase']);
  const realProse = cand.evidence.filter(e => !SYNTHETIC_SOURCES.has(e.source) && !isTautology(e.quote));
  const definitionQuote = realProse.find(e => e.source === 'definition_pattern')?.quote;
  const defQuote = (definitionQuote ?? realProse[0]?.quote) ?? '';

  const concept = createConcept(db, {
    source_id: cand.source_id,
    name: cand.term,
    slug,
    importance: importanceFromConfidence(cand.confidence),
    definition_text: defQuote,
    why_exists: '',
    what_breaks: '',
    where_reappears: [],
    chunk_ids: [],
    section_path: cand.section_path,
    exam_value: Math.round(cand.confidence * 100),
    misconception_risk: 0,
    centrality_score: 0,
  });

  // Preserve the candidate's evidence quotes on the new concept row so the
  // Source viewer can show real page references (not just first_page).
  db.prepare('UPDATE concepts SET evidence_json = ? WHERE id = ?')
    .run(JSON.stringify(cand.evidence), concept.id);

  upsertMastery(db, concept.id, 0);
  emitEvent(
    db,
    'concept.promoted_from_candidate',
    { conceptId: concept.id, candidateId, confidence: cand.confidence },
    { entityType: 'concept', entityId: concept.id },
  );

  // Candidate is now superseded by the real concept row.
  deleteConceptCandidate(db, candidateId);
  return concept;
}

export function rejectCandidate(db: DatabaseSync, candidateId: number): void {
  const cand = getConceptCandidateById(db, candidateId);
  if (!cand) return;
  emitEvent(
    db,
    'concept_candidate.rejected',
    { candidateId, term: cand.term },
    { entityType: 'source', entityId: cand.source_id },
  );
  deleteConceptCandidate(db, candidateId);
}
