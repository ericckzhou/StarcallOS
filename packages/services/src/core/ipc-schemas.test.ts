import { describe, expect, it } from 'vitest';
import {
  validateIpc,
  PositiveIntSchema,
  ImportUrlArgsSchema,
  ExportBundleArgsSchema,
  CreateTextSourceArgsSchema,
  ExportConceptArgsSchema,
  SubmitEvidenceArgsSchema,
  ImportDocsArgsSchema,
  IdArraySchema,
  HubCreateArgsSchema,
  NoteCreateArgsSchema,
  AddEvidenceArgsSchema,
  RelationCandidateCreateArgsSchema,
  LlmFilterSetArgsSchema,
  RenameConceptArgsSchema,
} from './ipc-schemas';

describe('validateIpc', () => {
  it('returns the parsed value on success', () => {
    expect(validateIpc(PositiveIntSchema, 7, 'test:channel')).toBe(7);
  });

  it('throws an error tagged with the channel and the field path on failure', () => {
    expect(() => validateIpc(PositiveIntSchema, -1, 'test:channel')).toThrow(/IPC \[test:channel\]/);
  });
});

describe('PositiveIntSchema', () => {
  it('accepts positive integers', () => {
    expect(PositiveIntSchema.safeParse(1).success).toBe(true);
  });

  it('rejects zero, negatives, and non-integers', () => {
    expect(PositiveIntSchema.safeParse(0).success).toBe(false);
    expect(PositiveIntSchema.safeParse(-3).success).toBe(false);
    expect(PositiveIntSchema.safeParse(1.5).success).toBe(false);
    expect(PositiveIntSchema.safeParse('1').success).toBe(false);
  });
});

