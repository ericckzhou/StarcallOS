import { describe, expect, it } from 'vitest';
import { buildCandidateLlmFilterPrompt, parseCandidateLlmFilterResponse } from './topic_filter';

describe('topic_filter', () => {
  it('builds a term-per-line prompt with the title', () => {
    const p = buildCandidateLlmFilterPrompt('Linear Algebra', [{ normalized: 'eigenvalue' }, { normalized: 'basis' }]);
    expect(p).toContain('Book title: "Linear Algebra"');
    expect(p).toContain('eigenvalue\nbasis');
  });

  it('parses the keep-list form, including fenced output with prose', () => {
    const d = parseCandidateLlmFilterResponse('Sure!\n```json\n{"keep":["eigenvalue", 3]}\n```');
    expect(d).toEqual([{ term: 'eigenvalue', keep: true }]);
  });

  it('parses the legacy decisions form and drops malformed rows', () => {
    const d = parseCandidateLlmFilterResponse('{"decisions":[{"term":"a","keep":false,"reason":"generic"},{"term":"b"}]}');
    expect(d).toEqual([{ term: 'a', keep: false, reason: 'generic' }]);
  });

  it('throws when neither array is present', () => {
    expect(() => parseCandidateLlmFilterResponse('{"x":1}')).toThrow();
  });
});
