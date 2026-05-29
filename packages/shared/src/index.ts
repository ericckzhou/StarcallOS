import type {
  Source,
  Concept,
  ConceptNote,
  PdfAnnotation,
  PdfAnnotationProvenance,
  PdfAnnotationRect,
  PdfAnnotationScope,
  PdfAnnotationType,
  EvidenceTask,
  EvidenceRecord,
  Mastery,
  Misconception,
  StoredConceptCandidate,
  StoredRelationCandidate,
  StoredMisconceptionCandidate,
  StoredEquationCandidate,
} from '@starcall/services';

export type {
  ConceptNote,
  PdfAnnotation,
  PdfAnnotationProvenance,
  PdfAnnotationRect,
  PdfAnnotationScope,
  PdfAnnotationType,
};

export const IPC = {
  SOURCES_LIST:            'sources:list',
  SOURCES_CREATE:          'sources:create',
  SOURCES_PROCESS:         'sources:process',
  CONCEPTS_BY_SOURCE:      'concepts:bySource',
  CONCEPTS_CREATE_MANUAL:  'concepts:createManual',
  CONCEPTS_TASKS:          'concepts:tasks',
  CONCEPTS_MASTERY:        'concepts:mastery',
  CONCEPTS_MISCONCEPTIONS: 'concepts:misconceptions',
  CONCEPTS_EQUATIONS:      'concepts:equations',
  CONCEPTS_EQUATION_CREATE: 'concepts:equationCreate',
  CONCEPTS_EQUATION_UPDATE: 'concepts:equationUpdate',
  CONCEPTS_EQUATION_DELETE: 'concepts:equationDelete',
  CONCEPTS_ENSURE_TASKS:   'concepts:ensureTasks',
  CONCEPTS_REGENERATE_TASKS: 'concepts:regenerateTasks',
  CONCEPTS_ENRICH:         'concepts:enrich',
  CONCEPTS_UPDATE_FIELDS:  'concepts:updateFields',
  CONCEPTS_SEARCH_BY_PREFIX: 'concepts:searchByPrefix',
  CONCEPTS_GRAPH:            'concepts:graph',
  CONCEPTS_GET:             'concepts:get',
  CONCEPTS_RENAME:           'concepts:rename',
  CONCEPTS_DELETE:         'concepts:delete',
  CONCEPTS_SET_REVIEWED:   'concepts:setReviewed',
  CONCEPTS_DELETE_EVIDENCE_SPAN: 'concepts:deleteEvidenceSpan',
  CONCEPTS_ADD_EVIDENCE:    'concepts:addEvidence',
  CONCEPTS_UPDATE_EVIDENCE: 'concepts:updateEvidence',
  CONCEPTS_DELETE_EVIDENCE: 'concepts:deleteEvidence',
  CONCEPT_NOTES_LIST:     'conceptNotes:list',
  CONCEPT_NOTES_CREATE:   'conceptNotes:create',
  CONCEPT_NOTES_UPDATE:   'conceptNotes:update',
  CONCEPT_NOTES_DELETE:   'conceptNotes:delete',
  CONCEPT_NOTES_REORDER:  'conceptNotes:reorder',
  HUBS_LIST:               'hubs:list',
  HUBS_CREATE:             'hubs:create',
  HUBS_UPDATE:             'hubs:update',
  HUBS_DELETE:             'hubs:delete',
  HUBS_ADD_MEMBERS:        'hubs:addMembers',
  HUBS_REMOVE_MEMBER:      'hubs:removeMember',
  HUBS_MEMBERSHIPS:        'hubs:memberships',
  REVIEW_QUEUE_LIST:       'review:queueList',
  SETTINGS_GET:            'settings:get',
  SETTINGS_SET:            'settings:set',
  SOURCES_BYTES:           'sources:bytes',
  SOURCES_LLM_FILTER_GET:  'sources:llmFilterGet',
  SOURCES_LLM_FILTER_SET:  'sources:llmFilterSet',
  PDF_ANNOTATIONS_LIST:    'pdfAnnotations:list',
  PDF_ANNOTATIONS_CREATE:  'pdfAnnotations:create',
  PDF_ANNOTATIONS_UPDATE:  'pdfAnnotations:update',
  PDF_ANNOTATIONS_DELETE:  'pdfAnnotations:delete',
  PDF_ANNOTATIONS_RESTORE: 'pdfAnnotations:restore',
  CONCEPTS_SOURCE_EVIDENCE: 'concepts:sourceEvidence',
  EVIDENCE_SUBMIT:         'evidence:submit',
  EVIDENCE_HISTORY:        'evidence:history',
  EVIDENCE_DELETE:         'evidence:delete',
  EVIDENCE_PROGRESS:       'evidence:progress',
  SOURCES_DELETE:          'sources:delete',
  SOURCES_CREATE_TEXT:     'sources:createText',
  CANDIDATES_BY_SOURCE:    'candidates:bySource',
  CANDIDATES_PROMOTE:      'candidates:promote',
  CANDIDATES_PROMOTE_BULK: 'candidates:promoteBulk',
  CANDIDATES_REJECT:       'candidates:reject',
  CANDIDATES_REJECT_BULK:  'candidates:rejectBulk',
  CANDIDATES_EXTRACT:      'candidates:extract',
  CANDIDATES_LLM_FILTER:   'candidates:llmFilter',
  CANDIDATES_RELATION_CREATE: 'candidates:relationCreate',
  CANDIDATES_RELATION_UPDATE: 'candidates:relationUpdate',
  CANDIDATES_RELATION_DELETE: 'candidates:relationDelete',
  CANDIDATES_MISCONCEPTION_CREATE: 'candidates:misconceptionCreate',
  CANDIDATES_MISCONCEPTION_UPDATE: 'candidates:misconceptionUpdate',
  CANDIDATES_MISCONCEPTION_DELETE: 'candidates:misconceptionDelete',
  CANDIDATES_EQUATION_CREATE: 'candidates:equationCreate',
  CANDIDATES_EQUATION_UPDATE: 'candidates:equationUpdate',
  CANDIDATES_EQUATION_DELETE: 'candidates:equationDelete',
  PARSE_RUNS_BY_SOURCE:    'parseRuns:bySource',
} as const;

