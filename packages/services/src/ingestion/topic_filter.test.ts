import { describe, expect, it } from 'vitest';
import { buildCandidateLlmFilterPrompt, extractJsonObject, keptBatchTerms, parseCandidateLlmFilterResponse, topicFilterKey } from './topic_filter';

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

  it('falls back to a placeholder title', () => {
    expect(buildCandidateLlmFilterPrompt(undefined, [])).toContain('Book title: "(unknown source title)"');
  });

  it('extracts unfenced JSON surrounded by prose', () => {
    expect(extractJsonObject('Here is the result: {"keep":["a"]} Hope that helps.')).toBe('{"keep":["a"]}');
    expect(parseCandidateLlmFilterResponse('{"keep":[]}')).toEqual([]);
  });

  it('throws on non-JSON output', () => {
    expect(() => parseCandidateLlmFilterResponse('I cannot help with that.')).toThrow();
  });

  it('keptBatchTerms matches loosely, drops unsent terms and rejects, and dedupes', () => {
    const batch = [{ normalized: 'gradient descent' }, { normalized: 'Learning Rate' }, { normalized: 'basis' }];
    const kept = keptBatchTerms(batch, [
      { term: ' Gradient  Descent ', keep: true },
      { term: 'gradient descent', keep: true },
      { term: 'learning rate', keep: true },
      { term: 'basis', keep: false },
      { term: 'hallucinated term', keep: true },
    ]);
    expect(kept).toEqual(['gradient descent', 'learning rate']);
    expect(topicFilterKey('A\n b')).toBe('a b');
  });
});
