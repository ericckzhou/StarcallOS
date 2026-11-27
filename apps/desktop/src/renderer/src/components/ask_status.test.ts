import { describe, expect, it } from 'vitest';
import { isLegacy, LEGACY_GROUNDED, STATUS_META, statusMeta } from './ask_status';

const V2 = { version: 2, quotes: 'verbatim', claim_citations: 'per_sentence', claim_support: 'lexical_overlap', entailment: 'not_checked' } as const;

describe('Ask status labels', () => {
  it('a current grounded answer reads "Citations verified"', () => {
    expect(statusMeta({ status: 'grounded', answer: 'x', verification: V2 }).label).toBe('Citations verified');
  });

  it('a pre-v2 history answer never inherits "Citations verified"', () => {
    const legacy = { status: 'grounded' as const, answer: 'x', verification: undefined };
    expect(isLegacy(legacy)).toBe(true);
    expect(statusMeta(legacy)).toBe(LEGACY_GROUNDED);
    expect(statusMeta(legacy).label).not.toBe(STATUS_META.grounded.label);
  });

  it('other legacy statuses keep their label (their meaning did not get stronger)', () => {
    expect(statusMeta({ status: 'partial', answer: 'x', verification: undefined })).toBe(STATUS_META.partial);
    expect(statusMeta({ status: 'unsupported', answer: 'x', verification: undefined })).toBe(STATUS_META.unsupported);
  });

  it('answer-less results are not "legacy" (nothing was verified either way)', () => {
    expect(isLegacy({ answer: null, verification: undefined })).toBe(false);
    expect(statusMeta({ status: 'no_passages', answer: null, verification: undefined })).toBe(STATUS_META.no_passages);
  });
});
