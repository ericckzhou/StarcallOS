import type {
  Source,
  Concept,
  EvidenceTask,
  EvidenceRecord,
  Mastery,
  Misconception,
  StoredConceptCandidate,
  StoredRelationCandidate,
  StoredMisconceptionCandidate,
  StoredEquationCandidate,
} from '@starcall/services';

export const IPC = {
  SOURCES_LIST:            'sources:list',
  SOURCES_CREATE:          'sources:create',
  SOURCES_PROCESS:         'sources:process',
  CONCEPTS_BY_SOURCE:      'concepts:bySource',
  CONCEPTS_TASKS:          'concepts:tasks',
  CONCEPTS_MASTERY:        'concepts:mastery',
  CONCEPTS_MISCONCEPTIONS: 'concepts:misconceptions',
  CONCEPTS_EQUATIONS:      'concepts:equations',
  CONCEPTS_ENSURE_TASKS:   'concepts:ensureTasks',
  CONCEPTS_REGENERATE_TASKS: 'concepts:regenerateTasks',
  CONCEPTS_ENRICH:         'concepts:enrich',
  CONCEPTS_UPDATE_FIELDS:  'concepts:updateFields',
  CONCEPTS_DELETE:         'concepts:delete',
  CONCEPTS_DELETE_EVIDENCE_SPAN: 'concepts:deleteEvidenceSpan',
  REVIEW_QUEUE_LIST:       'review:queueList',
  SETTINGS_GET:            'settings:get',
  SETTINGS_SET:            'settings:set',
  SOURCES_BYTES:           'sources:bytes',
  SOURCES_LLM_FILTER_GET:  'sources:llmFilterGet',
  SOURCES_LLM_FILTER_SET:  'sources:llmFilterSet',
  CONCEPTS_SOURCE_EVIDENCE: 'concepts:sourceEvidence',
  EVIDENCE_SUBMIT:         'evidence:submit',
  EVIDENCE_HISTORY:        'evidence:history',
  EVIDENCE_DELETE:         'evidence:delete',
  SOURCES_DELETE:          'sources:delete',
  SOURCES_CREATE_TEXT:     'sources:createText',
  CANDIDATES_BY_SOURCE:    'candidates:bySource',
  CANDIDATES_PROMOTE:      'candidates:promote',
  CANDIDATES_PROMOTE_BULK: 'candidates:promoteBulk',
  CANDIDATES_REJECT:       'candidates:reject',
  CANDIDATES_EXTRACT:      'candidates:extract',
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
  evidence: Array<{ page: number; kind: string; label: string; quote?: string }>;
}

export interface UpdateConceptFieldsArgs {
  conceptId: number;
  definition_text?: string;
  why_exists?: string;
  what_breaks?: string;
  where_reappears?: string[];
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

// ─── The renderer-facing API contract ────────────────────────────────────────

export interface IpcApi {
  sources: {
    list: () => Promise<Source[]>;
    create: (args: CreateSourceArgs) => Promise<Source | null>;
    process: (args: ProcessSourceArgs) => Promise<ProcessSourceResult>;
    delete: (sourceId: number) => Promise<void>;
    createText: (args: CreateTextSourceArgs) => Promise<Source | null>;
    bytes: (sourceId: number) => Promise<ArrayBuffer>;
    llmFilterGet: (sourceId: number) => Promise<string[] | null>;
    llmFilterSet: (args: LlmFilterSetArgs) => Promise<{ ok: true }>;
  };
  concepts: {
    bySource: (sourceId: number) => Promise<Concept[]>;
    tasks: (conceptId: number) => Promise<EvidenceTask[]>;
    mastery: (conceptId: number) => Promise<Mastery | null>;
    misconceptions: (conceptId: number) => Promise<Misconception[]>;
    equations: (conceptId: number) => Promise<StoredEquationCandidate[]>;
    ensureTasks: (conceptId: number) => Promise<EvidenceTask[]>;
    regenerateTasks: (conceptId: number) => Promise<EvidenceTask[]>;
    enrich: (conceptId: number) => Promise<EnrichedConcept>;
    updateFields: (args: UpdateConceptFieldsArgs) => Promise<EnrichedConcept | null>;
    sourceEvidence: (conceptId: number) => Promise<ConceptSourceEvidence | null>;
    delete: (conceptId: number) => Promise<{ ok: true }>;
    deleteEvidenceSpan: (args: { conceptId: number; page: number; kind: string; quote: string }) => Promise<ConceptSourceEvidence | null>;
  };
  evidence: {
    submit: (args: SubmitEvidenceArgs) => Promise<EvidenceRecord>;
    history: (conceptId: number) => Promise<EvidenceRecord[]>;
    delete: (recordId: number) => Promise<{ ok: true }>;
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
    extract: (sourceId: number) => Promise<ExtractCandidatesResult>;
  };
  review: {
    queue: (limit?: number) => Promise<ReviewQueueItemPayload[]>;
  };
  parseRuns: {
    bySource: (sourceId: number, limit?: number) => Promise<ParseRunRecord[]>;
  };
}
