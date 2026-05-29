import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  openDb,
  listSources, createSource, updateSourceStatus, getSourceById, deleteSource,
  listConceptsBySource, getConceptById, listReviewQueue, searchConceptsByPrefixForConcept, renameConcept,
  buildConstellationGraph,
  listHubs, createHub, updateHub, deleteHub, addMembers, removeMember, listAllMemberships,
  listConceptSourceEvidence, updateConceptFields, deleteConcept, deleteConceptEvidenceSpan,
  setConceptReviewed, addConceptEvidence, updateConceptEvidence, deleteConceptEvidenceByIndex,
  type SourceEvidenceKind,
  enrichConceptDefinition,
  listTasksByConcept, getMastery, listMisconceptionsByConcept,
  listNotesByConcept, createNote, updateNote, deleteNote, reorderNotes,
  listPdfAnnotationsBySource, createPdfAnnotation, updatePdfAnnotation, softDeletePdfAnnotation, restorePdfAnnotation,
  createChunk, createConcept, updateCentralityScore, createEdge, createMisconception, createTask,
  upsertMastery, createEvidenceRecord, listRecordsByConcept, deleteEvidenceRecord,
  calculateEligibleXpAward, getStudyProgress,
  emitEvent,
  segmentPdf, segmentText,
  extractCandidates, buildSectionPath, persistCandidateExtraction,
  selectBudgetedBlocks,
  deriveTopicAnchors, setTopicAnchors,
  listConceptCandidatesBySource, listRelationCandidatesBySource,
  listMisconceptionCandidatesBySource, listEquationCandidatesBySource,
  listEquationCandidatesForConcept, createManualEquationForConcept, deleteEquationCandidate,
  createRelationCandidate, updateRelationCandidate, deleteRelationCandidate,
  createMisconceptionCandidate, updateMisconceptionCandidate, deleteMisconceptionCandidate,
  createEquationCandidateForSource, updateEquationCandidate,
  ensureTasksForConcept,
  regenerateTasksForConcept,
  promoteCandidate, rejectCandidate, rejectCandidatesBulk, createManualConcept,
  getLlmFilter, setLlmFilter,
  segmentTextWithDiagnostics,
  clearDerivedDataForSource, recoverInterruptedSources,
  createParseRun, listParseRunsBySource,
  loadSettings, saveSettings, applyEnvFallbacks, resolveProviderConfig, MODEL_CHOICES,
  chatJSON,
  type ConceptImportance, type LLMSettings, type PassName, type RelationKind,
  runEnricher,
  runConceptExtractor, runGraphBuilder,
  runMisconceptionExtractor, runTaskGenerator, computeCentrality,
  gradeResponse,
  resetUsageStats, getUsageStats,
} from '@starcall/services';
import { IPC } from '@starcall/shared';
import type {
  CandidateLlmFilterArgs,
  CandidateLlmFilterDecision,
  CreatePdfAnnotationArgs,
  CreateSourceArgs,
  CreateTextSourceArgs,
  ProcessSourceArgs,
  SubmitEvidenceArgs,
  UpdatePdfAnnotationArgs,
} from '@starcall/shared';

const CONCEPT_IMPORTANCE_VALUES = new Set(['foundational', 'core', 'supporting', 'peripheral', 'reference_only']);
const RELATION_KIND_VALUES = new Set(['requires', 'causes', 'enables', 'contrasts_with', 'example_of']);

function toConceptImportance(value: string | undefined): ConceptImportance | undefined {
  return CONCEPT_IMPORTANCE_VALUES.has(value ?? '') ? (value as ConceptImportance) : undefined;
}

function toRelationKind(value: string | undefined): RelationKind {
  return RELATION_KIND_VALUES.has(value ?? '') ? (value as RelationKind) : 'requires';
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0a0a0f',
    title: 'StarcallOS',
    autoHideMenuBar: true,           // no File/Edit/View/Window/Help strip
    show: false,                     // wait until we maximize before showing
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.on('page-title-updated', (_e, title) => {
    if (title !== 'StarcallOS') win.setTitle('StarcallOS');
  });
  win.setMenuBarVisibility(false);
  win.removeMenu();
  win.maximize();
  win.once('ready-to-show', () => win.show());

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function envFallbacks(): { groq?: string; anthropic?: string } {
  return {
    groq:      (import.meta.env.GROQ_API_KEY      as string | undefined) || undefined,
    anthropic: (import.meta.env.ANTHROPIC_API_KEY as string | undefined) || undefined,
  };
}

function cfgFor(pass: PassName): ReturnType<typeof resolveProviderConfig> {
  const dir = app.getPath('userData');
  const s = applyEnvFallbacks(loadSettings(dir), envFallbacks());
  return resolveProviderConfig(s, pass);
}

function stripJsonFences(raw: string): string {
  let body = raw.trim();
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) body = fenced[1].trim();
  if (!body.startsWith('{')) {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) body = body.slice(start, end + 1);
  }
  return body;
}

// Max candidates evaluated per LLM topic-fit call. The term-only payload +
// keep-list response keep this well under the Groq free-tier TPM budget.
const LLM_API_FILTER_LIMIT = 75;

