import { describe, expect, it } from 'vitest';
import {
  buildTopicFitPrompt,
  classifyBucket,
  parseTopicFitJson,
  passesBulkPromoteGate,
  type ConceptCandidate,
} from './shared';

function candidate(input: Partial<ConceptCandidate> & { term?: string } = {}): ConceptCandidate {
  return {
    id: 1,
    source_id: 1,
    term: input.term ?? 'Gradient Descent',
    normalized: input.normalized ?? 'gradient descent',
    confidence: input.confidence ?? 0.95,
    mention_count: input.mention_count ?? 3,
    first_page: input.first_page ?? 4,
    section_path: input.section_path ?? [],
    evidence: input.evidence ?? [{ source: 'definition_pattern', quote: 'Gradient Descent is defined as optimization.', page: 4 }],
    signals: input.signals ?? ['definition_pattern'],
    topic_relevance_score: input.topic_relevance_score ?? 0.75,
    topic_relevance_reasons: input.topic_relevance_reasons ?? [],
    is_boilerplate: input.is_boilerplate ?? false,
    is_broad: input.is_broad ?? false,
    typography_score: input.typography_score ?? 0.7,
    signal_score: input.signal_score ?? 0.9,
    quality_score: input.quality_score ?? 0.8,
    context_score: input.context_score ?? 0.75,
    final_score: input.final_score ?? 0.86,
    labels: input.labels ?? ['defined_term', 'large_font'],
    typography_signals: input.typography_signals ?? { fontSizeRatio: 1.35, isBold: true },
    context_snippet: input.context_snippet ?? 'Gradient Descent is defined as optimization.',
    parser_diagnostics: input.parser_diagnostics ?? {},
    created_at: input.created_at ?? '2026-01-01 00:00:00',
  };
}

describe('candidate shared helpers', () => {
  it('classifies quality flags before confidence bands', () => {
    expect(classifyBucket(candidate({ is_boilerplate: true }))).toBe('boilerplate');
    expect(classifyBucket(candidate({ is_broad: true }))).toBe('broad');
    expect(classifyBucket(candidate({ confidence: 0.95, final_score: 0.86, topic_relevance_score: 0 }))).toBe('high');
    expect(classifyBucket(candidate({ confidence: 0.95, final_score: 0.7, topic_relevance_score: 0.1 }))).toBe('off_topic');
  });

  it('keeps bulk promote conservative', () => {
    expect(passesBulkPromoteGate(Object.assign(candidate(), { bucket: 'high' as const }))).toBe(true);
    expect(passesBulkPromoteGate(Object.assign(candidate({ final_score: 0.7 }), { bucket: 'medium' as const }))).toBe(false);
    expect(passesBulkPromoteGate(Object.assign(candidate({ topic_relevance_score: 0.4 }), { bucket: 'high' as const }))).toBe(false);
    expect(passesBulkPromoteGate(Object.assign(candidate({ signals: ['capitalized_phrase'], labels: [], mention_count: 3 }), { bucket: 'high' as const }))).toBe(false);
    expect(passesBulkPromoteGate(Object.assign(candidate({ labels: ['sentence_fragment'] }), { bucket: 'suspicious' as const }))).toBe(false);
  });

  it('parses fenced and prose-wrapped topic-fit JSON', () => {
    expect(parseTopicFitJson('```json\n{"decisions":[{"term":"gradient descent","keep":true}]}\n```')?.decisions?.[0].term)
      .toBe('gradient descent');
    expect(parseTopicFitJson('Here you go: {"decisions":[{"id":12,"keep":false}]} thanks')?.decisions?.[0].id)
      .toBe(12);
    expect(parseTopicFitJson('not json')).toBeNull();
  });

  it('builds term-keyed topic-fit prompts', () => {
    const prompt = buildTopicFitPrompt('Optimization Book', [candidate()]);
    expect(prompt).toContain('Book title: "Optimization Book"');
    expect(prompt).toContain('"term":"gradient descent"');
    expect(prompt).toContain('"keep":true|false');
  });
});