export interface CandidatesBundle {
  concepts: StoredConceptCandidate[];
  relations: StoredRelationCandidate[];
  misconceptions: StoredMisconceptionCandidate[];
  equations: StoredEquationCandidate[];
}

export interface CreateSourceArgs {
  filePath?: string;
  filePaths?: string[];
  title?: string;
  author?: string;
}

export interface CreateTextSourceArgs {
  text: string;
  title?: string;
}

export interface ProcessSourceArgs {
  sourceId: number;
  pageStart?: number;
  pageEnd?: number;
}

export interface SubmitEvidenceArgs {
  taskId: number;
  conceptId: number;
  userResponse: string;
}

// ─── Auxiliary types used by IpcApi ──────────────────────────────────────────

export type ProviderId      = 'groq' | 'anthropic';
export type ExtractionMode  = 'deterministic' | 'candidate_gated' | 'full';
export type ParseRunStatus  = 'success' | 'failed' | 'interrupted';

export interface SettingsSnapshot {
  provider: ProviderId;
  groqApiKeyConfigured: boolean;
  anthropicApiKeyConfigured: boolean;
  modelOverrides: Record<string, string>;
  extractionMode: ExtractionMode;
  heavyModel: string;
  lightModel: string;
  modelChoices: Record<ProviderId, { heavy: string[]; light: string[] }>;
}

export interface SettingsPatch {
  provider?: ProviderId;
  groqApiKey?: string;
  anthropicApiKey?: string;
  modelOverrides?: Record<string, string>;
  extractionMode?: ExtractionMode;
  heavyModel?: string;
  lightModel?: string;
}

export interface ConceptSourceEvidence {
  sourceId: number;
  filePath: string;
  filename: string;
  pageCount: number | null;
  isPdf: boolean;
  evidence: Array<{ index: number; page: number; kind: string; label: string; quote?: string }>;
}