// Deduplicate candidates by normalized term — the renderer maps kept terms back
// to every row sharing that term, so sending duplicates only wastes tokens.
function dedupeByNormalized(candidates: CandidateLlmFilterArgs['candidates']): CandidateLlmFilterArgs['candidates'] {
  const seen = new Set<string>();
  const out: CandidateLlmFilterArgs['candidates'] = [];
  for (const c of candidates) {
    const key = c.normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Compact prompt: one term per line (no per-candidate JSON, no context snippet —
// the term + book title is enough signal for topic-fit, and dropping ctx roughly
// halves input tokens so far more candidates fit per call). Output is a keep-list
// (just the terms to keep) which is much smaller than a per-candidate decision.
function buildCandidateLlmFilterPrompt(sourceTitle: string | undefined, candidates: CandidateLlmFilterArgs['candidates']): string {
  const title = sourceTitle || '(unknown source title)';
  const lines = candidates.map(c => c.normalized).join('\n');
  return [
    `Filter candidate concepts extracted from a book.`,
    `Book title: "${title}"`,
    ``,
    `Keep only terms a reader would specifically study for THIS book's subject.`,
    `Reject broad/generic words, boilerplate, captions, fragments, TOC/index leftovers, and off-topic terms.`,
    ``,
    `Candidate terms (one per line):`,
    lines,
    ``,
    `Respond ONLY with compact JSON listing the terms to KEEP, copied exactly:`,
    `{"keep":["<term>", ...]}`,
  ].join('\n');
}

// Accepts the new keep-list form {"keep":[...]} (preferred) and the legacy
// per-candidate {"decisions":[{term,keep}]} form (manual ChatGPT paste path).
function parseCandidateLlmFilterResponse(raw: string): CandidateLlmFilterDecision[] {
  const parsed = JSON.parse(stripJsonFences(raw)) as { keep?: unknown; decisions?: unknown };
  if (Array.isArray(parsed.keep)) {
    return parsed.keep
      .filter((t): t is string => typeof t === 'string')
      .map(term => ({ term, keep: true }));
  }
  if (!Array.isArray(parsed.decisions)) {
    throw new Error('LLM response did not include a keep or decisions array.');
  }
  return parsed.decisions
    .map((d): CandidateLlmFilterDecision | null => {
      if (!d || typeof d !== 'object') return null;
      const obj = d as { term?: unknown; keep?: unknown; reason?: unknown };
      if (typeof obj.term !== 'string' || typeof obj.keep !== 'boolean') return null;
      return {
        term: obj.term,
        keep: obj.keep,
        reason: typeof obj.reason === 'string' ? obj.reason : undefined,
      };
    })
    .filter((d): d is CandidateLlmFilterDecision => d !== null);
}

function registerIpc(db: ReturnType<typeof openDb>): void {
  ipcMain.handle(IPC.SOURCES_LIST, () => listSources(db));

  ipcMain.handle(IPC.SOURCES_CREATE, async (_e, args: CreateSourceArgs) => {
    let filePaths = args.filePaths?.filter(Boolean) ?? (args.filePath ? [args.filePath] : []);
    const explicitSingle = !!args.filePath && !args.filePaths;
    if (filePaths.length === 0) {
      const result = await dialog.showOpenDialog({
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      filePaths = result.filePaths;
    }
    const sources = filePaths.map((filePath, index) => {
      const filename = path.basename(filePath);
      const title = filePaths.length === 1 ? args.title : undefined;
      const author = filePaths.length === 1 ? args.author : undefined;
      const source = createSource(db, { filename, file_path: filePath, title, author });
      emitEvent(db, 'source.created', { sourceId: source.id }, { entityType: 'source', entityId: source.id });
      console.log(`[SOURCE] imported ${index + 1}/${filePaths.length}: ${filename}`);
      return source;
    });
    return explicitSingle ? sources[0] : sources;
  });

  ipcMain.handle(IPC.SOURCES_PROCESS, async (_e, args: ProcessSourceArgs) => {
    const { sourceId } = args;
    resetUsageStats();
    const startedAt = Date.now();

    // Tracking state. Filled in as we progress; recorded on every exit.
    let mode: 'deterministic' | 'candidate_gated' | 'full' = 'deterministic';
    let pageCount = 0;
    let blockCount = 0;
    let candidateCount = 0;
    let relationCount = 0;
    let equationCount = 0;
    let misconceptionCount = 0;
    let layoutDiagnostics: Record<string, unknown> = {};

    const logTotals = (label: string): void => {
      const s = getUsageStats();
      const passes = Object.entries(s.byPass)
        .map(([k, v]) => `${k}=${v.total}(${v.calls})`)
        .join(' ');
      console.log(`[LLM TOTALS] ${label} source=${sourceId} ${passes} total=${s.total} calls=${s.calls}`);
    };

    const recordRun = (status: 'success' | 'failed', errorMsg?: string): void => {
      const usage = getUsageStats();
      try {
        createParseRun(db, {
          source_id: sourceId,
          status,
          error_msg: errorMsg ?? null,
          mode,
          page_count: pageCount,
          block_count: blockCount,
          candidate_count: candidateCount,
          relation_count: relationCount,
          equation_count: equationCount,
          misconception_count: misconceptionCount,
          duration_ms: Date.now() - startedAt,
          llm_call_count: usage.calls,
          llm_input_tokens: Object.values(usage.byPass).reduce((a, p) => a + p.prompt, 0),
          llm_output_tokens: Object.values(usage.byPass).reduce((a, p) => a + p.completion, 0),
          diagnostics: { ...layoutDiagnostics, llm_by_pass: usage.byPass },
        });
      } catch (e) {
        console.error('[PARSE_RUN] failed to record parse_runs row:', e);
      }
    };

    try {
      // Idempotent retry: wipe derived artifacts before rebuilding. Keeps
      // the source row, file path, and events lineage intact.
      const wiped = clearDerivedDataForSource(db, sourceId);
      const wipedTotal = Object.values(wiped).reduce((a, b) => a + b, 0);
      const isRetry = wipedTotal > 0;
      if (isRetry) {
        console.log(`[RETRY] source=${sourceId} cleared derived data: ${JSON.stringify(wiped)}`);
        emitEvent(db, 'source.retry_started', { sourceId, wiped }, { entityType: 'source', entityId: sourceId });
      }

      updateSourceStatus(db, sourceId, 'processing');
      emitEvent(db, 'source.processing_started', { sourceId }, { entityType: 'source', entityId: sourceId });

      const source = getSourceById(db, sourceId)!;
      let rawChunks: Awaited<ReturnType<typeof runEnricher>>;

      let blocksForLLM: Awaited<ReturnType<typeof segmentPdf>>['blocks'];
      let runningHeaderSections: Awaited<ReturnType<typeof segmentPdf>>['runningHeaderSections'] = [];
      if (source.file_path.endsWith('.txt')) {
        const text = fs.readFileSync(source.file_path, 'utf-8');
        const out = segmentTextWithDiagnostics(text);
        blocksForLLM = out.blocks;
        pageCount = 1;
        layoutDiagnostics = { ...out.diagnostics };
        updateSourceStatus(db, sourceId, 'processing', { page_count: pageCount });
        console.log(`[EXTRACT] text blocks: ${blocksForLLM.length}`);
      } else {
        const { blocks: allBlocks, pageCount: pc, diagnostics: diag, runningHeaderSections: rhSections } = await segmentPdf(source.file_path);
        pageCount = pc;
        runningHeaderSections = rhSections;
        layoutDiagnostics = { ...diag };
        updateSourceStatus(db, sourceId, 'processing', { page_count: pageCount });
        blocksForLLM = allBlocks.filter(b =>
          (args.pageStart == null || b.page >= args.pageStart) &&
          (args.pageEnd   == null || b.page <= args.pageEnd),
        );
        console.log(`[EXTRACT] pdf blocks: ${blocksForLLM.length} (pages ${args.pageStart ?? 1}–${args.pageEnd ?? pageCount}) diag=${JSON.stringify(diag)}`);
      }
      blockCount = blocksForLLM.length;

      // ─── Shadow pipeline: deterministic candidate extraction (zero LLM) ─────
      // Always runs and persists BEFORE the LLM path so we keep something
      // usable even when the LLM stage is rate-limited or fails.
      let candResult: ReturnType<typeof extractCandidates> | null = null;
      try {
        const { paths: sectionPaths, sources: sectionSources } = buildSectionPath(blocksForLLM, runningHeaderSections);
        // Derive topic anchors from title + heading vocabulary, persist on
        // sources so future passes can reuse without recomputing.
        const anchors = deriveTopicAnchors(blocksForLLM, source.title);
        setTopicAnchors(db, sourceId, anchors);
        layoutDiagnostics = { ...layoutDiagnostics, topic_anchors: anchors };
        const cand = extractCandidates(blocksForLLM, sectionPaths, anchors, sectionSources, runningHeaderSections);
        persistCandidateExtraction(db, sourceId, cand);
        candResult = cand;
        candidateCount     = cand.candidates.length;
        relationCount      = cand.relations.length;
        equationCount      = cand.equations.length;
        misconceptionCount = cand.misconception_phrases.length;
        layoutDiagnostics  = { ...layoutDiagnostics, candidate_diagnostics: cand.diagnostics };
        const top = cand.candidates.slice(0, 10).map(c => `${c.term}(${c.confidence})`).join(', ');
        console.log(
          `[CANDIDATES] source=${sourceId} blocks=${cand.diagnostics.blocks_seen} ` +
          `concepts=${cand.candidates.length} relations=${cand.relations.length} ` +
          `misconceptions=${cand.misconception_phrases.length} equations=${cand.equations.length} top=[${top}]`,
        );
      } catch (e) {
        console.error('[CANDIDATES] failed for source', sourceId, e);
      }

      // ─── Mode dispatch ──────────────────────────────────────────────────────
      // deterministic = no LLM. Candidates are the product.
      // candidate_gated = LLM enriches only blocks near top-N candidate pages.
      // full = legacy / benchmark.
      const settingsForBudget = applyEnvFallbacks(loadSettings(app.getPath('userData')), envFallbacks());
      mode = settingsForBudget.extractionMode ?? 'deterministic';

      if (mode === 'deterministic') {
        console.log(`[MODE] source=${sourceId} deterministic — skipping all LLM passes (candidates persisted, lazy task gen on review)`);
        updateSourceStatus(db, sourceId, 'ready');
        emitEvent(db, 'source.processing_completed', { sourceId, mode: 'deterministic' }, { entityType: 'source', entityId: sourceId });
        if (isRetry) emitEvent(db, 'source.retry_completed', { sourceId, mode: 'deterministic' }, { entityType: 'source', entityId: sourceId });
        logTotals('ok-deterministic');
        recordRun('success');
        return {
          ok: true,
          mode: 'deterministic' as const,
          blocks: blockCount,
          candidates: candidateCount,
          relations: relationCount,
          equations: equationCount,
          misconceptions: misconceptionCount,
          llmCalls: getUsageStats().calls,
        };
      }

      if (mode === 'candidate_gated' && candResult) {
        const budget = selectBudgetedBlocks(blocksForLLM, candResult.candidates);
        console.log(
          `[BUDGET] source=${sourceId} mode=gated input=${budget.diagnostics.inputBlocks} ` +
          `selected=${budget.diagnostics.selectedBlocks} pages=${budget.diagnostics.pagesKept} ` +
          `candidates_used=${budget.diagnostics.candidatesUsed}` +
          (budget.diagnostics.fallbackToFull ? ' fallback=full' : ''),
        );
        blocksForLLM = budget.blocks;
      } else {
        console.log(`[BUDGET] source=${sourceId} mode=full blocks=${blocksForLLM.length}`);
      }

      // Guard: refuse to call the LLM extractor on zero blocks. Empty input
      // makes the chunker hallucinate generic concepts (we hit this on a
      // scanned PDF where pdfjs returned no text). Mark the source ready
      // with what the candidate pipeline produced and exit early.
      if (blocksForLLM.length === 0) {
        console.warn(`[EXTRACT] skipping LLM passes for source ${sourceId}: 0 blocks extracted (likely scanned/image PDF)`);
        updateSourceStatus(db, sourceId, 'ready');
        emitEvent(db, 'source.processing_completed', { sourceId, llm_skipped: 'no_blocks' }, { entityType: 'source', entityId: sourceId });
        if (isRetry) emitEvent(db, 'source.retry_completed', { sourceId, llm_skipped: 'no_blocks' }, { entityType: 'source', entityId: sourceId });
        logTotals('ok-no-blocks');
        recordRun('success');
        return {
          ok: true,
          warning: 'No extractable text - candidate pipeline only. Likely a scanned PDF.',
          mode,
          blocks: blockCount,
          candidates: candidateCount,
          relations: relationCount,
          equations: equationCount,
          misconceptions: misconceptionCount,
          llmCalls: getUsageStats().calls,
        };
      }

      rawChunks = await runEnricher(cfgFor('enrich'), blocksForLLM);
      console.log(`[EXTRACT] enriched chunks: ${rawChunks.length}`);
      const savedChunks = rawChunks.map(c =>
        createChunk(db, {
          source_id: sourceId, content: c.content, page_start: c.page_start, page_end: c.page_end,
          block_type: c.block_type, section_path: c.section_path,
          claim: c.claim, assumptions: c.assumptions, example_quote: c.example_quote,
        }),
      );

      const rawConcepts = await runConceptExtractor(cfgFor('concepts'), rawChunks);
      const conceptIdBySlug = new Map<string, number>();
      for (const rc of rawConcepts) {
        const chunkIds = rc.chunk_indices.map(i => savedChunks[i]?.id ?? 0).filter(Boolean);
        const saved = createConcept(db, {
          source_id: sourceId, name: rc.name, slug: rc.slug, importance: rc.importance,
          definition_text: rc.definition_text, why_exists: rc.why_exists,
          what_breaks: rc.what_breaks, where_reappears: [], chunk_ids: chunkIds,
          section_path: rc.section_path, exam_value: rc.exam_value,
          misconception_risk: rc.misconception_risk, centrality_score: 0,
        });
        conceptIdBySlug.set(rc.slug, saved.id);
        upsertMastery(db, saved.id, 0);
        emitEvent(db, 'concept.created', { conceptId: saved.id }, { entityType: 'concept', entityId: saved.id });
      }

      const edges = await runGraphBuilder(cfgFor('graph'), rawConcepts);
      const savedEdges: Array<{ from_id: number; to_id: number }> = [];
      for (const e of edges) {
        const fromId = conceptIdBySlug.get(e.from_slug);
        const toId = conceptIdBySlug.get(e.to_slug);
        if (fromId && toId) {
          createEdge(db, fromId, toId, e.edge_type);
          savedEdges.push({ from_id: fromId, to_id: toId });
        }
      }

      // Pass 6: centrality scoring (no LLM)
      const conceptIds = [...conceptIdBySlug.values()];
      const centrality = computeCentrality(conceptIds, savedEdges);
      for (const [id, score] of centrality) {
        updateCentralityScore(db, id, score);
      }

      const misconceptions = await runMisconceptionExtractor(cfgFor('misconceptions'), rawConcepts);
      for (const m of misconceptions) {
        const conceptId = conceptIdBySlug.get(m.concept_slug);
        if (conceptId) createMisconception(db, { concept_id: conceptId, description: m.description, why_think_it: m.why_think_it, why_wrong: m.why_wrong, test_prompt: m.test_prompt });
      }

      const tasks = await runTaskGenerator(cfgFor('tasks'), rawConcepts);
      for (const t of tasks) {
        const conceptId = conceptIdBySlug.get(t.concept_slug);
        if (conceptId) createTask(db, { concept_id: conceptId, kind: t.kind, prompt: t.prompt, difficulty: t.difficulty });
      }

      updateSourceStatus(db, sourceId, 'ready');
      emitEvent(db, 'source.processing_completed', { sourceId }, { entityType: 'source', entityId: sourceId });
      if (isRetry) emitEvent(db, 'source.retry_completed', { sourceId }, { entityType: 'source', entityId: sourceId });
      logTotals('ok');
      recordRun('success');
      return {
        ok: true,
        mode,
        blocks: blockCount,
        candidates: candidateCount,
        relations: relationCount,
        equations: equationCount,
        misconceptions: misconceptionCount,
        llmCalls: getUsageStats().calls,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[EXTRACT] pipeline failed for source', sourceId, err);
      updateSourceStatus(db, sourceId, 'failed', { error_msg: msg });
      emitEvent(db, 'source.processing_failed', { sourceId, error: msg }, { entityType: 'source', entityId: sourceId });
      logTotals('fail');
      recordRun('failed', msg);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.SOURCES_DELETE, (_e, sourceId: number) => deleteSource(db, sourceId));

  ipcMain.handle(IPC.SOURCES_CREATE_TEXT, (_e, args: CreateTextSourceArgs) => {
    const textDir = path.join(app.getPath('userData'), 'texts');
    fs.mkdirSync(textDir, { recursive: true });
    const filename = `text-${Date.now()}.txt`;
    const filePath = path.join(textDir, filename);
    fs.writeFileSync(filePath, args.text, 'utf-8');
    const title = args.title?.trim() || `Pasted text (${new Date().toLocaleDateString()})`;
    const source = createSource(db, { filename, file_path: filePath, title });
    emitEvent(db, 'source.created', { sourceId: source.id }, { entityType: 'source', entityId: source.id });
    return source;
  });
  ipcMain.handle(IPC.CONCEPTS_BY_SOURCE, (_e, sourceId: number) => listConceptsBySource(db, sourceId));
  ipcMain.handle(IPC.CONCEPTS_CREATE_MANUAL, (_e, args: {
    sourceId: number;
    name: string;
    importance?: string;
    definition_text?: string;
    why_exists?: string;
    what_breaks?: string;
  }) => createManualConcept(db, {
    sourceId: args.sourceId,
    name: args.name,
    importance: toConceptImportance(args.importance),
    definition_text: args.definition_text,
    why_exists: args.why_exists,
    what_breaks: args.what_breaks,
  }));
  ipcMain.handle(IPC.CONCEPTS_TASKS, (_e, conceptId: number) => listTasksByConcept(db, conceptId));
  ipcMain.handle(IPC.CONCEPTS_MASTERY, (_e, conceptId: number) => getMastery(db, conceptId));
  ipcMain.handle(IPC.CONCEPTS_MISCONCEPTIONS, (_e, conceptId: number) => listMisconceptionsByConcept(db, conceptId));
  ipcMain.handle(IPC.CONCEPTS_EQUATIONS, (_e, conceptId: number) => listEquationCandidatesForConcept(db, conceptId));
  ipcMain.handle(IPC.CONCEPTS_EQUATION_CREATE, (_e, args: { conceptId: number; latex: string; page?: number; variables?: string[] }) =>
    createManualEquationForConcept(db, args),
  );
  ipcMain.handle(IPC.CONCEPTS_EQUATION_UPDATE, (_e, args: { equationId: number; latex: string; page?: number; variables?: string[] }) =>
    updateEquationCandidate(db, args.equationId, { latex: args.latex, page: args.page, variables: args.variables }),
  );
  ipcMain.handle(IPC.CONCEPTS_EQUATION_DELETE, (_e, equationId: number) => {
    deleteEquationCandidate(db, equationId);
    return { ok: true as const };
  });
  ipcMain.handle(IPC.CONCEPTS_ENSURE_TASKS, async (_e, conceptId: number) => {
    return ensureTasksForConcept(cfgFor('lazy_tasks'), db, conceptId);
  });
  ipcMain.handle(IPC.CONCEPTS_REGENERATE_TASKS, async (_e, conceptId: number) => {
    return regenerateTasksForConcept(cfgFor('lazy_tasks'), db, conceptId);
  });

  ipcMain.handle(IPC.CONCEPT_NOTES_LIST, (_e, conceptId: number) => listNotesByConcept(db, conceptId));
  ipcMain.handle(IPC.CONCEPT_NOTES_CREATE, (_e, args: { conceptId: number; heading: string; body?: string }) =>
    createNote(db, args.conceptId, { heading: args.heading, body: args.body }),
  );
  ipcMain.handle(IPC.CONCEPT_NOTES_UPDATE, (_e, args: { id: number; heading?: string; body?: string; linkedAnnotationId?: number | null }) =>
    updateNote(db, args.id, { heading: args.heading, body: args.body, linkedAnnotationId: args.linkedAnnotationId }),
  );
  ipcMain.handle(IPC.CONCEPT_NOTES_DELETE, (_e, id: number) => {
    deleteNote(db, id);
    return { ok: true };
  });
  ipcMain.handle(IPC.CONCEPT_NOTES_REORDER, (_e, args: { conceptId: number; orderedIds: number[] }) =>
    reorderNotes(db, args.conceptId, args.orderedIds),
  );
  ipcMain.handle(IPC.CONCEPTS_ENRICH, async (_e, conceptId: number) => {
    return enrichConceptDefinition(cfgFor('lazy_tasks'), db, conceptId);
  });
  ipcMain.handle(IPC.CONCEPTS_UPDATE_FIELDS, (_e, args: {
    conceptId: number;
    definition_text?: string;
    why_exists?: string;
    what_breaks?: string;
    where_reappears?: string[];
    importance?: string;
  }) => {
    return updateConceptFields(db, args.conceptId, args);
  });
  ipcMain.handle(IPC.CONCEPTS_DELETE, (_e, conceptId: number) => {
    deleteConcept(db, conceptId);
    return { ok: true as const };
  });
  ipcMain.handle(IPC.CONCEPTS_SET_REVIEWED, (_e, args: { conceptId: number; reviewed: boolean }) => {
    setConceptReviewed(db, args.conceptId, args.reviewed);
    return { ok: true as const };
  });
  ipcMain.handle(IPC.CONCEPTS_SEARCH_BY_PREFIX, (_e, args: { conceptId: number; prefix: string; limit?: number }) => {
    return searchConceptsByPrefixForConcept(db, args.conceptId, args.prefix, args.limit ?? 8);
  });
  ipcMain.handle(IPC.CONCEPTS_GRAPH, () => buildConstellationGraph(db));
  ipcMain.handle(IPC.HUBS_LIST, () => listHubs(db));
  ipcMain.handle(IPC.HUBS_CREATE, (_e, args: { name: string; color?: string; description?: string; conceptIds?: number[] }) => createHub(db, args));
  ipcMain.handle(IPC.HUBS_UPDATE, (_e, args: { id: number; name?: string; color?: string; description?: string }) => updateHub(db, args.id, args));
  ipcMain.handle(IPC.HUBS_DELETE, (_e, id: number) => { deleteHub(db, id); return { ok: true as const }; });
  ipcMain.handle(IPC.HUBS_ADD_MEMBERS, (_e, args: { hubId: number; conceptIds: number[] }) => { addMembers(db, args.hubId, args.conceptIds); return { ok: true as const }; });
  ipcMain.handle(IPC.HUBS_REMOVE_MEMBER, (_e, args: { hubId: number; conceptId: number }) => { removeMember(db, args.hubId, args.conceptId); return { ok: true as const }; });
  ipcMain.handle(IPC.HUBS_MEMBERSHIPS, () => listAllMemberships(db));
  ipcMain.handle(IPC.CONCEPTS_GET, (_e, id: number) => getConceptById(db, id) ?? null);
  ipcMain.handle(IPC.CONCEPTS_RENAME, (_e, args: { conceptId: number; name: string }) => {
    return renameConcept(db, args.conceptId, args.name);
  });
  ipcMain.handle(IPC.CONCEPTS_DELETE_EVIDENCE_SPAN, (_e, args: {
    conceptId: number; page: number; kind: string; quote: string;
  }) => {
    deleteConceptEvidenceSpan(db, args.conceptId, args.page, args.kind, args.quote);
    return listConceptSourceEvidence(db, args.conceptId);
  });
  ipcMain.handle(IPC.CONCEPTS_ADD_EVIDENCE, (_e, args: { conceptId: number; page: number; kind: SourceEvidenceKind; label: string; quote?: string }) =>
    addConceptEvidence(db, args.conceptId, { page: args.page, kind: args.kind, label: args.label, quote: args.quote }));
  ipcMain.handle(IPC.CONCEPTS_UPDATE_EVIDENCE, (_e, args: { conceptId: number; index: number; page?: number; kind?: SourceEvidenceKind; label?: string; quote?: string }) =>
    updateConceptEvidence(db, args.conceptId, args.index, { page: args.page, kind: args.kind, label: args.label, quote: args.quote }));
  ipcMain.handle(IPC.CONCEPTS_DELETE_EVIDENCE, (_e, args: { conceptId: number; index: number }) =>
    deleteConceptEvidenceByIndex(db, args.conceptId, args.index));
  ipcMain.handle(IPC.REVIEW_QUEUE_LIST, (_e, limit?: number) => listReviewQueue(db, limit ?? 50));

  ipcMain.handle(IPC.CONCEPTS_SOURCE_EVIDENCE, (_e, conceptId: number) => listConceptSourceEvidence(db, conceptId));
  ipcMain.handle(IPC.PARSE_RUNS_BY_SOURCE, (_e, sourceId: number, limit?: number) =>
    listParseRunsBySource(db, sourceId, limit ?? 10),
  );

  ipcMain.handle(IPC.SOURCES_LLM_FILTER_GET, (_e, sourceId: number) => getLlmFilter(db, sourceId));
  ipcMain.handle(IPC.SOURCES_LLM_FILTER_SET, (_e, args: { sourceId: number; keepTerms: string[] | null }) => {
    setLlmFilter(db, args.sourceId, args.keepTerms);
    return { ok: true as const };
  });

  ipcMain.handle(IPC.PDF_ANNOTATIONS_LIST, (_e, sourceId: number) =>
    listPdfAnnotationsBySource(db, sourceId));
  ipcMain.handle(IPC.PDF_ANNOTATIONS_CREATE, (_e, args: CreatePdfAnnotationArgs) => {
    const created = createPdfAnnotation(db, args);
    emitEvent(db, 'pdf_annotation.created', {
      sourceId: created.source_id,
      conceptId: created.concept_id,
      type: created.type,
      page: created.page,
    }, { entityType: 'pdf_annotation', entityId: created.id });
    return created;
  });
  ipcMain.handle(IPC.PDF_ANNOTATIONS_UPDATE, (_e, args: UpdatePdfAnnotationArgs) => {
    const updated = updatePdfAnnotation(db, args.id, args);
    if (updated) {
      emitEvent(db, 'pdf_annotation.updated', {
        sourceId: updated.source_id,
        conceptId: updated.concept_id,
        type: updated.type,
        page: updated.page,
      }, { entityType: 'pdf_annotation', entityId: updated.id });
    }
    return updated;
  });
  ipcMain.handle(IPC.PDF_ANNOTATIONS_DELETE, (_e, id: number) => {
    const deleted = softDeletePdfAnnotation(db, id);
    if (deleted) {
      emitEvent(db, 'pdf_annotation.deleted', {
        sourceId: deleted.source_id,
        conceptId: deleted.concept_id,
        type: deleted.type,
        page: deleted.page,
      }, { entityType: 'pdf_annotation', entityId: deleted.id });
    }
    return deleted;
  });
  ipcMain.handle(IPC.PDF_ANNOTATIONS_RESTORE, (_e, id: number) => {
    const restored = restorePdfAnnotation(db, id);
    if (restored) {
      emitEvent(db, 'pdf_annotation.restored', {
        sourceId: restored.source_id,
        conceptId: restored.concept_id,
        type: restored.type,
        page: restored.page,
      }, { entityType: 'pdf_annotation', entityId: restored.id });
    }
    return restored;
  });

  ipcMain.handle(IPC.SOURCES_BYTES, (_e, sourceId: number) => {
    const src = getSourceById(db, sourceId);
    if (!src) throw new Error(`source ${sourceId} not found`);
    if (!fs.existsSync(src.file_path)) throw new Error(`source file missing: ${src.file_path}`);
    const buf = fs.readFileSync(src.file_path);
    // Return as ArrayBuffer for renderer pdfjs consumption
    return new Uint8Array(buf).buffer;
  });

  ipcMain.handle(IPC.SETTINGS_GET, () => {
    const dir = app.getPath('userData');
    const fb  = envFallbacks();
    const s   = applyEnvFallbacks(loadSettings(dir), fb);
    return {
      provider: s.provider,
      groqApiKeyConfigured:      !!s.groqApiKey,
      anthropicApiKeyConfigured: !!s.anthropicApiKey,
      modelOverrides: s.modelOverrides ?? {},
      extractionMode: s.extractionMode ?? 'deterministic',
      heavyModel: s.heavyModel ?? '',
      lightModel: s.lightModel ?? '',
      modelChoices: MODEL_CHOICES,
    };
  });
  ipcMain.handle(IPC.SETTINGS_SET, (_e, input: Partial<LLMSettings>) => {
    const dir = app.getPath('userData');
    const current = loadSettings(dir);
    const next: LLMSettings = {
      ...current,
      provider:        input.provider        ?? current.provider,
      // Preserve previously stored keys when the renderer omits them.
      groqApiKey:      input.groqApiKey      !== undefined ? input.groqApiKey      : current.groqApiKey,
      anthropicApiKey: input.anthropicApiKey !== undefined ? input.anthropicApiKey : current.anthropicApiKey,
      modelOverrides:  input.modelOverrides  ?? current.modelOverrides ?? {},
      extractionMode:  input.extractionMode  ?? current.extractionMode ?? 'deterministic',
      heavyModel:      input.heavyModel      !== undefined ? input.heavyModel      : current.heavyModel,
      lightModel:      input.lightModel      !== undefined ? input.lightModel      : current.lightModel,
    };
    saveSettings(dir, next);
    return { ok: true as const };
  });
  ipcMain.handle(IPC.EVIDENCE_HISTORY, (_e, conceptId: number) => listRecordsByConcept(db, conceptId));
  ipcMain.handle(IPC.EVIDENCE_DELETE, (_e, recordId: number) => {
    deleteEvidenceRecord(db, recordId);
    return { ok: true };
  });

  ipcMain.handle(IPC.CANDIDATES_BY_SOURCE, (_e, sourceId: number) => ({
    concepts:       listConceptCandidatesBySource(db, sourceId),
    relations:      listRelationCandidatesBySource(db, sourceId),
    misconceptions: listMisconceptionCandidatesBySource(db, sourceId),
    equations:      listEquationCandidatesBySource(db, sourceId),
  }));
  ipcMain.handle(IPC.CANDIDATES_PROMOTE, (_e, candidateId: number) => promoteCandidate(db, candidateId));
  ipcMain.handle(IPC.CANDIDATES_PROMOTE_BULK, (_e, candidateIds: number[]) => {
    // Return the *candidate* IDs we promoted (not the new concept IDs) so the
    // renderer can drop them from the visible list with a simple set lookup.
    const promoted: number[] = [];
    const errors: Array<{ candidateId: number; error: string }> = [];
    for (const id of candidateIds) {
      try {
        promoteCandidate(db, id);
        promoted.push(id);
      } catch (e) {
        errors.push({ candidateId: id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    console.log(`[BULK PROMOTE] requested=${candidateIds.length} promoted=${promoted.length} errors=${errors.length}`);
    return { promoted, errors };
  });
  ipcMain.handle(IPC.CANDIDATES_REJECT,  (_e, candidateId: number) => {
    rejectCandidate(db, candidateId);
    return { ok: true };
  });
  ipcMain.handle(IPC.CANDIDATES_REJECT_BULK, (_e, candidateIds: number[]) => rejectCandidatesBulk(db, candidateIds));
  ipcMain.handle(IPC.CANDIDATES_RELATION_CREATE, (_e, args: {
    sourceId: number; from: string; to: string; kind?: string; quote?: string; page?: number;
  }) => createRelationCandidate(db, args.sourceId, {
    from: args.from,
    to: args.to,
    kind: toRelationKind(args.kind),
    quote: args.quote ?? '',
    page: Math.max(0, Math.floor(args.page ?? 0)),
  }));
  ipcMain.handle(IPC.CANDIDATES_RELATION_UPDATE, (_e, args: {
    id: number; from: string; to: string; kind?: string; quote?: string; page?: number;
  }) => updateRelationCandidate(db, args.id, {
    from: args.from,
    to: args.to,
    kind: toRelationKind(args.kind),
    quote: args.quote ?? '',
    page: Math.max(0, Math.floor(args.page ?? 0)),
  }));
  ipcMain.handle(IPC.CANDIDATES_RELATION_DELETE, (_e, id: number) => {
    deleteRelationCandidate(db, id);
    return { ok: true as const };
  });
  ipcMain.handle(IPC.CANDIDATES_MISCONCEPTION_CREATE, (_e, args: {
    sourceId: number; quote: string; page?: number; section_path?: string[];
  }) => createMisconceptionCandidate(db, args.sourceId, {
    quote: args.quote,
    page: Math.max(0, Math.floor(args.page ?? 0)),
    section_path: args.section_path ?? [],
  }));
  ipcMain.handle(IPC.CANDIDATES_MISCONCEPTION_UPDATE, (_e, args: {
    id: number; quote: string; page?: number; section_path?: string[];
  }) => updateMisconceptionCandidate(db, args.id, {
    quote: args.quote,
    page: Math.max(0, Math.floor(args.page ?? 0)),
    section_path: args.section_path ?? [],
  }));
  ipcMain.handle(IPC.CANDIDATES_MISCONCEPTION_DELETE, (_e, id: number) => {
    deleteMisconceptionCandidate(db, id);
    return { ok: true as const };
  });
  ipcMain.handle(IPC.CANDIDATES_EQUATION_CREATE, (_e, args: {
    sourceId: number; latex: string; page?: number; variables?: string[]; section_path?: string[]; attached_term?: string | null;
  }) => createEquationCandidateForSource(db, {
    sourceId: args.sourceId,
    latex: args.latex,
    page: Math.max(0, Math.floor(args.page ?? 0)),
    variables: args.variables,
    section_path: args.section_path ?? [],
    attached_term: args.attached_term ?? null,
  }));
  ipcMain.handle(IPC.CANDIDATES_EQUATION_UPDATE, (_e, args: {
    id: number; latex: string; page?: number; variables?: string[]; section_path?: string[]; attached_term?: string | null;
  }) => updateEquationCandidate(db, args.id, {
    latex: args.latex,
    page: Math.max(0, Math.floor(args.page ?? 0)),
    variables: args.variables,
    section_path: args.section_path ?? [],
    attached_term: args.attached_term ?? null,
  }));
  ipcMain.handle(IPC.CANDIDATES_EQUATION_DELETE, (_e, id: number) => {
    deleteEquationCandidate(db, id);
    return { ok: true as const };
  });
  ipcMain.handle(IPC.CANDIDATES_LLM_FILTER, async (_e, args: CandidateLlmFilterArgs) => {
    const source = getSourceById(db, args.sourceId);
    if (!source) throw new Error(`source ${args.sourceId} not found`);

    // One compact call against the configured provider. Deterministic extraction
    // already narrowed the list; a single 75-candidate batch keeps this fast and
    // well under low Groq TPM tiers (the manual ChatGPT prompt is the large-list
    // fallback for full coverage).
    const config = cfgFor('concepts');
    const candidates = dedupeByNormalized(args.candidates).slice(0, LLM_API_FILTER_LIMIT);
    if (candidates.length === 0) {
      return { provider: config.provider, model: config.model, sent: 0, keepTerms: [], decisions: [] };
    }
    const title = args.sourceTitle ?? source.title ?? source.filename;
    const { content } = await chatJSON(config, {
      responseFormat: 'json',
      temperature: 0,
      maxTokens: Math.min(1200, Math.max(220, candidates.length * 12 + 120)),
      messages: [
        { role: 'system', content: 'You are a precise textbook concept filter. Return valid JSON only.' },
        { role: 'user', content: buildCandidateLlmFilterPrompt(title, candidates) },
      ],
    }, 'concepts');
    const decisions = parseCandidateLlmFilterResponse(content);
    const candidateTerms = new Set(candidates.map(c => c.normalized.toLowerCase()));
    const keepTerms = decisions
      .filter(d => d.keep && candidateTerms.has(d.term.toLowerCase()))
      .map(d => d.term.toLowerCase());

    return {
      provider: config.provider,
      model: config.model,
      sent: candidates.length,
      keepTerms,
      decisions,
    };
  });
  ipcMain.handle(IPC.CANDIDATES_EXTRACT, async (_e, sourceId: number) => {
    const source = getSourceById(db, sourceId);
    if (!source) throw new Error(`source ${sourceId} not found`);
    const fileExists = fs.existsSync(source.file_path);
    console.log(`[CANDIDATES] (manual) start source=${sourceId} path="${source.file_path}" exists=${fileExists}`);
    if (!fileExists) {
      throw new Error(`source file no longer exists: ${source.file_path}`);
    }
    let blocks: Awaited<ReturnType<typeof segmentPdf>>['blocks'];
    let runningHeaderSections: Awaited<ReturnType<typeof segmentPdf>>['runningHeaderSections'] = [];
    if (source.file_path.endsWith('.txt')) {
      blocks = segmentText(fs.readFileSync(source.file_path, 'utf-8'));
      console.log(`[CANDIDATES] (manual) text blocks=${blocks.length}`);
    } else {
      try {
        const out = await segmentPdf(source.file_path);
        blocks = out.blocks;
        runningHeaderSections = out.runningHeaderSections;
        console.log(`[CANDIDATES] (manual) pdf pages=${out.pageCount} blocks=${blocks.length}`);
      } catch (e) {
        console.error('[CANDIDATES] (manual) segmentPdf failed:', e);
        throw e;
      }
    }
    const { paths: sectionPaths, sources: sectionSources } = buildSectionPath(blocks, runningHeaderSections);
    const anchors = deriveTopicAnchors(blocks, source.title);
    setTopicAnchors(db, sourceId, anchors);
    const cand = extractCandidates(blocks, sectionPaths, anchors, sectionSources, runningHeaderSections);
    persistCandidateExtraction(db, sourceId, cand);
    console.log(
      `[CANDIDATES] (manual) source=${sourceId} blocks=${cand.diagnostics.blocks_seen} ` +
      `concepts=${cand.candidates.length} relations=${cand.relations.length} ` +
      `misconceptions=${cand.misconception_phrases.length} equations=${cand.equations.length}`,
    );
    return {
      ok: true as const,
      blocks: cand.diagnostics.blocks_seen,
      concepts: cand.candidates.length,
      relations: cand.relations.length,
      misconceptions: cand.misconception_phrases.length,
      equations: cand.equations.length,
    };
  });

  ipcMain.handle(IPC.EVIDENCE_SUBMIT, async (_e, args: SubmitEvidenceArgs) => {
    const { taskId, conceptId, userResponse } = args;
    const concept = getConceptById(db, conceptId);
    const task = listTasksByConcept(db, conceptId).find(t => t.id === taskId);
    if (!task || !concept) throw new Error('Task or concept not found');

    resetUsageStats();
    const grade = await gradeResponse(cfgFor('grader'), {
      concept_name: concept.name, concept_definition: concept.definition_text,
      task_kind: task.kind, task_prompt: task.prompt, user_response: userResponse,
    });
    {
      const s = getUsageStats();
      const passes = Object.entries(s.byPass)
        .map(([k, v]) => `${k}=${v.total}(${v.calls})`)
        .join(' ');
      console.log(`[LLM TOTALS] grade concept=${conceptId} task=${taskId} ${passes} total=${s.total} calls=${s.calls}`);
    }

    const record = createEvidenceRecord(db, {
      task_id: taskId, concept_id: conceptId, user_response: userResponse,
      score: grade.score, compression_stage: grade.compression_stage,
      gaps_detected: grade.gaps_detected, misconceptions_detected: grade.misconceptions_detected,
      grader_reasoning: grade.reasoning,
      task_prompt_snapshot: task.prompt,
      task_kind_snapshot: task.kind,
      task_difficulty_snapshot: task.difficulty,
      xp_awarded: calculateEligibleXpAward(db, conceptId, task.kind, task.difficulty, grade.score),
    });

    upsertMastery(db, conceptId, grade.compression_stage);
    emitEvent(db, 'evidence_record.graded', { recordId: record.id, score: grade.score }, { entityType: 'concept', entityId: conceptId });
    return record;
  });
  ipcMain.handle(IPC.EVIDENCE_PROGRESS, () => getStudyProgress(db));
}

// ─── App lifecycle ─────────────────────────────────────────────────────────────

// Application name (used in OS process list, dock, notifications). Setting at
// module top so it applies before app.whenReady fires.
app.setName('StarcallOS');

app.whenReady().then(() => {
  // Disable the app-level menu entirely (kills the File/Edit/View/Window/Help bar).
  // Per-window calls (`removeMenu`, `setMenuBarVisibility(false)`) belt-and-suspender it.
  Menu.setApplicationMenu(null);

  const DB_PATH = path.join(app.getPath('userData'), 'stellaria.db');
  const db = openDb(DB_PATH);

  // Recovery scan: anything still 'processing' was killed mid-run. Mark
  // failed so the user can retry deliberately.
  const recovered = recoverInterruptedSources(db);
  if (recovered.length > 0) {
    console.log(`[RECOVERY] marked ${recovered.length} interrupted source(s) as failed: ids=[${recovered.join(', ')}]`);
  }

  registerIpc(db);
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
