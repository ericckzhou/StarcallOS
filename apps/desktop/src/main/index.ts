import { app, BrowserWindow, ipcMain, dialog, Menu, safeStorage, session, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import {
  openDb,
  listSources, createSource, updateSourceStatus, getSourceById, deleteSource,
  listConceptsBySource, getConceptById, listReviewQueue, searchConceptsByPrefixForConcept, renameConcept,
  listAllConceptTags,
  buildConstellationGraph,
  listHubs, createHub, updateHub, deleteHub, addMembers, removeMember, setMemberRole, listAllMemberships,
  listHubEdges, createHubEdge, updateHubEdge, deleteHubEdge,
  listConceptSourceEvidence, buildGroundingContext, updateConceptFields, deleteConcept, deleteConceptEvidenceSpan,
  setConceptReviewed, addConceptEvidence, updateConceptEvidence, deleteConceptEvidenceByIndex,
  type SourceEvidenceKind,
  enrichConceptDefinition,
  listTasksByConcept, getMastery, listMisconceptionsByConcept,
  listNotesByConcept, createNote, updateNote, deleteNote, reorderNotes,
  listPdfAnnotationsBySource, createPdfAnnotation, updatePdfAnnotation, softDeletePdfAnnotation, restorePdfAnnotation,
  createChunk, createConcept, getConceptBySlug, updateCentralityScore, createEdge, deleteConceptEdge, createMisconception, createTask,
  getConceptPrerequisites,
  computeDeterministicSuggestions, suggestLlmPrerequisites, listPrerequisiteSuggestions,
  listPrerequisiteSuggestionsForConcept,
  acceptPrerequisiteSuggestion, rejectPrerequisiteSuggestion,
  upsertMastery, createEvidenceRecord, listRecordsByConcept, deleteEvidenceRecord,
  calculateEligibleXpAward, getStudyProgress,
  recordSrsReview, countDueConcepts, countNewConcepts, setConceptSrsDue, getConceptSrs,
  emitEvent,
  segmentPdf, segmentText,
  chunkBlocks, syncSourceChunks,
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
  loadSettingsAsync, saveSettingsAsync, sanitizeSettingsInput, applyEnvFallbacks, resolveProviderConfig, MODEL_CHOICES,
  chatJSON,
  validateIpc, isPrivateIp, isBlockedHostname,
  CreateSourceArgsSchema, ProcessSourceArgsSchema, CreateTextSourceArgsSchema,
  SettingsPatchSchema, SubmitEvidenceArgsSchema, CandidateLlmFilterArgsSchema,
  UpdateConceptFieldsArgsSchema, CreatePdfAnnotationArgsSchema, UpdatePdfAnnotationArgsSchema,
  PositiveIntSchema, ExportConceptArgsSchema, ExportBundleArgsSchema, ImportUrlArgsSchema, ImportDocsArgsSchema,
  IdArraySchema, CreateManualConceptArgsSchema, RenameConceptArgsSchema, SetReviewedArgsSchema,
  ConceptEquationCreateArgsSchema, ConceptEquationUpdateArgsSchema,
  NoteCreateArgsSchema, NoteUpdateArgsSchema, NoteReorderArgsSchema,
  DeleteEvidenceSpanArgsSchema, AddEvidenceArgsSchema, UpdateEvidenceArgsSchema, DeleteEvidenceByIndexArgsSchema,
  LlmFilterSetArgsSchema,
  HubCreateArgsSchema, HubUpdateArgsSchema, HubAddMembersArgsSchema, HubMemberArgsSchema, HubSetMemberRoleArgsSchema,
  HubEdgeCreateArgsSchema, HubEdgeUpdateArgsSchema,
  ConceptEdgeArgsSchema, PrereqSuggestionsListArgsSchema,
  RelationCandidateCreateArgsSchema, RelationCandidateUpdateArgsSchema,
  MisconceptionCandidateCreateArgsSchema, MisconceptionCandidateUpdateArgsSchema,
  EquationCandidateCreateArgsSchema, EquationCandidateUpdateArgsSchema,
  renderConceptExport, renderBundleExport, extractArticle, docxToMarkdown, pptxToMarkdown, ocrTextToSource, ocrParagraphsToSource, OCR_MIN_CONFIDENCE, chunkBatches,
  type ConceptImportance, type LLMSettings, type PassName, type RelationKind, type AsyncSecretCodec,
  runEnricher,
  runConceptExtractor, runGraphBuilder,
  runMisconceptionExtractor, runTaskGenerator, computeCentrality,
  gradeResponse,
  resetUsageStats, getUsageStats, setLlmTraceSink, effectiveSelfConsistency, listLocalModels, DEFAULT_LOCAL_BASE_URL,
  setSrsScheduler, mergeSettingsPatch, persistGradedAttempt, normalizeLocalBaseUrl, createOpenAICompatEmbedder, createCachingEmbedder, findCandidateNearDuplicates, DEFAULT_EMBEDDING_MODEL, indexSourceEmbeddings, retrieveSourceExcerpts, relatedConcepts, embeddingStats,
  planLibraryIndex, runLibraryIndex, type LibraryIndexProgress, type LibraryIndexSummary,
  planOutdatedSources, runReextractOutdated, currentReextractVersions, type ReextractProgress, type ReextractSummary,
  doclingServerInfo, DEFAULT_DOCLING_BASE_URL, LAYOUT_VERSION, CHUNKER_VERSION,
  resolveAskConfig, askSources, saveAskHistory, listAskHistory, deleteAskHistory, chunkIndexStats, indexSourceChunkEmbeddings, RagAskArgsSchema, RagSourceSearchArgsSchema, searchSourcePassages,
  type Embedder, buildCandidateLlmFilterPrompt, parseCandidateLlmFilterResponse, keptBatchTerms, createLlmCallSink, summarizeLlmCalls,
} from '@starcall/services';
import { IPC } from '@starcall/shared';
import { expectedLayoutFor, segmentPdfConfigured, stopPdfParser } from './pdf_parser';
import { IMAGE_EXTENSIONS, isImagePath, ocrImages } from './ocr';
import type {
  CandidateLlmFilterArgs,
  CandidateLlmFilterDecision,
  CreatePdfAnnotationArgs,
  CreateSourceArgs,
  CreateTextSourceArgs,
  ExportConceptArgs,
  ExportBundleArgs,
  ImportUrlArgs,
  ImportDocsArgs,
  ProcessSourceArgs,
  SubmitEvidenceArgs,
  UpdatePdfAnnotationArgs,
  SettingsSnapshot,
  LlmTraceSummary,
  RagStatus,
  RagLibraryStatus,
  ReextractStatus,
  ExtractCandidatesResult,
  RagIndexSourceResult,
  EmbeddingsStatus,
  CandidateNearDuplicates,
} from '@starcall/shared';

const CONCEPT_IMPORTANCE_VALUES = new Set(['foundational', 'core', 'supporting', 'peripheral', 'reference_only']);
const RELATION_KIND_VALUES = new Set(['requires', 'causes', 'enables', 'contrasts_with', 'example_of']);

function toConceptImportance(value: string | undefined): ConceptImportance | undefined {
  return CONCEPT_IMPORTANCE_VALUES.has(value ?? '') ? (value as ConceptImportance) : undefined;
}

function toRelationKind(value: string | undefined): RelationKind {
  return RELATION_KIND_VALUES.has(value ?? '') ? (value as RelationKind) : 'requires';
}

// ─── URL-import SSRF guard ──────────────────────────────────────────────────────
// The URL importer fetches an arbitrary user-supplied URL in the main process.
// Block requests that target the loopback/private/link-local space (including
// the cloud-metadata endpoint 169.254.169.254) so a pasted or redirected URL
// can't reach internal services. The range/hostname predicates are pure and
// unit-tested in @starcall/services (core/net_guard); this layer adds the URL
// parsing + DNS resolution. Residual, documented limitations: DNS rebinding
// between this lookup and fetch's own resolution (TOCTOU), and a blind GET still
// being sent on a redirect hop before we re-check the final URL — both narrow
// for a user-initiated desktop importer.
async function assertPublicUrl(urlStr: string): Promise<void> {
  let u: URL;
  try { u = new URL(urlStr); } catch { throw new Error('Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http/https URLs are supported');
  }
  const host = u.hostname;
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Refusing to fetch a private or loopback address');
    return;
  }
  if (isBlockedHostname(host)) {
    throw new Error('Refusing to fetch a local or internal hostname');
  }
  let addrs: Awaited<ReturnType<typeof lookup>>;
  try { addrs = await lookup(host, { all: true }); } catch { throw new Error(`Could not resolve host: ${host}`); }
  if (addrs.length === 0) throw new Error(`Could not resolve host: ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('Refusing to fetch a host that resolves to a private address');
  }
}

// Window/taskbar icon. In dev __dirname is out/main, so reach the build asset;
// in a packaged app it's shipped as an extraResource at resourcesPath/icon.png.
function resolveAppIcon(): string | undefined {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'icon.png'),
    path.join(__dirname, '../../build/icon.png'),
    path.join(__dirname, '../../../build/icon.png'),
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

function createWindow(): void {
  const icon = resolveAppIcon();
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0a0a0f',
    title: 'StarcallOS',
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,           // no File/Edit/View/Window/Help strip
    show: false,                     // wait until we maximize before showing
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // OS-level process isolation on top of context isolation. The preload
      // only uses contextBridge + ipcRenderer, both available under sandbox.
      sandbox: true,
    },
  });

  // Seal the shell: this is a single-page local app, never a browser. Deny any
  // attempt to open a new window (e.g. injected window.open / target=_blank) and
  // route only http/https links to the OS browser through the same vetted path
  // as app:openExternal. Everything else is dropped.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Block in-place navigation away from the app's own document. A crafted link
  // or injected redirect surfaced through ingested text can't move the window
  // off-origin; outbound http/https is handed to the OS browser instead.
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL();
    if (url !== current) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
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

// Provider keys are read from the OS-encrypted settings file first; these env
// vars are only a fallback for headless/dev use. Read at RUNTIME from
// process.env (never inlined into the bundle) so a key can't leak inside a
// packaged build. Both providers are handled identically — the old code only
// wired GROQ via a build-time define, leaving the ANTHROPIC fallback dead.
function envFallbacks(): { groq?: string; anthropic?: string } {
  return {
    groq:      process.env['GROQ_API_KEY']      || undefined,
    anthropic: process.env['ANTHROPIC_API_KEY'] || undefined,
  };
}

// Dev-only convenience: load GROQ_API_KEY / ANTHROPIC_API_KEY from a local `.env`
// into process.env so `pnpm dev` can use a key without opening Settings. NEVER
// runs in a packaged build, and values are read at runtime — they are never
// baked into the shipped bundle. Existing process.env values win (explicit
// shell env > .env file). Silently does nothing if no `.env` is found.
function loadDevDotenv(): void {
  if (app.isPackaged) return;
  const candidates = [
    process.cwd(),
    path.join(__dirname, '../..'),       // apps/desktop
    path.join(__dirname, '../../../..'), // repo root
  ];
  for (const dir of candidates) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, '.env'), 'utf-8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const i = trimmed.indexOf('=');
      const key = trimmed.slice(0, i).trim();
      const value = trimmed.slice(i + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
    return;
  }
}

// OS-backed secret codec for API keys (DPAPI on Windows, Keychain on macOS,
// libsecret on Linux), on Electron's async safeStorage API (the sync calls are
// deprecated). Usable only after the app is ready. If the OS has no keyring,
// `available` is false and settings.ts falls back to plaintext rather than
// losing the key. decryptStringAsync also reads keys written by the old sync
// encryptString, so existing installs keep their keys.
async function secretCodec(): Promise<AsyncSecretCodec> {
  return {
    available: await safeStorage.isAsyncEncryptionAvailable(),
    encrypt: async (plain) => (await safeStorage.encryptStringAsync(plain)).toString('base64'),
    decrypt: async (b64) => {
      const r = await safeStorage.decryptStringAsync(Buffer.from(b64, 'base64'));
      return { plain: r.result, reencrypt: r.shouldReEncrypt };
    },
  };
}

// Decrypted settings, loaded once at startup (initSettings) and replaced on
// every save, so the many synchronous readers never touch the async codec.
// main is the only writer of settings.json.
let settingsCache: LLMSettings | null = null;
let settingsWrite: Promise<void> = Promise.resolve();

async function initSettings(): Promise<void> {
  const dir = app.getPath('userData');
  const codec = await secretCodec();
  const { settings, needsResave } = await loadSettingsAsync(dir, codec);
  settingsCache = settings;
  // Encrypt a key left as plaintext by a pre-encryption install, or re-encrypt
  // one the OS rotated, so no stale secret stays on disk until the next save.
  if (needsResave) {
    await saveSettingsAsync(dir, settings, codec);
    console.log('[SECRETS] re-saved API key(s) with OS-encrypted storage');
  }
}

// Persists settings and swaps the cache only after the write succeeded.
// Saves are serialized so two quick Settings saves can't interleave.
function persistSettings(next: LLMSettings): Promise<void> {
  const run = settingsWrite.then(async () => {
    await saveSettingsAsync(app.getPath('userData'), next, await secretCodec());
    settingsCache = next;
  });
  settingsWrite = run.catch(() => undefined);
  return run;
}

// Saved settings as stored (no env fallbacks). A copy, so callers can't
// mutate the cache.
function loadRawSettings(): LLMSettings {
  if (!settingsCache) throw new Error('settings read before initSettings()');
  return structuredClone(settingsCache);
}

// Saved settings with env-var API key fallbacks applied — what LLM calls use.
function loadEffectiveSettings(): LLMSettings {
  return applyEnvFallbacks(loadRawSettings(), envFallbacks());
}

// Embedder for the opt-in local embedding index, or null when disabled.
function getEmbedder(): Embedder | null {
  const s = loadRawSettings();
  if (!s.embeddingsEnabled) return null;
  return createOpenAICompatEmbedder(s.localBaseUrl, s.embeddingModel?.trim() || DEFAULT_EMBEDDING_MODEL);
}

// Embedding work must never stall or fail the feature it decorates.
async function softTimeout<T>(p: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>(resolve => { timer = setTimeout(() => { console.warn(`[EMBED] ${label} timed out after ${ms}ms`); resolve(fallback); }, ms); }),
    ]);
  } catch (e) {
    console.warn(`[EMBED] ${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cfgFor(pass: PassName): ReturnType<typeof resolveProviderConfig> {
  return resolveProviderConfig(loadEffectiveSettings(), pass);
}

// Max candidates evaluated per LLM topic-fit call. The term-only payload +
// keep-list response keep this well under the Groq free-tier TPM budget.
const LLM_API_FILTER_LIMIT = 75;

// Full-coverage filter bounds. Sequential + paced + capped so a large source
// can never storm the rate limit (the failure mode that got the earlier
// multi-batch/dual-provider attempt reverted). chatJSON owns the per-call 429
// backoff; these are the outer guardrails.
const LLM_FILTER_MAX_BATCHES = 12;        // hard ceiling (~900 candidates/run)
const LLM_FILTER_DEADLINE_MS = 120_000;   // overall wall-clock budget
const LLM_FILTER_BATCH_DELAY_MS = 1_000;  // pacing between batches (RPM safety)

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

// Deterministic retrieval-chunk index (RAG foundation). Zero LLM, zero
// embedding calls: chunks are reconciled by content key, so re-processing an
// unchanged document writes nothing. A failure here is logged and reported in
// the parse-run diagnostics but never fails processing — candidates are the
// product; the chunk index is an additive derived artifact.
function syncRetrievalChunks(
  db: ReturnType<typeof openDb>,
  sourceId: number,
  blocks: Awaited<ReturnType<typeof segmentPdf>>['blocks'],
  runningHeaderSections: Awaited<ReturnType<typeof segmentPdf>>['runningHeaderSections'],
  layoutVersion: string = LAYOUT_VERSION,
): Record<string, unknown> {
  try {
    const { chunks, diagnostics } = chunkBlocks(blocks, runningHeaderSections);
    const sync = syncSourceChunks(db, sourceId, chunks, { chunker: CHUNKER_VERSION, layout: layoutVersion });
    console.log(`[RAG_CHUNKS] source=${sourceId} chunks=${chunks.length} sync=${JSON.stringify(sync)}`);
    return { ...diagnostics, sync };
  } catch (e) {
    console.error('[RAG_CHUNKS] failed for source', sourceId, e);
    return { error: (e as Error).message };
  }
}

function registerIpc(db: ReturnType<typeof openDb>): void {
  ipcMain.handle(IPC.SOURCES_LIST, () => listSources(db));

  ipcMain.handle(IPC.SOURCES_CREATE, async (_e, args: CreateSourceArgs) => {
    const { filePath: singlePath, filePaths: rawFilePaths, title, author } = validateIpc(CreateSourceArgsSchema, args, IPC.SOURCES_CREATE);
    let filePaths = rawFilePaths?.filter(Boolean) ?? (singlePath ? [singlePath] : []);
    const explicitSingle = !!singlePath && !rawFilePaths;
    if (filePaths.length === 0) {
      const result = await dialog.showOpenDialog({
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      filePaths = result.filePaths;
    }
    const sources = filePaths.map((fp, index) => {
      const filename = path.basename(fp);
      const sourceTitle = filePaths.length === 1 ? title : undefined;
      const sourceAuthor = filePaths.length === 1 ? author : undefined;
      const source = createSource(db, { filename, file_path: fp, title: sourceTitle, author: sourceAuthor });
      emitEvent(db, 'source.created', { sourceId: source.id }, { entityType: 'source', entityId: source.id });
      console.log(`[SOURCE] imported ${index + 1}/${filePaths.length}: ${filename}`);
      return source;
    });
    return explicitSingle ? sources[0] : sources;
  });

  // Processing wipes and rebuilds a source's derived data, so it takes the same
  // per-source lock as re-extract, chunk rebuild and embedding: otherwise their
  // wipes/inserts interleave at every await (duplicate candidates, vectors for
  // just-deleted chunks).
  ipcMain.handle(IPC.SOURCES_PROCESS, (_e, rawArgs: ProcessSourceArgs) => {
    const args = validateIpc(ProcessSourceArgsSchema, rawArgs, IPC.SOURCES_PROCESS);
    return withSourceLock(args.sourceId, () => processSource(args));
  });

  async function processSource(args: ProcessSourceArgs) {
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
    let layoutVersionUsed = LAYOUT_VERSION;

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
          layout_version: layoutVersionUsed,
        });
      } catch (e) {
        console.error('[PARSE_RUN] failed to record parse_runs row:', e);
      }
    };

    try {
      // Parse the PDF BEFORE wiping anything: a Docling conversion can take
      // minutes, and a parse that fails or is interrupted (app closed) must
      // not leave the source with its candidates already deleted.
      updateSourceStatus(db, sourceId, 'processing');
      const preSource = getSourceById(db, sourceId)!;
      const preSeg = preSource.file_path.endsWith('.txt')
        ? null
        : await segmentPdfConfigured(preSource.file_path, loadRawSettings());

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
        const seg = preSeg!;
        const { blocks: allBlocks, pageCount: pc, diagnostics: diag, runningHeaderSections: rhSections } = seg;
        pageCount = pc;
        runningHeaderSections = rhSections;
        layoutVersionUsed = seg.layoutVersion;
        layoutDiagnostics = { ...diag, parser: seg.parser, parser_fallback: seg.fallback };
        updateSourceStatus(db, sourceId, 'processing', { page_count: pageCount });
        blocksForLLM = allBlocks.filter(b =>
          (args.pageStart == null || b.page >= args.pageStart) &&
          (args.pageEnd   == null || b.page <= args.pageEnd),
        );
        console.log(`[EXTRACT] pdf blocks: ${blocksForLLM.length} (pages ${args.pageStart ?? 1}-${args.pageEnd ?? pageCount}) diag=${JSON.stringify(diag)}`);
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
      layoutDiagnostics = {
        ...layoutDiagnostics,
        rag_chunks: syncRetrievalChunks(db, sourceId, blocksForLLM, runningHeaderSections, layoutVersionUsed),
      };

      // ─── Mode dispatch ──────────────────────────────────────────────────────
      // deterministic = no LLM. Candidates are the product.
      // candidate_gated = LLM enriches only blocks near top-N candidate pages.
      // full = legacy / benchmark.
      const settingsForBudget = loadEffectiveSettings();
      mode = settingsForBudget.extractionMode ?? 'deterministic';

      if (mode === 'deterministic') {
        console.log(`[MODE] source=${sourceId} deterministic - skipping all LLM passes (candidates persisted, lazy task gen on review)`);
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
      // Concepts that survived the wipe (user-owned or unknown origin) keep
      // their row: reuse it by slug instead of inserting, which would violate
      // UNIQUE(source_id, slug) and fail the whole run. Their fields, tasks and
      // misconceptions are left as the user has them.
      const preservedSlugs = new Set<string>();
      for (const rc of rawConcepts) {
        const existing = getConceptBySlug(db, sourceId, rc.slug);
        if (existing) {
          conceptIdBySlug.set(rc.slug, existing.id);
          preservedSlugs.add(rc.slug);
          continue;
        }
        const chunkIds = rc.chunk_indices.map(i => savedChunks[i]?.id ?? 0).filter(Boolean);
        const saved = createConcept(db, {
          source_id: sourceId, name: rc.name, slug: rc.slug, importance: rc.importance,
          definition_text: rc.definition_text, why_exists: rc.why_exists,
          what_breaks: rc.what_breaks, where_reappears: [], chunk_ids: chunkIds,
          section_path: rc.section_path, exam_value: rc.exam_value,
          misconception_risk: rc.misconception_risk, centrality_score: 0,
        }, 'llm');
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
        if (preservedSlugs.has(m.concept_slug)) continue;
        const conceptId = conceptIdBySlug.get(m.concept_slug);
        if (conceptId) createMisconception(db, { concept_id: conceptId, description: m.description, why_think_it: m.why_think_it, why_wrong: m.why_wrong, test_prompt: m.test_prompt });
      }

      const tasks = await runTaskGenerator(cfgFor('tasks'), rawConcepts);
      for (const t of tasks) {
        if (preservedSlugs.has(t.concept_slug)) continue;
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
      return { ok: false as const, error: msg };
    }
  }

  ipcMain.handle(IPC.SOURCES_DELETE, (_e, sourceId: number) => {
    const id = validateIpc(PositiveIntSchema, sourceId, IPC.SOURCES_DELETE);
    return deleteSource(db, id);
  });

  ipcMain.handle(IPC.SOURCES_CREATE_TEXT, (_e, args: CreateTextSourceArgs) => {
    const { text, title: rawTitle } = validateIpc(CreateTextSourceArgsSchema, args, IPC.SOURCES_CREATE_TEXT);
    const textDir = path.join(app.getPath('userData'), 'texts');
    fs.mkdirSync(textDir, { recursive: true });
    const filename = `text-${Date.now()}.txt`;
    const filePath = path.join(textDir, filename);
    fs.writeFileSync(filePath, text, 'utf-8');
    const title = rawTitle?.trim() || `Pasted text (${new Date().toLocaleDateString()})`;
    const source = createSource(db, { filename, file_path: filePath, title });
    emitEvent(db, 'source.created', { sourceId: source.id }, { entityType: 'source', entityId: source.id });
    return source;
  });

  // Import a web page as a text-backed source. The fetch + HTML→text extraction
  // live here (network/parsing belong in main); the result rides the same
  // text-source pipeline. Errors return { ok:false } rather than throwing.
  ipcMain.handle(IPC.SOURCES_IMPORT_URL, async (_e, rawArgs: ImportUrlArgs) => {
    const args = validateIpc(ImportUrlArgsSchema, rawArgs, IPC.SOURCES_IMPORT_URL);
    let html: string;
    try {
      // Block the target before connecting (covers a directly pasted internal URL).
      await assertPublicUrl(args.url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(args.url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          // Many sites (Medium, news, Cloudflare) 403 a non-browser UA, so we
          // present a normal desktop-browser fingerprint.
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      }).finally(() => clearTimeout(timer));
      // Re-check the post-redirect URL before reading the body, so a public URL
      // that 30x-redirects to an internal address never has its content ingested.
      await assertPublicUrl(res.url || args.url);
      if (!res.ok) return { ok: false, error: `Fetch failed: HTTP ${res.status}` };
      const ctype = res.headers.get('content-type') ?? '';
      if (ctype && !/text\/html|xml|text\/plain/i.test(ctype)) {
        return { ok: false, error: `Unsupported content type: ${ctype.split(';')[0].trim()}` };
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 5_000_000) return { ok: false, error: 'Page too large (over 5 MB).' };
      html = new TextDecoder('utf-8').decode(buf);
    } catch (err) {
      const msg = err instanceof Error
        ? (err.name === 'AbortError' ? 'Fetch timed out (10s).' : err.message)
        : String(err);
      return { ok: false, error: msg };
    }

    const extracted = extractArticle(html);
    if (!extracted.text.trim()) return { ok: false, error: 'No readable text found on the page.' };

    const textDir = path.join(app.getPath('userData'), 'texts');
    fs.mkdirSync(textDir, { recursive: true });
    const filename = `url-${Date.now()}.txt`;
    const filePath = path.join(textDir, filename);
    fs.writeFileSync(filePath, extracted.text, 'utf-8');
    const title = args.title?.trim() || extracted.title?.trim() || args.url;
    const source = createSource(db, { filename, file_path: filePath, title, origin_url: args.url });
    emitEvent(db, 'source.created', { sourceId: source.id, origin: 'url', url: args.url }, { entityType: 'source', entityId: source.id });
    return { ok: true, source };
  });

  // Import local documents (.docx for now) as text-backed sources. When no paths
  // are given, open a file dialog (like `+ PDF`). Each file is extracted
  // independently — a bad file lands in `errors`, never failing the batch.
  ipcMain.handle(IPC.SOURCES_IMPORT_DOCS, async (_e, rawArgs: ImportDocsArgs) => {
    const args = validateIpc(ImportDocsArgsSchema, rawArgs, IPC.SOURCES_IMPORT_DOCS);
    let paths = args.paths ?? [];
    if (paths.length === 0) {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: args.kind === 'images'
          ? [{ name: 'Images', extensions: [...IMAGE_EXTENSIONS] }]
          : [{ name: 'Documents', extensions: ['docx', 'pptx'] }],
      });
      if (result.canceled) return { sources: [], errors: [] };
      paths = result.filePaths;
    }

    const textDir = path.join(app.getPath('userData'), 'texts');
    fs.mkdirSync(textDir, { recursive: true });
    const sources: ReturnType<typeof createSource>[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    // Images: OCR (bundled English model, no network) → cleaned text source.
    const imagePaths = paths.filter(isImagePath);
    if (imagePaths.length > 0) {
      const cacheDir = path.join(app.getPath('userData'), 'ocr-cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      let results: Awaited<ReturnType<typeof ocrImages>> = [];
      try { results = await ocrImages(imagePaths, cacheDir); }
      catch (err) {
        const msg = `OCR engine failed to start: ${err instanceof Error ? err.message : String(err)}`;
        for (const p of imagePaths) errors.push({ path: p, error: msg });
      }
      for (const r of results) {
        if (r.error || !r.result) { errors.push({ path: r.path, error: r.error ?? 'OCR failed' }); continue; }
        const text = r.result.paragraphs.length > 0
          ? ocrParagraphsToSource(r.result.paragraphs)
          : ocrTextToSource(r.result.text);
        if (!text || r.result.confidence < OCR_MIN_CONFIDENCE) {
          errors.push({ path: r.path, error: `No readable text found in the image (OCR confidence ${Math.round(r.result.confidence)}%).` });
          continue;
        }
        const filename = `ocr-${Date.now()}-${sources.length}.txt`;
        const filePath = path.join(textDir, filename);
        fs.writeFileSync(filePath, text, 'utf-8');
        const title = path.basename(r.path, path.extname(r.path));
        const source = createSource(db, { filename, file_path: filePath, title });
        emitEvent(db, 'source.created', { sourceId: source.id, origin: 'ocr', ocrConfidence: Math.round(r.result.confidence) }, { entityType: 'source', entityId: source.id });
        sources.push(source);
      }
    }

    for (const docPath of paths.filter(p => !isImagePath(p))) {
      try {
        const ext = path.extname(docPath).toLowerCase();
        const buffer = fs.readFileSync(docPath);
        let markdown: string;
        if (ext === '.docx') markdown = (await docxToMarkdown(buffer)).trim();
        else if (ext === '.pptx') markdown = pptxToMarkdown(buffer).trim();
        else { errors.push({ path: docPath, error: `Unsupported file type: ${ext || 'unknown'}` }); continue; }
        if (!markdown) { errors.push({ path: docPath, error: 'No readable text found in the document.' }); continue; }
        const filename = `${ext.slice(1)}-${Date.now()}-${sources.length}.txt`;
        const filePath = path.join(textDir, filename);
        fs.writeFileSync(filePath, markdown, 'utf-8');
        const title = path.basename(docPath, path.extname(docPath));
        const source = createSource(db, { filename, file_path: filePath, title });
        emitEvent(db, 'source.created', { sourceId: source.id, origin: ext.slice(1) }, { entityType: 'source', entityId: source.id });
        sources.push(source);
      } catch (err) {
        errors.push({ path: docPath, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { sources, errors };
  });
  ipcMain.handle(IPC.APP_OPEN_EXTERNAL, async (_e, url: string) => {
    // Only ever hand http/https URLs to the OS — never file:, etc.
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return { ok: true as const };
    }
    return { ok: false as const };
  });
  ipcMain.handle(IPC.CONCEPTS_BY_SOURCE, (_e, sourceId: number) => listConceptsBySource(db, sourceId));
  ipcMain.handle(IPC.CONCEPTS_CREATE_MANUAL, (_e, args: {
    sourceId: number;
    name: string;
    importance?: string;
    definition_text?: string;
    why_exists?: string;
    what_breaks?: string;
  }) => {
    validateIpc(CreateManualConceptArgsSchema, args, IPC.CONCEPTS_CREATE_MANUAL);
    return createManualConcept(db, {
      sourceId: args.sourceId,
      name: args.name,
      importance: toConceptImportance(args.importance),
      definition_text: args.definition_text,
      why_exists: args.why_exists,
      what_breaks: args.what_breaks,
    });
  });
  ipcMain.handle(IPC.CONCEPTS_TASKS, (_e, conceptId: number) => listTasksByConcept(db, conceptId));
  ipcMain.handle(IPC.CONCEPTS_MASTERY, (_e, conceptId: number) => getMastery(db, conceptId));
  ipcMain.handle(IPC.CONCEPTS_MISCONCEPTIONS, (_e, conceptId: number) => listMisconceptionsByConcept(db, conceptId));
  ipcMain.handle(IPC.CONCEPTS_EQUATIONS, (_e, conceptId: number) => listEquationCandidatesForConcept(db, conceptId));
  ipcMain.handle(IPC.CONCEPTS_EQUATION_CREATE, (_e, args: { conceptId: number; latex: string; page?: number; variables?: string[] }) => {
    validateIpc(ConceptEquationCreateArgsSchema, args, IPC.CONCEPTS_EQUATION_CREATE);
    return createManualEquationForConcept(db, args);
  });
  ipcMain.handle(IPC.CONCEPTS_EQUATION_UPDATE, (_e, args: { equationId: number; latex: string; page?: number; variables?: string[] }) => {
    validateIpc(ConceptEquationUpdateArgsSchema, args, IPC.CONCEPTS_EQUATION_UPDATE);
    return updateEquationCandidate(db, args.equationId, { latex: args.latex, page: args.page, variables: args.variables });
  });
  ipcMain.handle(IPC.CONCEPTS_EQUATION_DELETE, (_e, equationId: number) => {
    deleteEquationCandidate(db, validateIpc(PositiveIntSchema, equationId, IPC.CONCEPTS_EQUATION_DELETE));
    return { ok: true as const };
  });
  ipcMain.handle(IPC.CONCEPTS_ENSURE_TASKS, async (_e, conceptId: number) => {
    return ensureTasksForConcept(cfgFor('lazy_tasks'), db, conceptId);
  });
  ipcMain.handle(IPC.CONCEPTS_REGENERATE_TASKS, async (_e, conceptId: number) => {
    return regenerateTasksForConcept(cfgFor('lazy_tasks'), db, conceptId);
  });

  ipcMain.handle(IPC.CONCEPT_NOTES_LIST, (_e, conceptId: number) => listNotesByConcept(db, conceptId));
  ipcMain.handle(IPC.CONCEPT_NOTES_CREATE, (_e, args: { conceptId: number; heading: string; body?: string }) => {
    validateIpc(NoteCreateArgsSchema, args, IPC.CONCEPT_NOTES_CREATE);
    return createNote(db, args.conceptId, { heading: args.heading, body: args.body });
  });
  ipcMain.handle(IPC.CONCEPT_NOTES_UPDATE, (_e, args: { id: number; heading?: string; body?: string; linkedAnnotationId?: number | null }) => {
    validateIpc(NoteUpdateArgsSchema, args, IPC.CONCEPT_NOTES_UPDATE);
    return updateNote(db, args.id, { heading: args.heading, body: args.body, linkedAnnotationId: args.linkedAnnotationId });
  });
  ipcMain.handle(IPC.CONCEPT_NOTES_DELETE, (_e, id: number) => {
    deleteNote(db, validateIpc(PositiveIntSchema, id, IPC.CONCEPT_NOTES_DELETE));
    return { ok: true };
  });
  ipcMain.handle(IPC.CONCEPT_NOTES_REORDER, (_e, args: { conceptId: number; orderedIds: number[] }) => {
    validateIpc(NoteReorderArgsSchema, args, IPC.CONCEPT_NOTES_REORDER);
    return reorderNotes(db, args.conceptId, args.orderedIds);
  });
  ipcMain.handle(IPC.CONCEPTS_ENRICH, async (_e, conceptId: number) => {
    return enrichConceptDefinition(cfgFor('lazy_tasks'), db, conceptId);
  });
  ipcMain.handle(IPC.CONCEPTS_UPDATE_FIELDS, (_e, rawArgs: {
    conceptId: number;
    definition_text?: string;
    why_exists?: string;
    what_breaks?: string;
    where_reappears?: string[];
    importance?: string;
  }) => {
    const args = validateIpc(UpdateConceptFieldsArgsSchema, rawArgs, IPC.CONCEPTS_UPDATE_FIELDS);
    return updateConceptFields(db, args.conceptId, args);
  });
  ipcMain.handle(IPC.CONCEPTS_DELETE, (_e, conceptId: number) => {
    const id = validateIpc(PositiveIntSchema, conceptId, IPC.CONCEPTS_DELETE);
    deleteConcept(db, id);
    return { ok: true as const };
  });
  ipcMain.handle(IPC.CONCEPTS_SET_REVIEWED, (_e, args: { conceptId: number; reviewed: boolean }) => {
    validateIpc(SetReviewedArgsSchema, args, IPC.CONCEPTS_SET_REVIEWED);
    setConceptReviewed(db, args.conceptId, args.reviewed);
    // "Done" without a graded challenge is an honest neutral review: advance the
    // SRS card with a passing-but-effortful grade so the concept leaves the
    // queue and comes back on schedule rather than being permanently muted.
    if (args.reviewed) recordSrsReview(db, args.conceptId, 'recognizes');
    return { ok: true as const };
  });
  ipcMain.handle(IPC.CONCEPTS_SEARCH_BY_PREFIX, (_e, args: { conceptId: number; prefix: string; limit?: number }) => {
    return searchConceptsByPrefixForConcept(db, args.conceptId, args.prefix, args.limit ?? 8);
  });
  ipcMain.handle(IPC.CONCEPTS_ALL_TAGS, () => listAllConceptTags(db));
  ipcMain.handle(IPC.CONCEPTS_GRAPH, () => buildConstellationGraph(db));
  // ── Prerequisite engine (migration 0028) ──────────────────────────────────
  ipcMain.handle(IPC.CONCEPTS_PREREQUISITES, (_e, conceptId: number) => {
    const id = validateIpc(PositiveIntSchema, conceptId, IPC.CONCEPTS_PREREQUISITES);
    return getConceptPrerequisites(db, id);
  });
  ipcMain.handle(IPC.CONCEPTS_EDGE_CREATE, (_e, args: { fromId: number; toId: number; edgeType: 'requires' | 'enables' }) => {
    const a = validateIpc(ConceptEdgeArgsSchema, args, IPC.CONCEPTS_EDGE_CREATE);
    const edge = createEdge(db, a.fromId, a.toId, a.edgeType);
    emitEvent(db, 'concept_edge.created', { fromId: a.fromId, toId: a.toId, edgeType: a.edgeType }, { entityType: 'concept', entityId: a.toId });
    return { ok: edge != null };
  });
  ipcMain.handle(IPC.CONCEPTS_EDGE_DELETE, (_e, args: { fromId: number; toId: number; edgeType: 'requires' | 'enables' }) => {
    const a = validateIpc(ConceptEdgeArgsSchema, args, IPC.CONCEPTS_EDGE_DELETE);
    deleteConceptEdge(db, a.fromId, a.toId, a.edgeType);
    emitEvent(db, 'concept_edge.deleted', { fromId: a.fromId, toId: a.toId, edgeType: a.edgeType }, { entityType: 'concept', entityId: a.toId });
    return { ok: true as const };
  });
  ipcMain.handle(IPC.PREREQ_SUGGESTIONS_LIST, (_e, args: { sourceId: number; status?: 'pending' | 'accepted' | 'dismissed' }) => {
    const a = validateIpc(PrereqSuggestionsListArgsSchema, args, IPC.PREREQ_SUGGESTIONS_LIST);
    return listPrerequisiteSuggestions(db, a.sourceId, a.status ?? 'pending');
  });
  ipcMain.handle(IPC.PREREQ_SUGGESTIONS_FOR_CONCEPT, (_e, conceptId: number) => {
    const id = validateIpc(PositiveIntSchema, conceptId, IPC.PREREQ_SUGGESTIONS_FOR_CONCEPT);
    return listPrerequisiteSuggestionsForConcept(db, id, 'pending');
  });
  ipcMain.handle(IPC.PREREQ_SUGGESTIONS_COMPUTE, (_e, sourceId: number) => {
    const id = validateIpc(PositiveIntSchema, sourceId, IPC.PREREQ_SUGGESTIONS_COMPUTE);
    return computeDeterministicSuggestions(db, id);
  });
  ipcMain.handle(IPC.PREREQ_SUGGESTIONS_LLM, async (_e, sourceId: number) => {
    const id = validateIpc(PositiveIntSchema, sourceId, IPC.PREREQ_SUGGESTIONS_LLM);
    return suggestLlmPrerequisites(cfgFor('prereq_suggest'), db, id);
  });
  ipcMain.handle(IPC.PREREQ_SUGGESTION_ACCEPT, (_e, suggestionId: number) => {
    const id = validateIpc(PositiveIntSchema, suggestionId, IPC.PREREQ_SUGGESTION_ACCEPT);
    return acceptPrerequisiteSuggestion(db, id);
  });
  ipcMain.handle(IPC.PREREQ_SUGGESTION_REJECT, (_e, suggestionId: number) => {
    const id = validateIpc(PositiveIntSchema, suggestionId, IPC.PREREQ_SUGGESTION_REJECT);
    return rejectPrerequisiteSuggestion(db, id);
  });
  ipcMain.handle(IPC.HUBS_LIST, () => listHubs(db));
  ipcMain.handle(IPC.HUBS_CREATE, (_e, args: { name: string; color?: string; description?: string; conceptIds?: number[]; parentHubId?: number | null }) => {
    validateIpc(HubCreateArgsSchema, args, IPC.HUBS_CREATE);
    return createHub(db, args);
  });
  ipcMain.handle(IPC.HUBS_UPDATE, (_e, args: { id: number; name?: string; color?: string; description?: string; parentHubId?: number | null }) => {
    validateIpc(HubUpdateArgsSchema, args, IPC.HUBS_UPDATE);
    return updateHub(db, args.id, args);
  });
  ipcMain.handle(IPC.HUBS_DELETE, (_e, id: number) => { deleteHub(db, validateIpc(PositiveIntSchema, id, IPC.HUBS_DELETE)); return { ok: true as const }; });
  ipcMain.handle(IPC.HUBS_ADD_MEMBERS, (_e, args: { hubId: number; conceptIds: number[] }) => { validateIpc(HubAddMembersArgsSchema, args, IPC.HUBS_ADD_MEMBERS); addMembers(db, args.hubId, args.conceptIds); return { ok: true as const }; });
  ipcMain.handle(IPC.HUBS_REMOVE_MEMBER, (_e, args: { hubId: number; conceptId: number }) => { validateIpc(HubMemberArgsSchema, args, IPC.HUBS_REMOVE_MEMBER); removeMember(db, args.hubId, args.conceptId); return { ok: true as const }; });
  ipcMain.handle(IPC.HUBS_SET_MEMBER_ROLE, (_e, args: { hubId: number; conceptId: number; role: string }) => { validateIpc(HubSetMemberRoleArgsSchema, args, IPC.HUBS_SET_MEMBER_ROLE); setMemberRole(db, args.hubId, args.conceptId, args.role); return { ok: true as const }; });
  ipcMain.handle(IPC.HUBS_MEMBERSHIPS, () => listAllMemberships(db));
  ipcMain.handle(IPC.HUBS_EDGES_LIST, () => listHubEdges(db));
  ipcMain.handle(IPC.HUBS_EDGE_CREATE, (_e, args: { aHubId: number; bHubId: number; label?: string; directed?: boolean }) => {
    validateIpc(HubEdgeCreateArgsSchema, args, IPC.HUBS_EDGE_CREATE);
    return createHubEdge(db, args);
  });
  ipcMain.handle(IPC.HUBS_EDGE_UPDATE, (_e, args: { id: number; label?: string; directed?: boolean }) => {
    validateIpc(HubEdgeUpdateArgsSchema, args, IPC.HUBS_EDGE_UPDATE);
    return updateHubEdge(db, args.id, args);
  });
  ipcMain.handle(IPC.HUBS_EDGE_DELETE, (_e, id: number) => { deleteHubEdge(db, validateIpc(PositiveIntSchema, id, IPC.HUBS_EDGE_DELETE)); return { ok: true as const }; });
  ipcMain.handle(IPC.CONCEPTS_GET, (_e, id: number) => getConceptById(db, id) ?? null);
  ipcMain.handle(IPC.CONCEPTS_RENAME, (_e, args: { conceptId: number; name: string }) => {
    validateIpc(RenameConceptArgsSchema, args, IPC.CONCEPTS_RENAME);
    return renameConcept(db, args.conceptId, args.name);
  });
  ipcMain.handle(IPC.CONCEPTS_DELETE_EVIDENCE_SPAN, (_e, args: {
    conceptId: number; page: number; kind: string; quote: string;
  }) => {
    validateIpc(DeleteEvidenceSpanArgsSchema, args, IPC.CONCEPTS_DELETE_EVIDENCE_SPAN);
    deleteConceptEvidenceSpan(db, args.conceptId, args.page, args.kind, args.quote);
    return listConceptSourceEvidence(db, args.conceptId);
  });
  ipcMain.handle(IPC.CONCEPTS_ADD_EVIDENCE, (_e, args: { conceptId: number; page: number; kind: SourceEvidenceKind; label: string; quote?: string; annotationId?: number }) => {
    validateIpc(AddEvidenceArgsSchema, args, IPC.CONCEPTS_ADD_EVIDENCE);
    return addConceptEvidence(db, args.conceptId, { page: args.page, kind: args.kind, label: args.label, quote: args.quote, annotationId: args.annotationId });
  });
  ipcMain.handle(IPC.CONCEPTS_UPDATE_EVIDENCE, (_e, args: { conceptId: number; index: number; page?: number; kind?: SourceEvidenceKind; label?: string; quote?: string }) => {
    validateIpc(UpdateEvidenceArgsSchema, args, IPC.CONCEPTS_UPDATE_EVIDENCE);
    return updateConceptEvidence(db, args.conceptId, args.index, { page: args.page, kind: args.kind, label: args.label, quote: args.quote });
  });
  ipcMain.handle(IPC.CONCEPTS_DELETE_EVIDENCE, (_e, args: { conceptId: number; index: number }) => {
    validateIpc(DeleteEvidenceByIndexArgsSchema, args, IPC.CONCEPTS_DELETE_EVIDENCE);
    return deleteConceptEvidenceByIndex(db, args.conceptId, args.index);
  });
  ipcMain.handle(IPC.REVIEW_QUEUE_LIST, (_e, limit?: number) => listReviewQueue(db, limit ?? 50));
  ipcMain.handle(IPC.REVIEW_DUE_COUNT, () => ({
    newCount: countNewConcepts(db),
    dueCount: countDueConcepts(db),
  }));
  ipcMain.handle(IPC.REVIEW_SET_DUE, (_e, args: { conceptId: number; dueAt: string | null }) => {
    setConceptSrsDue(db, args.conceptId, args.dueAt);
    return { ok: true as const };
  });
  ipcMain.handle(IPC.REVIEW_GET_SRS, (_e, conceptId: number) => getConceptSrs(db, conceptId));

  ipcMain.handle(IPC.EXPORT_CONCEPT, async (_e, rawArgs: ExportConceptArgs) => {
    const args = validateIpc(ExportConceptArgsSchema, rawArgs, IPC.EXPORT_CONCEPT);
    const concept = getConceptById(db, args.conceptId);
    if (!concept) return { ok: false, error: 'Concept not found' };

    const source = getSourceById(db, concept.source_id);
    const sourceTitle = source ? (source.title || source.filename) : 'Unknown source';
    const { content, extension } = renderConceptExport(
      {
        concept,
        sourceTitle,
        notes: listNotesByConcept(db, args.conceptId),
        equations: listEquationCandidatesForConcept(db, args.conceptId),
        srs: getConceptSrs(db, args.conceptId),
      },
      args.format,
    );

    const safeName = (concept.slug || `concept-${concept.id}`).replace(/[^\w.-]+/g, '-');
    const result = await dialog.showSaveDialog({
      defaultPath: `${safeName}.${extension}`,
      filters: args.format === 'anki'
        ? [{ name: 'Anki import (tab-separated)', extensions: ['txt'] }]
        : [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    try {
      fs.writeFileSync(result.filePath, content, 'utf-8');
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true, path: result.filePath };
  });

  // Bulk export: every concept in one source, or across the whole library, into
  // a single Markdown/Anki file. Assembles the same per-concept ConceptExportData
  // the single-concept handler does, then renders the bundle.
  ipcMain.handle(IPC.EXPORT_BUNDLE, async (_e, rawArgs: ExportBundleArgs) => {
    const args = validateIpc(ExportBundleArgsSchema, rawArgs, IPC.EXPORT_BUNDLE);

    let concepts: ReturnType<typeof getConceptById>[] = [];
    let bundleTitle: string;
    let defaultStem: string;
    if (args.scope === 'source') {
      const source = getSourceById(db, args.sourceId!);
      if (!source) return { ok: false, error: 'Source not found' };
      concepts = listConceptsBySource(db, args.sourceId!);
      bundleTitle = source.title || source.filename;
      defaultStem = (bundleTitle || `source-${source.id}`).replace(/[^\w.-]+/g, '-');
    } else {
      // Library: every promoted concept across all sources, grouped by source.
      for (const source of listSources(db)) {
        concepts.push(...listConceptsBySource(db, source.id));
      }
      bundleTitle = 'StarcallOS Library';
      defaultStem = 'starcall-library';
    }

    if (concepts.length === 0) {
      return { ok: false, error: args.scope === 'source' ? 'This source has no promoted concepts to export.' : 'No promoted concepts to export yet.' };
    }

    const sourceTitleCache = new Map<number, string>();
    const sourceTitleFor = (sourceId: number): string => {
      let title = sourceTitleCache.get(sourceId);
      if (title === undefined) {
        const src = getSourceById(db, sourceId);
        title = src ? (src.title || src.filename) : 'Unknown source';
        sourceTitleCache.set(sourceId, title);
      }
      return title;
    };

    const items = concepts.filter((c): c is NonNullable<typeof c> => c != null).map(concept => ({
      concept,
      sourceTitle: sourceTitleFor(concept.source_id),
      notes: listNotesByConcept(db, concept.id),
      equations: listEquationCandidatesForConcept(db, concept.id),
      srs: getConceptSrs(db, concept.id),
    }));

    const { content, extension } = renderBundleExport(items, args.format, bundleTitle);

    const result = await dialog.showSaveDialog({
      defaultPath: `${defaultStem}.${extension}`,
      filters: args.format === 'anki'
        ? [{ name: 'Anki import (tab-separated)', extensions: ['txt'] }]
        : [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    try {
      fs.writeFileSync(result.filePath, content, 'utf-8');
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true, path: result.filePath };
  });

  ipcMain.handle(IPC.CONCEPTS_SOURCE_EVIDENCE, (_e, conceptId: number) => listConceptSourceEvidence(db, conceptId));
  ipcMain.handle(IPC.PARSE_RUNS_BY_SOURCE, (_e, sourceId: number, limit?: number) =>
    listParseRunsBySource(db, sourceId, limit ?? 10),
  );

  ipcMain.handle(IPC.SOURCES_LLM_FILTER_GET, (_e, sourceId: number) => getLlmFilter(db, sourceId));
  ipcMain.handle(IPC.SOURCES_LLM_FILTER_SET, (_e, args: { sourceId: number; keepTerms: string[] | null }) => {
    validateIpc(LlmFilterSetArgsSchema, args, IPC.SOURCES_LLM_FILTER_SET);
    setLlmFilter(db, args.sourceId, args.keepTerms);
    return { ok: true as const };
  });

  ipcMain.handle(IPC.PDF_ANNOTATIONS_LIST, (_e, sourceId: number) =>
    listPdfAnnotationsBySource(db, sourceId));
  ipcMain.handle(IPC.PDF_ANNOTATIONS_CREATE, (_e, rawArgs: CreatePdfAnnotationArgs) => {
    const args = validateIpc(CreatePdfAnnotationArgsSchema, rawArgs, IPC.PDF_ANNOTATIONS_CREATE);
    const created = createPdfAnnotation(db, args);
    emitEvent(db, 'pdf_annotation.created', {
      sourceId: created.source_id,
      conceptId: created.concept_id,
      type: created.type,
      page: created.page,
    }, { entityType: 'pdf_annotation', entityId: created.id });
    return created;
  });
  ipcMain.handle(IPC.PDF_ANNOTATIONS_UPDATE, (_e, rawArgs: UpdatePdfAnnotationArgs) => {
    const args = validateIpc(UpdatePdfAnnotationArgsSchema, rawArgs, IPC.PDF_ANNOTATIONS_UPDATE);
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

  ipcMain.handle(IPC.LLM_TRACE_SUMMARY, (_e, rawDays: unknown): LlmTraceSummary => {
    const days = typeof rawDays === 'number' && Number.isFinite(rawDays)
      ? Math.min(365, Math.max(1, Math.floor(rawDays)))
      : 30;
    return summarizeLlmCalls(db, days);
  });

  ipcMain.handle(IPC.EMBEDDINGS_STATUS, (): EmbeddingsStatus => {
    const s = loadRawSettings();
    const model = s.embeddingModel?.trim() || DEFAULT_EMBEDDING_MODEL;
    return {
      enabled: !!s.embeddingsEnabled,
      model,
      ...embeddingStats(db, model),
      totalSources: listSources(db).length,
    };
  });

  let libraryIndexing: Promise<unknown> | null = null;
  ipcMain.handle(IPC.EMBEDDINGS_INDEX_LIBRARY, async () => {
    const embedder = getEmbedder();
    if (!embedder) return { ok: false as const, error: 'Embeddings are turned off.' };
    if (libraryIndexing) return { ok: false as const, error: 'Indexing is already running.' };
    const run = (async () => {
      let embedded = 0;
      const sources = listSources(db);
      for (const src of sources) {
        embedded += (await indexSourceEmbeddings(db, embedder, src.id)).embedded;
      }
      return { ok: true as const, sources: sources.length, embedded };
    })();
    libraryIndexing = run;
    try {
      return await run;
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    } finally {
      libraryIndexing = null;
    }
  });

  // Memoized per model: candidate terms are derived and not persisted, so the
  // in-memory cache is what keeps re-opening Candidate Review cheap.
  const cachedEmbedders = new Map<string, Embedder>();
  ipcMain.handle(IPC.CANDIDATES_NEAR_DUPLICATES, async (_e, rawId: unknown): Promise<CandidateNearDuplicates> => {
    const sourceId = validateIpc(PositiveIntSchema, rawId, IPC.CANDIDATES_NEAR_DUPLICATES);
    const base = getEmbedder();
    if (!base) return {};
    // Keyed by server AND model: changing the base URL must not keep hitting
    // the old server through a stale cached wrapper.
    const cacheKey = `${base.baseUrl ?? ''}|${base.model}`;
    const embedder = cachedEmbedders.get(cacheKey) ?? createCachingEmbedder(base);
    cachedEmbedders.set(cacheKey, embedder);
    const candidates = listConceptCandidatesBySource(db, sourceId).map(c => ({
      id: c.id, term: c.term, normalized: c.normalized,
    }));
    return softTimeout(findCandidateNearDuplicates(embedder, candidates), 60_000, {}, 'candidate near-duplicates');
  });

  ipcMain.handle(IPC.CONCEPTS_RELATED, async (_e, rawId: unknown) => {
    const conceptId = validateIpc(PositiveIntSchema, rawId, IPC.CONCEPTS_RELATED);
    const embedder = getEmbedder();
    const concept = getConceptById(db, conceptId);
    if (!embedder || !concept) return [];
    // Keep this concept's own source fresh; other sources come from the last
    // library index (Settings → Embeddings), so this stays fast.
    await softTimeout(indexSourceEmbeddings(db, embedder, concept.source_id), 8_000, null, 'related index');
    const linked = new Set(
      (concept.where_reappears as Array<string | { name: string }>).map(l => (typeof l === 'string' ? l : l.name).toLowerCase()),
    );
    return relatedConcepts(db, embedder.model, conceptId, 10).filter(r => !linked.has(r.name.toLowerCase())).slice(0, 6);
  });

  // ─── Local Ask (RAG) ──────────────────────────────────────────────────────
  // Answers come only from the local model (resolveAskConfig). Embeddings are
  // local too and generated lazily here, on Ask, per selected source — each
  // batch is persisted, so an interrupted run resumes where it stopped and
  // compatible vectors (same model + text hash) are never recomputed.
  ipcMain.handle(IPC.RAG_STATUS, (): RagStatus => {
    const s = loadRawSettings();
    const model = s.embeddingModel?.trim() || DEFAULT_EMBEDDING_MODEL;
    const ask = resolveAskConfig(s);
    const stale = new Set(planLibraryIndex(db, { embeddingModel: null, expectLayout: expectedLayoutFor(loadRawSettings()) }).items.filter(i => i.action === 'rechunk').map(i => i.source_id));
    return {
      askModel: ask?.model ?? null,
      askBaseUrl: ask?.baseUrl ?? null,
      embeddingsEnabled: !!s.embeddingsEnabled,
      embeddingModel: model,
      sources: listSources(db).map(src => {
        const st = chunkIndexStats(db, s.embeddingsEnabled ? model : undefined, src.id);
        return {
          source_id: src.id, title: src.title ?? src.filename, chunks: st.chunks, embedded: st.embedded,
          stale: stale.has(src.id),
        };
      }),
    };
  });

  // ─── Per-source RAG lock ────────────────────────────────────────────────
  // Serializes chunk/embedding work on one source across the library job, the
  // per-source Index button and Ask's lazy embedding. Ask never WAITS on a busy
  // source (it skips its embedding and says so); Index refuses; the library job
  // queues behind whoever holds it.
  const sourceLocks = new Map<number, Promise<unknown>>();
  function withSourceLock<T>(sourceId: number, fn: () => Promise<T>): Promise<T> {
    const prev = sourceLocks.get(sourceId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    sourceLocks.set(sourceId, tail);
    void tail.then(() => { if (sourceLocks.get(sourceId) === tail) sourceLocks.delete(sourceId); });
    return run;
  }
  const isSourceBusy = (sourceId: number) => sourceLocks.has(sourceId);

  // Re-segment a source file and reconcile its chunks only (candidates,
  // concepts and user data are untouched). Throws with a user-facing message.
  async function rebuildChunksForSource(sourceId: number): Promise<void> {
    const source = getSourceById(db, sourceId);
    if (!source) throw new Error('Source not found.');
    if (!fs.existsSync(source.file_path)) throw new Error('The source file no longer exists.');
    let blocks: Awaited<ReturnType<typeof segmentPdf>>['blocks'];
    let runningHeaderSections: Awaited<ReturnType<typeof segmentPdf>>['runningHeaderSections'] = [];
    let layoutVersion = LAYOUT_VERSION;
    if (source.file_path.endsWith('.txt')) {
      blocks = segmentText(fs.readFileSync(source.file_path, 'utf-8'));
    } else {
      const out = await segmentPdfConfigured(source.file_path, loadRawSettings());
      blocks = out.blocks;
      runningHeaderSections = out.runningHeaderSections;
      layoutVersion = out.layoutVersion;
    }
    const diag = syncRetrievalChunks(db, sourceId, blocks, runningHeaderSections, layoutVersion);
    if (typeof diag.error === 'string') throw new Error(diag.error);
  }

  // Backfill one source (Ask rail "Index" button).
  ipcMain.handle(IPC.RAG_INDEX_SOURCE, async (_e, rawId: unknown): Promise<RagIndexSourceResult> => {
    const sourceId = validateIpc(PositiveIntSchema, rawId, IPC.RAG_INDEX_SOURCE);
    if (isSourceBusy(sourceId)) return { ok: false, error: 'This source is already being indexed.' };
    try {
      await withSourceLock(sourceId, () => rebuildChunksForSource(sourceId));
      return { ok: true, chunks: chunkIndexStats(db, undefined, sourceId).chunks };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // ─── Whole-library index (user-started background job, never at startup) ──
  // Resumable by construction: chunks commit per source and vectors per batch,
  // so Stop (or quitting) keeps finished work and the next run skips it.
  let libraryJob: { stop: boolean; progress: LibraryIndexProgress | null } | null = null;
  let lastLibrarySummary: LibraryIndexSummary | null = null;
  const broadcast = (channel: string, payload: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(channel, payload);
  };

  ipcMain.handle(IPC.RAG_LIBRARY_STATUS, (): RagLibraryStatus => {
    const s = loadRawSettings();
    const model = s.embeddingModel?.trim() || DEFAULT_EMBEDDING_MODEL;
    const { items: _items, ...plan } = planLibraryIndex(db, { embeddingModel: s.embeddingsEnabled ? model : null, expectLayout: expectedLayoutFor(s) });
    return { running: libraryJob != null, progress: libraryJob?.progress ?? null, plan, last: lastLibrarySummary };
  });

  ipcMain.handle(IPC.RAG_LIBRARY_START, (): { ok: true } | { ok: false; error: string } => {
    if (libraryJob) return { ok: false, error: 'Library indexing is already running.' };
    const job: { stop: boolean; progress: LibraryIndexProgress | null } = { stop: false, progress: null };
    libraryJob = job;
    void runLibraryIndex(db, {
      rebuildChunks: rebuildChunksForSource,
      embedder: getEmbedder(),
      expectLayout: expectedLayoutFor(loadRawSettings()),
      withSourceLock,
      shouldStop: () => job.stop,
      onProgress: p => { job.progress = p; broadcast(IPC.RAG_LIBRARY_PROGRESS, p); },
    })
      .then(summary => {
        console.log(`[RAG_LIBRARY] ${JSON.stringify({ ...summary, failures: summary.failures.length })}`);
        lastLibrarySummary = summary;
      })
      .catch(err => {
        console.error('[RAG_LIBRARY] failed:', err);
        lastLibrarySummary = {
          stopped: true, sources_processed: 0, chunked: 0, rechunked: 0, embedded_chunks: 0,
          failures: [{ source_id: 0, title: '(library index)', stage: 'chunk', error: err instanceof Error ? err.message : String(err) }],
          embed_error: null,
        };
      })
      .finally(() => {
        libraryJob = null;
        broadcast(IPC.RAG_LIBRARY_DONE, lastLibrarySummary);
      });
    return { ok: true };
  });

  ipcMain.handle(IPC.RAG_LIBRARY_STOP, () => {
    if (libraryJob) libraryJob.stop = true;
    return { ok: true as const };
  });

  // Find-in-source "≈" mode. Read-only: never embeds passages or takes the
  // source lock. A hung embedding server gets 8s, then keyword matches.
  ipcMain.handle(IPC.RAG_SEARCH_SOURCE, async (_e, rawArgs: unknown) => {
    const { sourceId, query } = validateIpc(RagSourceSearchArgsSchema, rawArgs, IPC.RAG_SEARCH_SOURCE);
    const embedder = getEmbedder();
    const r = embedder
      ? await softTimeout(searchSourcePassages(db, sourceId, query, embedder), 8_000, null, 'source meaning search')
      : null;
    if (r) return r;
    const fallback = await searchSourcePassages(db, sourceId, query, null);
    return embedder && fallback.hits.length > 0
      ? { ...fallback, note: 'Embedding server did not respond, so these are keyword matches.' }
      : fallback;
  });

  ipcMain.handle(IPC.RAG_ASK, async (e, rawArgs: unknown) => {
    const args = validateIpc(RagAskArgsSchema, rawArgs, IPC.RAG_ASK);
    const concept = args.conceptId != null ? getConceptById(db, args.conceptId) : null;
    if (args.conceptId != null && !concept) throw new Error(`concept ${args.conceptId} not found`);
    const sourceIds = args.sourceIds?.length
      ? args.sourceIds
      : concept?.source_id != null ? [concept.source_id] : undefined;
    const embedder = getEmbedder();
    let indexWarning: string | null = null;
    if (embedder) {
      const ids = sourceIds ?? listSources(db).map(s => s.id);
      const busy: string[] = [];
      for (const id of ids) {
        // Never wait behind the library job: skip this source's lazy
        // embedding (its stored vectors are still searched) and say so.
        if (isSourceBusy(id)) { busy.push(getSourceById(db, id)?.title ?? String(id)); continue; }
        try {
          await withSourceLock(id, () => indexSourceChunkEmbeddings(db, embedder, id, (done, total) => {
            if (!e.sender.isDestroyed()) e.sender.send(IPC.RAG_PROGRESS, { phase: 'embedding', sourceId: id, done, total });
          }));
        } catch (err) {
          // Keep going: keyword retrieval still works and vectors already
          // stored stay usable. Stop trying further sources — the server is
          // most likely down and each attempt would fail the same way.
          indexWarning = `Embedding chunks failed (${err instanceof Error ? err.message : String(err)}); vector search may be partial or unavailable.`;
          console.warn('[RAG] chunk embedding failed:', err);
          break;
        }
      }
      if (busy.length && !indexWarning) {
        indexWarning = `Being indexed in the background: ${busy.join(', ')}. Vector search may be partial for ${busy.length === 1 ? 'it' : 'them'} until indexing finishes.`;
      }
    }
    const result = await askSources(db, {
      question: args.question,
      sourceIds,
      config: resolveAskConfig(loadRawSettings()),
      embedder,
      focus: concept?.name ?? null,
    });
    const full = { ...result, index_warning: indexWarning };
    if (!concept) return full;
    // Saving history must never cost the user the answer they just got.
    try {
      const entry = saveAskHistory(db, concept.id, full);
      return { ...full, history_id: entry.id };
    } catch (err) {
      console.warn('[RAG] saving Ask history failed:', err);
      return full;
    }
  });

  ipcMain.handle(IPC.RAG_HISTORY, (_e, rawId: unknown) =>
    listAskHistory(db, validateIpc(PositiveIntSchema, rawId, IPC.RAG_HISTORY)));

  ipcMain.handle(IPC.RAG_HISTORY_DELETE, (_e, rawId: unknown) => {
    deleteAskHistory(db, validateIpc(PositiveIntSchema, rawId, IPC.RAG_HISTORY_DELETE));
    return { ok: true as const };
  });

  ipcMain.handle(IPC.LLM_LIST_LOCAL_MODELS, async (_e, rawBaseUrl: unknown) => {
    if (typeof rawBaseUrl !== 'string' || rawBaseUrl.length > 300) {
      return { ok: false as const, error: 'Base URL must be a string.' };
    }
    try {
      return { ok: true as const, models: await listLocalModels(rawBaseUrl || DEFAULT_LOCAL_BASE_URL) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle(IPC.DOCLING_TEST, async (_e, rawBaseUrl: unknown) => {
    if (typeof rawBaseUrl !== 'string' || rawBaseUrl.length > 300) {
      return { ok: false as const, error: 'Base URL must be a string.' };
    }
    const base = rawBaseUrl.trim() ? normalizeLocalBaseUrl(rawBaseUrl) : DEFAULT_DOCLING_BASE_URL;
    if (!base) return { ok: false as const, error: 'Docling URL must be an http:// or https:// URL, e.g. http://127.0.0.1:5001' };
    try {
      return { ok: true as const, ...(await doclingServerInfo(base)) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle(IPC.SETTINGS_GET, (): SettingsSnapshot => {
    const s = loadEffectiveSettings();
    return {
      provider: s.provider,
      groqApiKeyConfigured:      !!s.groqApiKey,
      anthropicApiKeyConfigured: !!s.anthropicApiKey,
      modelOverrides: s.modelOverrides ?? {},
      extractionMode: s.extractionMode ?? 'deterministic',
      heavyModel: s.heavyModel ?? '',
      lightModel: s.lightModel ?? '',
      modelChoices: MODEL_CHOICES,
      gradeSelfConsistency: effectiveSelfConsistency(s),
      localBaseUrl: s.localBaseUrl ?? '',
      localModel: s.localModel ?? '',
      defaultLocalBaseUrl: DEFAULT_LOCAL_BASE_URL,
      embeddingsEnabled: !!s.embeddingsEnabled,
      embeddingModel: s.embeddingModel ?? '',
      defaultEmbeddingModel: DEFAULT_EMBEDDING_MODEL,
      srsScheduler: s.srsScheduler ?? 'sm2',
      pdfParser: s.pdfParser ?? 'builtin',
      doclingBaseUrl: s.doclingBaseUrl ?? '',
      defaultDoclingBaseUrl: DEFAULT_DOCLING_BASE_URL,
    };
  });
  ipcMain.handle(IPC.SETTINGS_SET, async (_e, rawInput: Partial<LLMSettings>) => {
    // Wait out an in-flight save so this patch merges onto its result.
    await settingsWrite;
    const current = loadRawSettings();
    // Validate structure first, then clamp enum values via sanitizeSettingsInput.
    const validated = validateIpc(SettingsPatchSchema, rawInput, IPC.SETTINGS_SET);
    // A non-empty base URL that isn't a usable http(s) URL is an error the user
    // must see (sanitize would otherwise silently keep the old one).
    if (validated.localBaseUrl && validated.localBaseUrl.trim() && !normalizeLocalBaseUrl(validated.localBaseUrl)) {
      throw new Error('Server base URL must be an http:// or https:// URL, e.g. http://127.0.0.1:11434/v1');
    }
    if (validated.doclingBaseUrl && validated.doclingBaseUrl.trim() && !normalizeLocalBaseUrl(validated.doclingBaseUrl)) {
      throw new Error('Docling URL must be an http:// or https:// URL, e.g. http://127.0.0.1:5001');
    }
    const input = sanitizeSettingsInput(validated, current);
    const next = mergeSettingsPatch(current, input);
    await persistSettings(next);
    setSrsScheduler(next.srsScheduler ?? 'sm2');
    return { ok: true as const };
  });
  ipcMain.handle(IPC.EVIDENCE_HISTORY, (_e, conceptId: number) => listRecordsByConcept(db, conceptId));
  ipcMain.handle(IPC.EVIDENCE_DELETE, (_e, recordId: number) => {
    deleteEvidenceRecord(db, validateIpc(PositiveIntSchema, recordId, IPC.EVIDENCE_DELETE));
    return { ok: true };
  });

  ipcMain.handle(IPC.CANDIDATES_BY_SOURCE, (_e, sourceId: number) => ({
    concepts:       listConceptCandidatesBySource(db, sourceId),
    relations:      listRelationCandidatesBySource(db, sourceId),
    misconceptions: listMisconceptionCandidatesBySource(db, sourceId),
    equations:      listEquationCandidatesBySource(db, sourceId),
  }));
  ipcMain.handle(IPC.CANDIDATES_PROMOTE, (_e, candidateId: number) => promoteCandidate(db, validateIpc(PositiveIntSchema, candidateId, IPC.CANDIDATES_PROMOTE)));
  ipcMain.handle(IPC.CANDIDATES_PROMOTE_BULK, (_e, candidateIds: number[]) => {
    validateIpc(IdArraySchema, candidateIds, IPC.CANDIDATES_PROMOTE_BULK);
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
    rejectCandidate(db, validateIpc(PositiveIntSchema, candidateId, IPC.CANDIDATES_REJECT));
    return { ok: true };
  });
  ipcMain.handle(IPC.CANDIDATES_REJECT_BULK, (_e, candidateIds: number[]) => rejectCandidatesBulk(db, validateIpc(IdArraySchema, candidateIds, IPC.CANDIDATES_REJECT_BULK)));
  ipcMain.handle(IPC.CANDIDATES_RELATION_CREATE, (_e, args: {
    sourceId: number; from: string; to: string; kind?: string; quote?: string; page?: number;
  }) => {
    validateIpc(RelationCandidateCreateArgsSchema, args, IPC.CANDIDATES_RELATION_CREATE);
    return createRelationCandidate(db, args.sourceId, {
      from: args.from,
      to: args.to,
      kind: toRelationKind(args.kind),
      quote: args.quote ?? '',
      page: Math.max(0, Math.floor(args.page ?? 0)),
    });
  });
  ipcMain.handle(IPC.CANDIDATES_RELATION_UPDATE, (_e, args: {
    id: number; from: string; to: string; kind?: string; quote?: string; page?: number;
  }) => {
    validateIpc(RelationCandidateUpdateArgsSchema, args, IPC.CANDIDATES_RELATION_UPDATE);
    return updateRelationCandidate(db, args.id, {
      from: args.from,
      to: args.to,
      kind: toRelationKind(args.kind),
      quote: args.quote ?? '',
      page: Math.max(0, Math.floor(args.page ?? 0)),
    });
  });
  ipcMain.handle(IPC.CANDIDATES_RELATION_DELETE, (_e, id: number) => {
    deleteRelationCandidate(db, id);
    return { ok: true as const };
  });
  ipcMain.handle(IPC.CANDIDATES_MISCONCEPTION_CREATE, (_e, args: {
    sourceId: number; quote: string; page?: number; section_path?: string[];
  }) => {
    validateIpc(MisconceptionCandidateCreateArgsSchema, args, IPC.CANDIDATES_MISCONCEPTION_CREATE);
    return createMisconceptionCandidate(db, args.sourceId, {
      quote: args.quote,
      page: Math.max(0, Math.floor(args.page ?? 0)),
      section_path: args.section_path ?? [],
    });
  });
  ipcMain.handle(IPC.CANDIDATES_MISCONCEPTION_UPDATE, (_e, args: {
    id: number; quote: string; page?: number; section_path?: string[];
  }) => {
    validateIpc(MisconceptionCandidateUpdateArgsSchema, args, IPC.CANDIDATES_MISCONCEPTION_UPDATE);
    return updateMisconceptionCandidate(db, args.id, {
      quote: args.quote,
      page: Math.max(0, Math.floor(args.page ?? 0)),
      section_path: args.section_path ?? [],
    });
  });
  ipcMain.handle(IPC.CANDIDATES_MISCONCEPTION_DELETE, (_e, id: number) => {
    deleteMisconceptionCandidate(db, id);
    return { ok: true as const };
  });
  ipcMain.handle(IPC.CANDIDATES_EQUATION_CREATE, (_e, args: {
    sourceId: number; latex: string; page?: number; variables?: string[]; section_path?: string[]; attached_term?: string | null;
  }) => {
    validateIpc(EquationCandidateCreateArgsSchema, args, IPC.CANDIDATES_EQUATION_CREATE);
    return createEquationCandidateForSource(db, {
      sourceId: args.sourceId,
      latex: args.latex,
      page: Math.max(0, Math.floor(args.page ?? 0)),
      variables: args.variables,
      section_path: args.section_path ?? [],
      attached_term: args.attached_term ?? null,
    });
  });
  ipcMain.handle(IPC.CANDIDATES_EQUATION_UPDATE, (_e, args: {
    id: number; latex: string; page?: number; variables?: string[]; section_path?: string[]; attached_term?: string | null;
  }) => {
    validateIpc(EquationCandidateUpdateArgsSchema, args, IPC.CANDIDATES_EQUATION_UPDATE);
    return updateEquationCandidate(db, args.id, {
      latex: args.latex,
      page: Math.max(0, Math.floor(args.page ?? 0)),
      variables: args.variables,
      section_path: args.section_path ?? [],
      attached_term: args.attached_term ?? null,
    });
  });
  ipcMain.handle(IPC.CANDIDATES_EQUATION_DELETE, (_e, id: number) => {
    deleteEquationCandidate(db, validateIpc(PositiveIntSchema, id, IPC.CANDIDATES_EQUATION_DELETE));
    return { ok: true as const };
  });
  ipcMain.handle(IPC.CANDIDATES_LLM_FILTER, async (e, rawArgs: CandidateLlmFilterArgs) => {
    const args = validateIpc(CandidateLlmFilterArgsSchema, rawArgs, IPC.CANDIDATES_LLM_FILTER);
    const source = getSourceById(db, args.sourceId);
    if (!source) throw new Error(`source ${args.sourceId} not found`);

    const config = cfgFor('concepts');
    const title = args.sourceTitle ?? source.title ?? source.filename;
    const deduped = dedupeByNormalized(args.candidates);

    // One topic-fit call over a batch → its decisions + the kept terms within it.
    async function runBatch(batch: typeof deduped): Promise<{ decisions: ReturnType<typeof parseCandidateLlmFilterResponse>; keepTerms: string[] }> {
      const { content } = await chatJSON(config, {
        responseFormat: 'json',
        temperature: 0,
        maxTokens: Math.min(1200, Math.max(220, batch.length * 12 + 120)),
        messages: [
          { role: 'system', content: 'You are a precise textbook concept filter. Return valid JSON only.' },
          { role: 'user', content: buildCandidateLlmFilterPrompt(title, batch) },
        ],
      }, 'topic_filter');
      const decisions = parseCandidateLlmFilterResponse(content);
      return { decisions, keepTerms: keptBatchTerms(batch, decisions) };
    }

    // Fast default: one compact 75-candidate call (well under low Groq TPM
    // tiers; the manual ChatGPT prompt is the large-list fallback).
    if (!args.fullCoverage) {
      const batch = deduped.slice(0, LLM_API_FILTER_LIMIT);
      if (batch.length === 0) return { provider: config.provider, model: config.model, sent: 0, keepTerms: [], decisions: [] };
      const { decisions, keepTerms } = await runBatch(batch);
      return { provider: config.provider, model: config.model, sent: batch.length, keepTerms, decisions };
    }

    // Full coverage: sequential, paced, bounded, fail-soft. chatJSON handles
    // per-call 429 backoff; the cap + deadline keep a big source from stalling,
    // and a batch that exhausts its retries stops the run with partial results
    // rather than discarding everything.
    const batches = chunkBatches(deduped, LLM_API_FILTER_LIMIT, LLM_FILTER_MAX_BATCHES);
    const total = batches.length;
    const deadline = Date.now() + LLM_FILTER_DEADLINE_MS;
    const keepSet = new Set<string>();
    const allDecisions: ReturnType<typeof parseCandidateLlmFilterResponse> = [];
    let sent = 0;
    let done = 0;
    for (const batch of batches) {
      if (Date.now() > deadline) break;
      try {
        const { decisions, keepTerms } = await runBatch(batch);
        allDecisions.push(...decisions);
        for (const t of keepTerms) keepSet.add(t);
        sent += batch.length;
      } catch (err) {
        console.error('[starcall:llmFilter] batch failed, returning partial results', err);
        break;
      }
      done += 1;
      e.sender.send(IPC.CANDIDATES_LLM_FILTER_PROGRESS, { done, total, sent });
      if (done < total && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, LLM_FILTER_BATCH_DELAY_MS));
      }
    }
    return { provider: config.provider, model: config.model, sent, keepTerms: [...keepSet], decisions: allDecisions, batches: done };
  });
  // Deterministic candidate re-extract for one source (the Re-extract button
  // and the bulk "re-extract outdated sources" job). Preserves promoted
  // concepts with evidence and concepts with study history. Records a parse
  // run (success or failure) stamped with the current parser/grammar/layout
  // versions, which is what takes the source off the outdated list.
  async function reextractSourceCandidates(sourceId: number): Promise<ExtractCandidatesResult & { parserFallback?: string | null }> {
    const source = getSourceById(db, sourceId);
    if (!source) throw new Error(`source ${sourceId} not found`);
    const fileExists = fs.existsSync(source.file_path);
    console.log(`[CANDIDATES] (manual) start source=${sourceId} path="${source.file_path}" exists=${fileExists}`);
    if (!fileExists) {
      throw new Error(`source file no longer exists: ${source.file_path}`);
    }
    const startedAt = Date.now();
    let pageCount = 0;
    let layoutDiagnostics: Record<string, unknown> = {};
    let layoutVersion = LAYOUT_VERSION;
    let parserFallback: string | null = null;
    const recordRun = (status: 'success' | 'failed', counts: Partial<Record<'blocks' | 'concepts' | 'relations' | 'equations' | 'misconceptions', number>>, errorMsg?: string) => {
      try {
        createParseRun(db, {
          source_id: sourceId, status, error_msg: errorMsg ?? null, mode: 'deterministic',
          page_count: pageCount, block_count: counts.blocks ?? 0, candidate_count: counts.concepts ?? 0,
          relation_count: counts.relations ?? 0, equation_count: counts.equations ?? 0,
          misconception_count: counts.misconceptions ?? 0, duration_ms: Date.now() - startedAt,
          llm_call_count: 0, llm_input_tokens: 0, llm_output_tokens: 0,
          diagnostics: { ...layoutDiagnostics, trigger: 'reextract' },
          layout_version: layoutVersion,
        });
      } catch (e) {
        console.error('[PARSE_RUN] failed to record parse_runs row:', e);
      }
    };
    try {
      let blocks: Awaited<ReturnType<typeof segmentPdf>>['blocks'];
      let runningHeaderSections: Awaited<ReturnType<typeof segmentPdf>>['runningHeaderSections'] = [];
      if (source.file_path.endsWith('.txt')) {
        blocks = segmentText(fs.readFileSync(source.file_path, 'utf-8'));
        console.log(`[CANDIDATES] (manual) text blocks=${blocks.length}`);
      } else {
        const out = await segmentPdfConfigured(source.file_path, loadRawSettings());
        blocks = out.blocks;
        runningHeaderSections = out.runningHeaderSections;
        pageCount = out.pageCount;
        layoutVersion = out.layoutVersion;
        parserFallback = out.fallback;
        layoutDiagnostics = { ...out.diagnostics, parser: out.parser, parser_fallback: out.fallback };
        console.log(`[CANDIDATES] (manual) pdf pages=${out.pageCount} blocks=${blocks.length}`);
      }
      const { paths: sectionPaths, sources: sectionSources } = buildSectionPath(blocks, runningHeaderSections);
      const anchors = deriveTopicAnchors(blocks, source.title);
      setTopicAnchors(db, sourceId, anchors);
      const cand = extractCandidates(blocks, sectionPaths, anchors, sectionSources, runningHeaderSections);
      persistCandidateExtraction(db, sourceId, cand);
      syncRetrievalChunks(db, sourceId, blocks, runningHeaderSections, layoutVersion);
      console.log(
        `[CANDIDATES] (manual) source=${sourceId} blocks=${cand.diagnostics.blocks_seen} ` +
        `concepts=${cand.candidates.length} relations=${cand.relations.length} ` +
        `misconceptions=${cand.misconception_phrases.length} equations=${cand.equations.length}`,
      );
      const result = {
        ok: true as const,
        blocks: cand.diagnostics.blocks_seen,
        concepts: cand.candidates.length,
        relations: cand.relations.length,
        misconceptions: cand.misconception_phrases.length,
        equations: cand.equations.length,
      };
      recordRun('success', result);
      return { ...result, parserFallback };
    } catch (e) {
      console.error('[CANDIDATES] (manual) re-extract failed:', e);
      recordRun('failed', {}, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  ipcMain.handle(IPC.CANDIDATES_EXTRACT, (_e, sourceId: number) =>
    withSourceLock(sourceId, () => reextractSourceCandidates(sourceId)));

  // Bulk "re-extract outdated sources": user-started only, one source at a
  // time under the per-source lock, Stop-able between sources, resumable
  // (finished sources record a current parse run and drop off the plan).
  let reextractJob: { stop: boolean; progress: ReextractProgress | null } | null = null;
  let lastReextractSummary: ReextractSummary | null = null;

  ipcMain.handle(IPC.REEXTRACT_STATUS, (): ReextractStatus => {
    const { items, ...plan } = planOutdatedSources(db, currentReextractVersions(), expectedLayoutFor(loadRawSettings()));
    return {
      running: reextractJob != null, progress: reextractJob?.progress ?? null,
      plan: { ...plan, items: items.map(i => ({ source_id: i.source_id, title: i.title, reasons: i.reasons })) },
      last: lastReextractSummary,
    };
  });

  ipcMain.handle(IPC.REEXTRACT_START, (): { ok: true } | { ok: false; error: string } => {
    if (reextractJob) return { ok: false, error: 'Re-extraction is already running.' };
    const job: { stop: boolean; progress: ReextractProgress | null } = { stop: false, progress: null };
    reextractJob = job;
    void runReextractOutdated(db, {
      reextract: async (id) => {
        const r = await reextractSourceCandidates(id);
        // Docling selected but unavailable: the source was re-extracted with the
        // built-in parser and still expects Docling, so report it as skipped.
        if (r.parserFallback) throw new Error(`Docling unavailable, used the built-in parser: ${r.parserFallback}`);
      },
      withSourceLock,
      expectLayout: expectedLayoutFor(loadRawSettings()),
      shouldStop: () => job.stop,
      onProgress: p => { job.progress = p; broadcast(IPC.REEXTRACT_PROGRESS, p); },
    })
      .then(summary => {
        console.log(`[REEXTRACT] ${JSON.stringify({ ...summary, failures: summary.failures.length })}`);
        lastReextractSummary = summary;
      })
      .catch(err => {
        console.error('[REEXTRACT] failed:', err);
        lastReextractSummary = {
          stopped: true, reextracted: 0,
          failures: [{ source_id: 0, title: '(re-extract)', error: err instanceof Error ? err.message : String(err) }],
        };
      })
      .finally(() => {
        reextractJob = null;
        broadcast(IPC.REEXTRACT_DONE, lastReextractSummary);
      });
    return { ok: true };
  });

  ipcMain.handle(IPC.REEXTRACT_STOP, () => {
    if (reextractJob) reextractJob.stop = true;
    return { ok: true as const };
  });

  ipcMain.handle(IPC.EVIDENCE_SUBMIT, async (_e, args: SubmitEvidenceArgs) => {
    const { taskId, conceptId, userResponse, confidenceBefore } = validateIpc(SubmitEvidenceArgsSchema, args, IPC.EVIDENCE_SUBMIT);
    const concept = getConceptById(db, conceptId);
    const task = listTasksByConcept(db, conceptId).find(t => t.id === taskId);
    if (!task || !concept) throw new Error('Task or concept not found');

    resetUsageStats();
    // Assemble the concept's source material so the grader can judge whether the
    // answer is BACKED BY the source, not merely plausible. When the concept is
    // too sparse (hasContext=false) we pass nothing and grounding is skipped.
    // Widen grounding with similar quotes from OTHER concepts in the same source
    // (opt-in embeddings; silently skipped when off, slow, or unreachable).
    const embedder = getEmbedder();
    const extraExcerpts = embedder
      ? await softTimeout((async () => {
          await indexSourceEmbeddings(db, embedder, concept.source_id);
          const hits = await retrieveSourceExcerpts(db, embedder, concept.source_id, userResponse, conceptId);
          return hits.map(h => h.text);
        })(), 8_000, [] as string[], 'grounding retrieval')
      : [];
    const grounding = buildGroundingContext(db, conceptId, extraExcerpts);
    const gradeSettings = loadEffectiveSettings();
    const grade = await gradeResponse(cfgFor('grader'), {
      concept_name: concept.name, concept_definition: concept.definition_text,
      task_kind: task.kind, task_prompt: task.prompt, user_response: userResponse,
      source_context: grounding.hasContext ? grounding.context : undefined,
    }, { selfConsistency: effectiveSelfConsistency(gradeSettings) });
    {
      const s = getUsageStats();
      const passes = Object.entries(s.byPass)
        .map(([k, v]) => `${k}=${v.total}(${v.calls})`)
        .join(' ');
      console.log(`[LLM TOTALS] grade concept=${conceptId} task=${taskId} ${passes} total=${s.total} calls=${s.calls}`);
    }

    // Record + mastery + SRS land atomically (persistGradedAttempt), so a failure
    // here never leaves a saved attempt behind the renderer's "nothing recorded".
    const record = persistGradedAttempt(db, {
      task_id: taskId, concept_id: conceptId, user_response: userResponse,
      score: grade.score, compression_stage: grade.compression_stage,
      gaps_detected: grade.gaps_detected, misconceptions_detected: grade.misconceptions_detected,
      grader_reasoning: grade.reasoning,
      task_prompt_snapshot: task.prompt,
      task_kind_snapshot: task.kind,
      task_difficulty_snapshot: task.difficulty,
      xp_awarded: calculateEligibleXpAward(db, conceptId, task.kind, task.difficulty, grade.score),
      grounding_score: grade.grounding_score,
      grounding_context_used: grade.grounding_context_used,
      unsupported_claims: grade.unsupported_claims,
      confidence_before: confidenceBefore ?? null,
    }, grade.audit);
    emitEvent(db, 'evidence_record.graded', { recordId: record.id, score: grade.score }, { entityType: 'concept', entityId: conceptId });
    return record;
  });
  ipcMain.handle(IPC.EVIDENCE_PROGRESS, () => getStudyProgress(db));
}

// ─── App lifecycle ─────────────────────────────────────────────────────────────

// Application name (used in OS process list, dock, notifications). Setting at
// module top so it applies before app.whenReady fires.
app.setName('StarcallOS');

// Content-Security-Policy applied to every renderer response. Electron's
// security guidance recommends `default-src 'self'` for loadFile apps; we relax
// the minimum the app actually needs: 'unsafe-inline' for the Vite inline
// bootstrap script and React/KaTeX inline styles, data:/blob: for user
// background/avatar media, and a blob: worker for pdf.js. connect-src stays
// 'self' so injected content can't exfiltrate — the renderer makes zero
// outbound HTTP (all network lives in main, reached over IPC). In dev the Vite
// server needs 'unsafe-eval' + a websocket for HMR.
function contentSecurityPolicy(): string {
  const dev = !!process.env['ELECTRON_RENDERER_URL'];
  const scriptSrc = dev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";
  const connectSrc = dev
    ? "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*"
    : "connect-src 'self'";
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    connectSrc,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

app.whenReady().then(async () => {
  // Disable the app-level menu entirely (kills the File/Edit/View/Window/Help bar).
  // Per-window calls (`removeMenu`, `setMenuBarVisibility(false)`) belt-and-suspender it.
  Menu.setApplicationMenu(null);

  // Dev-only: hydrate process.env from a local .env so the env-fallback keys
  // work in `pnpm dev`. No-op in a packaged build (keys come from Settings).
  loadDevDotenv();

  // Stamp a Content-Security-Policy on every renderer response.
  const csp = contentSecurityPolicy();
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  // Settings (incl. decrypted API keys) must be loaded before any IPC handler
  // or startup step reads them.
  await initSettings();

  const DB_PATH = path.join(app.getPath('userData'), 'stellaria.db');
  const db = openDb(DB_PATH);
  // Persist every chatJSON call's metadata (never prompt text) to llm_calls.
  setLlmTraceSink(createLlmCallSink(db));
  setSrsScheduler(loadRawSettings().srsScheduler ?? 'sm2');

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
app.on('will-quit', () => stopPdfParser());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
