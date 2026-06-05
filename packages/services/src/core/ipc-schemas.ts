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

// ─── Remaining mutating-handler schemas ────────────────────────────────────────
// These guard the rest of the write-path IPC surface. Kept permissive (generous
// bounds, clamped numerics left as plain numbers, no `.strict()`) so they reject
// only genuinely malformed input — callers validate for the throw, then use their
// original typed args, so a narrow schema can never strip a field.

const idArray   = z.array(positiveInt).max(10_000);
const colorStr  = z.string().max(50);
const kindStr   = z.string().max(50);
const sectionPath = z.array(shortStr(500)).max(200);

export const IdArraySchema = idArray;

export const CreateManualConceptArgsSchema = z.object({
  sourceId:        positiveInt,
  name:            shortStr(500),
  importance:      z.string().max(50).optional(),
  definition_text: longStr(10_000).optional(),
  why_exists:      longStr(5_000).optional(),
  what_breaks:     longStr(5_000).optional(),
});

export const RenameConceptArgsSchema = z.object({ conceptId: positiveInt, name: shortStr(500) });
export const SetReviewedArgsSchema   = z.object({ conceptId: positiveInt, reviewed: z.boolean() });

export const ConceptEquationCreateArgsSchema = z.object({
  conceptId: positiveInt, latex: longStr(5_000), page: z.number().optional(),
  variables: z.array(shortStr(200)).max(500).optional(),
});
export const ConceptEquationUpdateArgsSchema = z.object({
  equationId: positiveInt, latex: longStr(5_000), page: z.number().optional(),
  variables: z.array(shortStr(200)).max(500).optional(),
});

export const NoteCreateArgsSchema  = z.object({ conceptId: positiveInt, heading: shortStr(1_000), body: longStr(20_000).optional() });
export const NoteUpdateArgsSchema  = z.object({ id: positiveInt, heading: shortStr(1_000).optional(), body: longStr(20_000).optional(), linkedAnnotationId: positiveInt.nullable().optional() });
export const NoteReorderArgsSchema = z.object({ conceptId: positiveInt, orderedIds: idArray });

const evidenceKind = z.string().max(50);
export const DeleteEvidenceSpanArgsSchema    = z.object({ conceptId: positiveInt, page: z.number(), kind: evidenceKind, quote: longStr(5_000) });
export const AddEvidenceArgsSchema           = z.object({ conceptId: positiveInt, page: z.number(), kind: evidenceKind, label: shortStr(1_000), quote: longStr(5_000).optional(), annotationId: positiveInt.optional() });
export const UpdateEvidenceArgsSchema        = z.object({ conceptId: positiveInt, index: nonnegInt, page: z.number().optional(), kind: evidenceKind.optional(), label: shortStr(1_000).optional(), quote: longStr(5_000).optional() });
export const DeleteEvidenceByIndexArgsSchema = z.object({ conceptId: positiveInt, index: nonnegInt });

export const LlmFilterSetArgsSchema = z.object({ sourceId: positiveInt, keepTerms: z.array(shortStr(300)).max(10_000).nullable() });

export const HubCreateArgsSchema   = z.object({ name: shortStr(200), color: colorStr.optional(), description: longStr(2_000).optional(), conceptIds: idArray.optional(), parentHubId: positiveInt.nullable().optional() });
export const HubUpdateArgsSchema   = z.object({ id: positiveInt, name: shortStr(200).optional(), color: colorStr.optional(), description: longStr(2_000).optional(), parentHubId: positiveInt.nullable().optional() });
export const HubAddMembersArgsSchema = z.object({ hubId: positiveInt, conceptIds: idArray });
export const HubMemberArgsSchema     = z.object({ hubId: positiveInt, conceptId: positiveInt });
export const HubSetMemberRoleArgsSchema = z.object({ hubId: positiveInt, conceptId: positiveInt, role: z.string().max(50) });
export const HubEdgeCreateArgsSchema = z.object({ aHubId: positiveInt, bHubId: positiveInt, label: shortStr(300).optional(), directed: z.boolean().optional() });
export const HubEdgeUpdateArgsSchema = z.object({ id: positiveInt, label: shortStr(300).optional(), directed: z.boolean().optional() });

export const RelationCandidateCreateArgsSchema = z.object({ sourceId: positiveInt, from: shortStr(500), to: shortStr(500), kind: kindStr.optional(), quote: longStr(5_000).optional(), page: z.number().optional() });
export const RelationCandidateUpdateArgsSchema = z.object({ id: positiveInt, from: shortStr(500), to: shortStr(500), kind: kindStr.optional(), quote: longStr(5_000).optional(), page: z.number().optional() });
export const MisconceptionCandidateCreateArgsSchema = z.object({ sourceId: positiveInt, quote: longStr(5_000), page: z.number().optional(), section_path: sectionPath.optional() });
export const MisconceptionCandidateUpdateArgsSchema = z.object({ id: positiveInt, quote: longStr(5_000), page: z.number().optional(), section_path: sectionPath.optional() });
export const EquationCandidateCreateArgsSchema = z.object({ sourceId: positiveInt, latex: longStr(5_000), page: z.number().optional(), variables: z.array(shortStr(200)).max(500).optional(), section_path: sectionPath.optional(), attached_term: shortStr(500).nullable().optional() });
export const EquationCandidateUpdateArgsSchema = z.object({ id: positiveInt, latex: longStr(5_000), page: z.number().optional(), variables: z.array(shortStr(200)).max(500).optional(), section_path: sectionPath.optional(), attached_term: shortStr(500).nullable().optional() });

// ─── Prerequisite engine (migration 0028) ─────────────────────────────────────
// Only the two dependency-bearing edge kinds are user-curatable as prerequisites.
const prereqEdgeType = z.enum(['requires', 'enables']);
const suggestionStatus = z.enum(['pending', 'accepted', 'dismissed']);

// Manual edge create/delete. The self-edge ban is enforced here at the IPC
// boundary (in addition to the DB CHECK and the createEdge repo guard).
export const ConceptEdgeArgsSchema = z
  .object({ fromId: positiveInt, toId: positiveInt, edgeType: prereqEdgeType })
  .refine(a => a.fromId !== a.toId, {
    message: 'fromId and toId must differ (a concept cannot require/enable itself)',
    path: ['toId'],
  });

export const PrereqSuggestionsListArgsSchema = z.object({
  sourceId: positiveInt,
  status:   suggestionStatus.optional(),
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
