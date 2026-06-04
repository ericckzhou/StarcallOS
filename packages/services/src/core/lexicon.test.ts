import { describe, expect, it } from 'vitest';
import {
  ACRONYM_TO_EXPANSION,
  EXPANSION_TO_CANONICAL,
  DOMAIN_TERMS,
  GENERIC_BAD_TERMS,
} from './lexicon';

describe('acronym alias map', () => {
  it('resolves each acronym and its expansion to the same canonical form', () => {
    for (const [acronym, expansion] of Object.entries(ACRONYM_TO_EXPANSION)) {
      expect(EXPANSION_TO_CANONICAL.get(acronym)).toBe(expansion);
      expect(EXPANSION_TO_CANONICAL.get(expansion)).toBe(expansion);
    }
  });

  it('collapses singular/plural acronyms onto one canonical', () => {
    expect(ACRONYM_TO_EXPANSION['llm']).toBe('large language model');
    expect(ACRONYM_TO_EXPANSION['llms']).toBe('large language model');
    expect(ACRONYM_TO_EXPANSION['rag']).toBe('retrieval augmented generation');
  });

  it('stores all acronym keys and expansions in lowercase', () => {
    for (const [acronym, expansion] of Object.entries(ACRONYM_TO_EXPANSION)) {
      expect(acronym).toBe(acronym.toLowerCase());
      expect(expansion).toBe(expansion.toLowerCase());
    }
  });
});

describe('term lexicons', () => {
  it('expose non-empty, lowercase term sets', () => {
    expect(DOMAIN_TERMS.size).toBeGreaterThan(0);
    expect(GENERIC_BAD_TERMS.size).toBeGreaterThan(0);
    for (const t of DOMAIN_TERMS) expect(t).toBe(t.toLowerCase());
    for (const t of GENERIC_BAD_TERMS) expect(t).toBe(t.toLowerCase());
  });

  it('classify representative terms correctly', () => {
    expect(DOMAIN_TERMS.has('gradient')).toBe(true);
    expect(GENERIC_BAD_TERMS.has('thing')).toBe(true);
  });
});