export interface CreatePdfAnnotationArgs {
  sourceId: number;
  conceptId?: number | null;
  scope?: PdfAnnotationScope;
  type: PdfAnnotationType;
  createdFrom: PdfAnnotationProvenance;
  page: number;
  color?: string;
  selectedText?: string;
  label?: string;
  noteBody?: string;
  rects: PdfAnnotationRect[];
  pageWidth?: number | null;
  pageHeight?: number | null;
  rotation?: number | null;
}

export interface UpdatePdfAnnotationArgs {
  id: number;
  label?: string;
  noteBody?: string;
  color?: string;
  rects?: PdfAnnotationRect[];
  pageWidth?: number | null;
  pageHeight?: number | null;
  rotation?: number | null;
}

// A constellation link: the linked concept name plus the user's reason for the
// link. Legacy data may still contain bare strings (no reason captured yet).
export interface ConstellationLink {
  name: string;
  reason: string;
}

export interface UpdateConceptFieldsArgs {
  conceptId: number;
  definition_text?: string;
  why_exists?: string;
  what_breaks?: string;
  where_reappears?: Array<string | ConstellationLink>;
  importance?: string;
  tags?: string[];
}

export interface EnrichedConcept {
  id: number;
  definition_text: string;
  why_exists: string;
  what_breaks: string;
  where_reappears: string[];
}

export interface PromoteBulkResult {
  promoted: number[];
  errors: Array<{ candidateId: number; error: string }>;
}

export interface ExtractCandidatesResult {
  ok: true;
  concepts: number;
  relations: number;
  misconceptions: number;
  equations: number;
  blocks: number;
}

export interface CandidateLlmFilterCandidate {
  id: number;
  normalized: string;
  term: string;
  mention_count: number;
  first_page: number;
  final_score?: number | null;
  confidence?: number;
  signals?: string[];
  labels?: string[];
  context_snippet?: string | null;
}

export interface CandidateLlmFilterArgs {
  sourceId: number;
  sourceTitle?: string;
  candidates: CandidateLlmFilterCandidate[];
}

export interface CandidateLlmFilterDecision {
  term: string;
  keep: boolean;
  reason?: string;
}

export interface CandidateLlmFilterResult {
  provider: ProviderId;
  model: string;
  sent: number;
  keepTerms: string[];
  decisions: CandidateLlmFilterDecision[];
  batches?: number;
  providers?: string[];
}

export interface ProcessSourceResult {
  ok: boolean;
  error?: string;
  warning?: string;
  mode?: ExtractionMode;
  blocks?: number;
  candidates?: number;
  relations?: number;
  equations?: number;
  misconceptions?: number;
  llmCalls?: number;
}

export interface ParseRunRecord {
  id: number;
  source_id: number;
  started_at: string;
  completed_at: string | null;
  status: ParseRunStatus;
  error_msg: string | null;
  mode: ExtractionMode;
  parser_version: string;
  grammar_version: string;
  layout_version: string;
  page_count: number;
  block_count: number;
  candidate_count: number;
  relation_count: number;
  equation_count: number;
  misconception_count: number;
  duration_ms: number;
  llm_call_count: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
  diagnostics: Record<string, unknown>;
}

export interface ReviewQueueItemPayload {
  concept: {
    id: number;
    name: string;
    importance: string;
    definition_text: string;
    section_path: string[];
  };
  source_id: number;
  source_title: string | null;
  source_filename: string;
  compression_stage: number;
  last_reviewed_at: string | null;
  attempts: number;
}

export interface LlmFilterSetArgs {
  sourceId: number;
  keepTerms: string[] | null;
}

export interface StarHub {
  id: number;
  name: string;
  description: string;
  color: string;
  type: string;
  importance: string;
  parent_hub_id: number | null;
  member_count: number;
  created_at: string;
  updated_at: string;
}
export interface HubMembership { hub_id: number; concept_id: number; }

export interface ConstellationGraphNode {
  id: number;
  name: string;
  slug: string;
  source_id: number;
  source_filename?: string;
  importance: string;
  mastery_stage: number;
  degree: number;
}

export interface ConstellationGraphEdge {
  a: number;
  b: number;
  kind: 'constellation' | 'relation';
  label?: string;
  // true = one-way (a → b); false = mutual / bidirectional (a ↔ b).
  directed?: boolean;
}

