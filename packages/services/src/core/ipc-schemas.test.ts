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
