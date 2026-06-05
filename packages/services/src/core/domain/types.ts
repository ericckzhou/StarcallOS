// ─── Sources ──────────────────────────────────────────────────────────────────

export type SourceStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface Source {
  id: number;
  filename: string;
  title: string | null;
  author: string | null;
  file_path: string;
  page_count: number | null;
  status: SourceStatus;
  error_msg: string | null;
  origin_url: string | null;
  created_at: string;
}

// ─── Document structure ───────────────────────────────────────────────────────

export interface SectionNode {
  heading: string;
  level: 1 | 2 | 3 | 4; // 1=chapter 2=section 3=subsection 4=named-paragraph-group
  page_start: number;
  page_end: number;
}

// ─── Semantic Blocks ──────────────────────────────────────────────────────────

export type BlockType =
  | 'definition'
  | 'theorem'
  | 'mechanism'
  | 'example'
  | 'derivation'
  | 'claim'
  | 'evidence'
  | 'warning'
  | 'formula'
  | 'procedure'
  | 'comparison'
  | 'misconception_zone'
  | 'assumption'
  | 'transition';

export type ChunkType = BlockType; // backward-compat alias

export interface SemanticChunk {
  id: number;
  source_id: number;
  content: string;
  page_start: number;
  page_end: number;
  block_type: BlockType;
  section_path: string[];   // ["Chapter 3", "3.2 Gradient Descent"]
  claim: string | null;     // core assertion this block makes
  assumptions: string[];    // stated/implied prerequisites
  example_quote: string | null;
  created_at: string;
}

// ─── Concepts ─────────────────────────────────────────────────────────────────

export type ConceptImportance =
  | 'foundational'
  | 'core'
  | 'supporting'
  | 'peripheral'
  | 'reference_only';

export interface Concept {
  id: number;
  source_id: number;
  name: string;
  slug: string;
  importance: ConceptImportance;
  definition_text: string;
  why_exists: string;
  what_breaks: string;
  where_reappears: string[];
  tags: string[];               // user-authored free-text tags (header chips)
  chunk_ids: number[];
  section_path: string[];       // where first defined in the document
  exam_value: number;           // 0–1: likelihood of appearing in an assessment
  misconception_risk: number;   // 0–1: ease of misunderstanding
  centrality_score: number;     // 0–1: degree centrality in concept graph (Pass 6)
  created_at: string;
}

// ─── Concept Edges ────────────────────────────────────────────────────────────

export type EdgeType =
  | 'requires'
  | 'enables'
  | 'related'
  | 'contrasts_with'
  | 'example_of'
  | 'causes'
  | 'prevents';

export interface ConceptEdge {
  id: number;
  from_id: number;
  to_id: number;
  edge_type: EdgeType;
}

// ─── PDF Annotations ─────────────────────────────────────────────────────────

export type PdfAnnotationType = 'highlight' | 'note';
export type PdfAnnotationScope = 'source' | 'concept';
export type PdfAnnotationProvenance = 'manual_selection' | 'manual_note' | 'evidence_quote';

export interface PdfAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfAnnotation {
  id: number;
  source_id: number;
  concept_id: number | null;
  scope: PdfAnnotationScope;
  type: PdfAnnotationType;
  created_from: PdfAnnotationProvenance;
  page: number;
  color: string;
  selected_text: string;
  label: string;
  note_body: string;
  rects: PdfAnnotationRect[];
  page_width: number | null;
  page_height: number | null;
  rotation: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// ─── Misconceptions ───────────────────────────────────────────────────────────

export type MisconceptionStatus = 'unresolved' | 'resolved';

export interface Misconception {
  id: number;
  concept_id: number;
  description: string;
  why_think_it: string;
  why_wrong: string;
  test_prompt: string;
  seen_count: number;
  status: MisconceptionStatus;
  created_at: string;
}

// ─── Evidence Tasks ───────────────────────────────────────────────────────────

export type EvidenceKind =
  | 'definition'
  | 'connection'
  | 'application'
  | 'misconception_resistance'
  | 'compression';

export interface EvidenceTask {
  id: number;
  concept_id: number;
  kind: EvidenceKind;
  prompt: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  created_at: string;
}

// ─── Mastery ──────────────────────────────────────────────────────────────────

/** 0=unseen 1=memorized 2=explain 3=connect 4=compress 5=predict_failures */
export type CompressionStage = 0 | 1 | 2 | 3 | 4 | 5;

export const COMPRESSION_STAGE_LABELS: Record<CompressionStage, string> = {
  0: 'Unseen',
  1: 'Memorized definition',
  2: 'Can explain',
  3: 'Can connect',
  4: 'Can compress to first principles',
  5: 'Can predict failures',
};

export interface Mastery {
  concept_id: number;
  compression_stage: CompressionStage;
  last_updated: string;
}

// ─── Concept Notes (user-authored) ────────────────────────────────────────────

export interface ConceptNote {
  id: number;
  concept_id: number;
  position: number;
  heading: string;
  body: string;
  linked_annotation_id: number | null;
  created_at: string;
  updated_at: string;
}

// ─── Evidence Records ─────────────────────────────────────────────────────────

export type EvidenceScore = 'understood' | 'recognizes' | 'gap' | 'misconception';

// A claim the learner asserted that the concept's source context does not
// support — a possible hallucination or imported outside belief. Structured so
// the UI can show the claim, why it isn't supported, and a severity badge.
export interface UnsupportedClaim {
  claim: string;
  reason: string;
  severity: 'minor' | 'major';
}

export interface EvidenceRecord {
  id: number;
  task_id: number;
  concept_id: number;
  user_response: string;
  score: EvidenceScore;
  compression_stage: CompressionStage;
  gaps_detected: string[];
  misconceptions_detected: string[];
  grader_reasoning: string | null;
  created_at: string;
  // Denormalized at grade time so History survives task regeneration.
  task_prompt_snapshot: string | null;
  task_kind_snapshot:   string | null;
  task_difficulty_snapshot: 1 | 2 | 3 | 4 | 5 | null;
  xp_awarded: number;
  // Source-grounding signals (migration 0029). grounding_score is 0..1 or null
  // (null = not assessed: no source context was available — not "ungrounded").
  // grounding_context_used mirrors that gate explicitly. unsupported_claims is
  // empty when grounding was not assessed or the answer was fully supported.
  grounding_score: number | null;
  grounding_context_used: boolean;
  unsupported_claims: UnsupportedClaim[];
  // Confidence calibration (migration 0030). confidence_before is the learner's
  // pre-submit confidence 0..1 (null on legacy records). calibration_gap is
  // confidence_before - outcome (positive = overconfident); null exactly when
  // confidence_before is null.
  confidence_before: number | null;
  calibration_gap: number | null;
}