export interface ConstellationGraph {
  nodes: ConstellationGraphNode[];
  edges: ConstellationGraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    danglingConstellations: number;
    unresolvedRelations: number;
    duplicateEdges: number;
    capped: boolean;
  };
  // Build-time data-health diagnostics attributed to each source, keyed by
  // source_id, so the Map footer can scope dangling/unresolved/dupes to the
  // currently selected source.
  statsBySource: Record<number, {
    danglingConstellations: number;
    unresolvedRelations: number;
    duplicateEdges: number;
  }>;
}

export interface SourceChallengeCount {
  source_id: number;
  source_title: string;
  count: number;
}

export interface DailyActivity {
  date: string; // YYYY-MM-DD
  count: number;
  sources: { source_title: string; count: number }[];
}

export interface StudyProgress {
  total_xp: number;
  level: number;
  current_level_xp: number;
  next_level_xp: number;
  progress_ratio: number;
  challenges_completed: number;
  difficulty_counts: Record<1 | 2 | 3 | 4 | 5, number>;
  source_counts: SourceChallengeCount[];
  daily_activity: DailyActivity[];
}

// ─── The renderer-facing API contract ────────────────────────────────────────

export interface IpcApi {
  sources: {
    list: () => Promise<Source[]>;
    create: (args: CreateSourceArgs) => Promise<Source | Source[] | null>;
    process: (args: ProcessSourceArgs) => Promise<ProcessSourceResult>;
    delete: (sourceId: number) => Promise<void>;
    createText: (args: CreateTextSourceArgs) => Promise<Source | null>;
    bytes: (sourceId: number) => Promise<ArrayBuffer>;
    llmFilterGet: (sourceId: number) => Promise<string[] | null>;
    llmFilterSet: (args: LlmFilterSetArgs) => Promise<{ ok: true }>;
    annotations: {
      list: (sourceId: number) => Promise<PdfAnnotation[]>;
      create: (args: CreatePdfAnnotationArgs) => Promise<PdfAnnotation>;
      update: (args: UpdatePdfAnnotationArgs) => Promise<PdfAnnotation | null>;
      delete: (id: number) => Promise<PdfAnnotation | null>;
      restore: (id: number) => Promise<PdfAnnotation | null>;
    };
  };
  concepts: {
    bySource: (sourceId: number) => Promise<Concept[]>;
    createManual: (args: {
      sourceId: number;
      name: string;
      importance?: string;
      definition_text?: string;
      why_exists?: string;
      what_breaks?: string;
    }) => Promise<Concept>;
    tasks: (conceptId: number) => Promise<EvidenceTask[]>;
    mastery: (conceptId: number) => Promise<Mastery | null>;
    misconceptions: (conceptId: number) => Promise<Misconception[]>;
    equations: (conceptId: number) => Promise<StoredEquationCandidate[]>;
    equationCreate: (args: { conceptId: number; latex: string; page?: number; variables?: string[] }) => Promise<StoredEquationCandidate>;
    equationUpdate: (args: { equationId: number; latex: string; page?: number; variables?: string[] }) => Promise<StoredEquationCandidate>;
    equationDelete: (equationId: number) => Promise<{ ok: true }>;
    ensureTasks: (conceptId: number) => Promise<EvidenceTask[]>;
    regenerateTasks: (conceptId: number) => Promise<EvidenceTask[]>;
    enrich: (conceptId: number) => Promise<EnrichedConcept>;
    updateFields: (args: UpdateConceptFieldsArgs) => Promise<EnrichedConcept | null>;
    sourceEvidence: (conceptId: number) => Promise<ConceptSourceEvidence | null>;
    delete: (conceptId: number) => Promise<{ ok: true }>;
    setReviewed: (args: { conceptId: number; reviewed: boolean }) => Promise<{ ok: true }>;
    deleteEvidenceSpan: (args: { conceptId: number; page: number; kind: string; quote: string }) => Promise<ConceptSourceEvidence | null>;
    addEvidence: (args: { conceptId: number; page: number; kind: string; label: string; quote?: string }) => Promise<ConceptSourceEvidence | null>;
    updateEvidence: (args: { conceptId: number; index: number; page?: number; kind?: string; label?: string; quote?: string }) => Promise<ConceptSourceEvidence | null>;
    deleteEvidence: (args: { conceptId: number; index: number }) => Promise<ConceptSourceEvidence | null>;
    searchByPrefix: (args: { conceptId: number; prefix: string; limit?: number }) => Promise<Array<{ id: number; name: string; importance: string }>>;
    graph: () => Promise<ConstellationGraph>;
    get: (conceptId: number) => Promise<Concept | null>;
    rename: (args: { conceptId: number; name: string }) => Promise<Concept | null>;
    notes: {
      list:    (conceptId: number) => Promise<ConceptNote[]>;
      create:  (args: { conceptId: number; heading: string; body?: string }) => Promise<ConceptNote>;
      update:  (args: { id: number; heading?: string; body?: string; linkedAnnotationId?: number | null }) => Promise<ConceptNote | null>;
      delete:  (id: number) => Promise<{ ok: true }>;
      reorder: (args: { conceptId: number; orderedIds: number[] }) => Promise<ConceptNote[]>;
    };
  };
  hubs: {
    list: () => Promise<StarHub[]>;
    create: (args: { name: string; color?: string; description?: string; conceptIds?: number[] }) => Promise<StarHub>;
    update: (args: { id: number; name?: string; color?: string; description?: string }) => Promise<StarHub | null>;
    delete: (id: number) => Promise<{ ok: true }>;
    addMembers: (args: { hubId: number; conceptIds: number[] }) => Promise<{ ok: true }>;
    removeMember: (args: { hubId: number; conceptId: number }) => Promise<{ ok: true }>;
    memberships: () => Promise<HubMembership[]>;
  };
  evidence: {
    submit: (args: SubmitEvidenceArgs) => Promise<EvidenceRecord>;
    history: (conceptId: number) => Promise<EvidenceRecord[]>;
    delete: (recordId: number) => Promise<{ ok: true }>;
    progress: () => Promise<StudyProgress>;
  };
  settings: {
    get: () => Promise<SettingsSnapshot>;
    set: (input: SettingsPatch) => Promise<{ ok: true }>;
  };
  candidates: {
    bySource: (sourceId: number) => Promise<CandidatesBundle>;
    promote: (candidateId: number) => Promise<Concept>;
    promoteBulk: (candidateIds: number[]) => Promise<PromoteBulkResult>;
    reject: (candidateId: number) => Promise<{ ok: true }>;
    rejectBulk: (candidateIds: number[]) => Promise<{ rejected: number }>;
    extract: (sourceId: number) => Promise<ExtractCandidatesResult>;
    llmFilter: (args: CandidateLlmFilterArgs) => Promise<CandidateLlmFilterResult>;
    relationCreate: (args: { sourceId: number; from: string; to: string; kind: string; quote?: string; page?: number }) => Promise<StoredRelationCandidate>;
    relationUpdate: (args: { id: number; from: string; to: string; kind: string; quote?: string; page?: number }) => Promise<StoredRelationCandidate>;
    relationDelete: (id: number) => Promise<{ ok: true }>;
    misconceptionCreate: (args: { sourceId: number; quote: string; page?: number; section_path?: string[] }) => Promise<StoredMisconceptionCandidate>;
    misconceptionUpdate: (args: { id: number; quote: string; page?: number; section_path?: string[] }) => Promise<StoredMisconceptionCandidate>;
    misconceptionDelete: (id: number) => Promise<{ ok: true }>;
    equationCreate: (args: { sourceId: number; latex: string; page?: number; variables?: string[]; section_path?: string[]; attached_term?: string | null }) => Promise<StoredEquationCandidate>;
    equationUpdate: (args: { id: number; latex: string; page?: number; variables?: string[]; section_path?: string[]; attached_term?: string | null }) => Promise<StoredEquationCandidate>;
    equationDelete: (id: number) => Promise<{ ok: true }>;
  };
  review: {
    queue: (limit?: number) => Promise<ReviewQueueItemPayload[]>;
  };
  parseRuns: {
    bySource: (sourceId: number, limit?: number) => Promise<ParseRunRecord[]>;
  };
}