describe('ImportUrlArgsSchema', () => {
  it('accepts http and https URLs', () => {
    expect(ImportUrlArgsSchema.safeParse({ url: 'https://example.com/page' }).success).toBe(true);
    expect(ImportUrlArgsSchema.safeParse({ url: 'http://example.com' }).success).toBe(true);
  });

  it('rejects non-http(s) schemes at the boundary', () => {
    expect(ImportUrlArgsSchema.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(ImportUrlArgsSchema.safeParse({ url: 'data:text/html,<script>' }).success).toBe(false);
    expect(ImportUrlArgsSchema.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('rejects strings that are not URLs', () => {
    expect(ImportUrlArgsSchema.safeParse({ url: 'not a url' }).success).toBe(false);
  });
});

describe('ExportBundleArgsSchema', () => {
  it('requires sourceId for a source-scoped export', () => {
    expect(ExportBundleArgsSchema.safeParse({ scope: 'source', sourceId: 3, format: 'markdown' }).success).toBe(true);
    expect(ExportBundleArgsSchema.safeParse({ scope: 'source', format: 'markdown' }).success).toBe(false);
  });

  it('forbids sourceId for a library-scoped export', () => {
    expect(ExportBundleArgsSchema.safeParse({ scope: 'library', format: 'anki' }).success).toBe(true);
    expect(ExportBundleArgsSchema.safeParse({ scope: 'library', sourceId: 3, format: 'anki' }).success).toBe(false);
  });
});

describe('CreateTextSourceArgsSchema', () => {
  it('accepts non-empty text with an optional title', () => {
    expect(CreateTextSourceArgsSchema.safeParse({ text: 'hello' }).success).toBe(true);
  });

  it('rejects empty text', () => {
    expect(CreateTextSourceArgsSchema.safeParse({ text: '' }).success).toBe(false);
  });
});

describe('ExportConceptArgsSchema', () => {
  it('accepts the markdown and anki formats', () => {
    expect(ExportConceptArgsSchema.safeParse({ conceptId: 1, format: 'markdown' }).success).toBe(true);
    expect(ExportConceptArgsSchema.safeParse({ conceptId: 1, format: 'anki' }).success).toBe(true);
  });

  it('rejects an unknown format', () => {
    expect(ExportConceptArgsSchema.safeParse({ conceptId: 1, format: 'pdf' }).success).toBe(false);
  });
});

describe('SubmitEvidenceArgsSchema', () => {
  it('requires positive ids and a non-empty response', () => {
    expect(
      SubmitEvidenceArgsSchema.safeParse({ taskId: 1, conceptId: 2, userResponse: 'because' }).success,
    ).toBe(true);
  });

  it('rejects an empty response or a non-positive id', () => {
    expect(SubmitEvidenceArgsSchema.safeParse({ taskId: 1, conceptId: 2, userResponse: '' }).success).toBe(false);
    expect(SubmitEvidenceArgsSchema.safeParse({ taskId: 0, conceptId: 2, userResponse: 'x' }).success).toBe(false);
  });
});

describe('ImportDocsArgsSchema', () => {
  it('treats paths as optional (dialog fallback)', () => {
    expect(ImportDocsArgsSchema.safeParse({}).success).toBe(true);
  });

  it('rejects empty path strings', () => {
    expect(ImportDocsArgsSchema.safeParse({ paths: [''] }).success).toBe(false);
  });
});

// ─── Remaining mutating-handler schemas (added with the IPC-validation pass) ────

describe('IdArraySchema', () => {
  it('accepts an array of positive ids', () => {
    expect(IdArraySchema.safeParse([1, 2, 3]).success).toBe(true);
    expect(IdArraySchema.safeParse([]).success).toBe(true);
  });

  it('rejects non-positive or non-integer ids', () => {
    expect(IdArraySchema.safeParse([1, 0]).success).toBe(false);
    expect(IdArraySchema.safeParse([1, -2]).success).toBe(false);
    expect(IdArraySchema.safeParse([1.5]).success).toBe(false);
    expect(IdArraySchema.safeParse(['1']).success).toBe(false);
  });
});

describe('HubCreateArgsSchema', () => {
  it('accepts a name with optional color/description/members/parent', () => {
    expect(HubCreateArgsSchema.safeParse({ name: 'Optimizers' }).success).toBe(true);
    expect(HubCreateArgsSchema.safeParse({ name: 'X', color: '#fff', conceptIds: [1, 2], parentHubId: 3 }).success).toBe(true);
    expect(HubCreateArgsSchema.safeParse({ name: 'Top-level', parentHubId: null }).success).toBe(true);
  });

  it('rejects a missing name or a non-positive parent/member id', () => {
    expect(HubCreateArgsSchema.safeParse({}).success).toBe(false);
    expect(HubCreateArgsSchema.safeParse({ name: 'X', parentHubId: 0 }).success).toBe(false);
    expect(HubCreateArgsSchema.safeParse({ name: 'X', conceptIds: [0] }).success).toBe(false);
  });
});

describe('NoteCreateArgsSchema', () => {
  it('requires a conceptId and a heading; body is optional', () => {
    expect(NoteCreateArgsSchema.safeParse({ conceptId: 1, heading: 'h' }).success).toBe(true);
    expect(NoteCreateArgsSchema.safeParse({ conceptId: 1, heading: 'h', body: 'b' }).success).toBe(true);
  });

  it('rejects a missing heading or a bad conceptId', () => {
    expect(NoteCreateArgsSchema.safeParse({ conceptId: 1 }).success).toBe(false);
    expect(NoteCreateArgsSchema.safeParse({ conceptId: 0, heading: 'h' }).success).toBe(false);
  });
});

describe('AddEvidenceArgsSchema', () => {
  it('accepts a span with the required fields (page may be 0)', () => {
    expect(AddEvidenceArgsSchema.safeParse({ conceptId: 1, page: 0, kind: 'highlight', label: 'L' }).success).toBe(true);
    expect(AddEvidenceArgsSchema.safeParse({ conceptId: 1, page: 4, kind: 'definition', label: 'L', quote: 'q', annotationId: 9 }).success).toBe(true);
  });

  it('rejects a non-positive conceptId or a non-positive annotationId', () => {
    expect(AddEvidenceArgsSchema.safeParse({ conceptId: 0, page: 1, kind: 'x', label: 'L' }).success).toBe(false);
    expect(AddEvidenceArgsSchema.safeParse({ conceptId: 1, page: 1, kind: 'x', label: 'L', annotationId: 0 }).success).toBe(false);
  });
});

describe('RelationCandidateCreateArgsSchema', () => {
  it('accepts a source-scoped relation with optional kind/quote/page', () => {
    expect(RelationCandidateCreateArgsSchema.safeParse({ sourceId: 1, from: 'A', to: 'B' }).success).toBe(true);
    expect(RelationCandidateCreateArgsSchema.safeParse({ sourceId: 1, from: 'A', to: 'B', kind: 'requires', quote: 'q', page: 2 }).success).toBe(true);
  });

  it('rejects a missing endpoint or a bad sourceId', () => {
    expect(RelationCandidateCreateArgsSchema.safeParse({ sourceId: 1, from: 'A' }).success).toBe(false);
    expect(RelationCandidateCreateArgsSchema.safeParse({ sourceId: 0, from: 'A', to: 'B' }).success).toBe(false);
  });
});

describe('LlmFilterSetArgsSchema', () => {
  it('accepts a term list or an explicit null (clear)', () => {
    expect(LlmFilterSetArgsSchema.safeParse({ sourceId: 1, keepTerms: ['a', 'b'] }).success).toBe(true);
    expect(LlmFilterSetArgsSchema.safeParse({ sourceId: 1, keepTerms: null }).success).toBe(true);
  });

  it('rejects a missing keepTerms field', () => {
    expect(LlmFilterSetArgsSchema.safeParse({ sourceId: 1 }).success).toBe(false);
  });
});

describe('RenameConceptArgsSchema', () => {
  it('requires a positive conceptId and a name', () => {
    expect(RenameConceptArgsSchema.safeParse({ conceptId: 1, name: 'New name' }).success).toBe(true);
    expect(RenameConceptArgsSchema.safeParse({ conceptId: 1 }).success).toBe(false);
  });
});
