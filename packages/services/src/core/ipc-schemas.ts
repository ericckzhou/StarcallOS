import { z } from 'zod';

// ─── Primitives ───────────────────────────────────────────────────────────────

const positiveInt = z.number().int().positive();
const nonnegInt   = z.number().int().nonnegative();
const shortStr    = (max = 500)    => z.string().max(max);
const longStr     = (max = 50_000) => z.string().max(max);

// ─── Enum schemas ─────────────────────────────────────────────────────────────

const providerIdSchema        = z.enum(['groq', 'anthropic']);
const extractionModeSchema    = z.enum(['deterministic', 'candidate_gated', 'full']);
const conceptImportanceSchema = z.enum(['foundational', 'core', 'supporting', 'peripheral', 'reference_only']);
const annotationTypeSchema    = z.enum(['highlight', 'note']);
const annotationScopeSchema   = z.enum(['source', 'concept']);
const annotationProvenanceSchema = z.enum(['manual_selection', 'manual_note', 'evidence_quote']);

// ─── Shared sub-schemas ───────────────────────────────────────────────────────

// Normalized (0–1, fraction of page) highlight/note rectangle. Must match
// PdfAnnotationRect in domain/types.ts — the renderer sends { x, y, width,
// height }, NOT x1/y1/x2/y2.
const pdfRectSchema = z.object({
  x: z.number(), y: z.number(), width: z.number(), height: z.number(),
});

const constellationLinkSchema = z.union([
  z.string().max(300),
  z.object({ name: shortStr(300), reason: shortStr(1_000), targetId: positiveInt.optional() }),
]);

const candidateFilterItemSchema = z.object({
  term:            shortStr(300),
  normalized:      shortStr(300),
  mention_count:   z.number(),
  first_page:      z.number(),
  final_score:     z.number().nullable().optional(),
  confidence:      z.number().optional(),
  signals:         z.array(z.string()).optional(),
  labels:          z.array(z.string()).optional(),
  context_snippet: z.string().nullable().optional(),
});

// ─── Handler arg schemas ──────────────────────────────────────────────────────

export const PositiveIntSchema = positiveInt;

export const CreateSourceArgsSchema = z.object({
  filePath:  z.string().optional(),
  filePaths: z.array(z.string()).max(200).optional(),
  title:     shortStr(500).optional(),
  author:    shortStr(500).optional(),
});

export const ProcessSourceArgsSchema = z.object({
  sourceId:  positiveInt,
  pageStart: nonnegInt.optional(),
  pageEnd:   nonnegInt.optional(),
});

export const CreateTextSourceArgsSchema = z.object({
  text:  z.string().min(1).max(500_000),
  title: shortStr(500).optional(),
});

export const ImportDocsArgsSchema = z.object({
  paths: z.array(z.string().min(1)).max(50).optional(),
});

export const ImportUrlArgsSchema = z.object({
  // http/https only — the main handler fetches this, so reject other schemes
  // (file:, data:, etc.) at the boundary.
  url:   z.string().url().max(2_000).refine(
    u => /^https?:\/\//i.test(u),
    { message: 'Only http/https URLs are supported' },
  ),
  title: shortStr(500).optional(),
});

export const SettingsPatchSchema = z.object({
  provider:        providerIdSchema.optional(),
  groqApiKey:      z.string().max(300).optional(),
  anthropicApiKey: z.string().max(300).optional(),
  modelOverrides:  z.record(z.string(), z.string().max(200)).optional(),
  extractionMode:  extractionModeSchema.optional(),
  heavyModel:      z.string().max(200).optional(),
  lightModel:      z.string().max(200).optional(),
});

export const SubmitEvidenceArgsSchema = z.object({
  taskId:       positiveInt,
  conceptId:    positiveInt,
  userResponse: z.string().min(1).max(10_000),
});

export const CandidateLlmFilterArgsSchema = z.object({
  sourceId:    positiveInt,
  sourceTitle: shortStr(500).optional(),
  // The renderer sends the full visible candidate list; the main handler dedupes
  // and slices it to LLM_API_FILTER_LIMIT before any LLM call, so this is just a
  // sanity bound on the payload (large sources can have >1000 candidates).
  candidates:  z.array(candidateFilterItemSchema).max(10_000),
  fullCoverage: z.boolean().optional(),
});

export const UpdateConceptFieldsArgsSchema = z.object({
  conceptId:       positiveInt,
  definition_text: longStr(10_000).optional(),
  why_exists:      longStr(5_000).optional(),
  what_breaks:     longStr(5_000).optional(),
  where_reappears: z.array(constellationLinkSchema).optional(),
  importance:      conceptImportanceSchema.optional(),
  tags:            z.array(shortStr(100)).max(50).optional(),
});

export const CreatePdfAnnotationArgsSchema = z.object({
  sourceId:    positiveInt,
  conceptId:   positiveInt.nullable().optional(),
  scope:       annotationScopeSchema.optional(),
  type:        annotationTypeSchema,
  createdFrom: annotationProvenanceSchema,
  page:        nonnegInt,
  color:       shortStr(50).optional(),
  selectedText: longStr(5_000).optional(),
  label:        shortStr(1_000).optional(),
  noteBody:     longStr(10_000).optional(),
  rects:        z.array(pdfRectSchema).max(100),
  pageWidth:    z.number().positive().nullable().optional(),
  pageHeight:   z.number().positive().nullable().optional(),
  rotation:     z.number().nullable().optional(),
});

export const UpdatePdfAnnotationArgsSchema = z.object({
  id:         positiveInt,
  label:      shortStr(1_000).optional(),
  noteBody:   longStr(10_000).optional(),
  color:      shortStr(50).optional(),
  rects:      z.array(pdfRectSchema).max(100).optional(),
  pageWidth:  z.number().positive().nullable().optional(),
  pageHeight: z.number().positive().nullable().optional(),
  rotation:   z.number().nullable().optional(),
});

export const ExportConceptArgsSchema = z.object({
  conceptId: positiveInt,
  format:    z.enum(['markdown', 'anki']),
});

export const ExportBundleArgsSchema = z
  .object({
    scope:    z.enum(['source', 'library']),
    sourceId: positiveInt.optional(),
    format:   z.enum(['markdown', 'anki']),
  })
  // A source-scoped export must name the source; a library export must not.
  .refine(a => (a.scope === 'source' ? a.sourceId != null : a.sourceId == null), {
    message: 'sourceId is required for scope "source" and forbidden for scope "library"',
    path: ['sourceId'],
  });

// ─── Validation helper ────────────────────────────────────────────────────────

export function validateIpc<T>(schema: z.ZodType<T>, value: unknown, channel: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const msg = result.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`IPC [${channel}] validation error: ${msg}`);
  }
  return result.data;
}
