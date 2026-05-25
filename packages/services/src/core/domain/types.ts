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

// ─── Evidence Records ─────────────────────────────────────────────────────────

export type EvidenceScore = 'understood' | 'recognizes' | 'gap' | 'misconception';

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
}
