// Pure scoring for the offline eval harness (evals/run.mjs). No LLM, no I/O —
// the runner collects model outputs and hands them here, so the metrics
// themselves are unit-tested and identical across runs.

import type { EvidenceScore } from '../core/domain/types';

export const SCORE_LABELS: EvidenceScore[] = ['understood', 'recognizes', 'gap', 'misconception'];

// ─── Grader ──────────────────────────────────────────────────────────────────

export interface GraderCaseResult {
  id: string;
  expected: { score: EvidenceScore; stage: number; expects_unsupported?: boolean };
  actual: { score: EvidenceScore; stage: number; unsupported_count: number } | null; // null = call failed
}

export interface BinaryStats {
  tp: number; fp: number; fn: number; tn: number;
  precision: number | null; recall: number | null;
}

export interface GraderMetrics {
  n: number;
  failed: number;
  score_accuracy: number;
  stage_exact: number;
  stage_within_1: number;
  stage_mae: number;
  // confusion[expected][actual]
  confusion: Record<EvidenceScore, Record<EvidenceScore, number>>;
  // Over cases that carry an expects_unsupported label.
  unsupported: BinaryStats;
}

function ratio(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

export function binaryStats(pairs: Array<{ expected: boolean; actual: boolean }>): BinaryStats {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const p of pairs) {
    if (p.expected && p.actual) tp++;
    else if (!p.expected && p.actual) fp++;
    else if (p.expected && !p.actual) fn++;
    else tn++;
  }
  return {
    tp, fp, fn, tn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
  };
}

export function scoreGrader(results: GraderCaseResult[]): GraderMetrics {
  const confusion = Object.fromEntries(
    SCORE_LABELS.map(e => [e, Object.fromEntries(SCORE_LABELS.map(a => [a, 0]))]),
  ) as GraderMetrics['confusion'];

  const ok = results.filter(r => r.actual !== null) as Array<GraderCaseResult & { actual: NonNullable<GraderCaseResult['actual']> }>;
  let scoreHits = 0, stageExact = 0, stageNear = 0, absErr = 0;
  for (const r of ok) {
    if (r.actual.score === r.expected.score) scoreHits++;
    const d = Math.abs(r.actual.stage - r.expected.stage);
    if (d === 0) stageExact++;
    if (d <= 1) stageNear++;
    absErr += d;
    if (confusion[r.expected.score] && r.actual.score in confusion[r.expected.score]) {
      confusion[r.expected.score][r.actual.score]++;
    }
  }

  const unsupported = binaryStats(
    ok.filter(r => typeof r.expected.expects_unsupported === 'boolean')
      .map(r => ({ expected: r.expected.expects_unsupported!, actual: r.actual.unsupported_count > 0 })),
  );

  return {
    n: results.length,
    failed: results.length - ok.length,
    score_accuracy: ratio(scoreHits, ok.length),
    stage_exact: ratio(stageExact, ok.length),
    stage_within_1: ratio(stageNear, ok.length),
    stage_mae: ratio(absErr, ok.length),
    confusion,
    unsupported,
  };
}

// ─── Lazy tasks ──────────────────────────────────────────────────────────────

export interface TaskSetResult {
  id: string;
  tasks: Array<{ kind: string; prompt: string }> | null; // null = call failed
  expected_kinds?: string[];
  // Gaps from seeded learner history (adaptive cases only).
  history_gaps?: string[];
}

export interface TaskMetrics {
  n: number;
  failed: number;
  mean_tasks: number;
  // Fraction of task pairs within a concept that are near-duplicates.
  near_duplicate_rate: number;
  // Fraction of concepts whose generated kinds cover every expected kind.
  kind_coverage: number;
  // Adaptive cases: fraction where at least one task addresses a seeded gap
  // (lexical proxy: shares >= 2 content words with it). null = no such cases.
  gap_targeting: number | null;
}

const STOP = new Set(['that', 'this', 'with', 'from', 'what', 'when', 'which', 'would', 'there', 'their', 'about', 'does', 'into', 'than', 'then', 'they', 'mention', 'mentioned', 'explain', 'learner']);
function contentWords(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w)));
}

export function addressesGap(prompt: string, gap: string): boolean {
  const g = contentWords(gap);
  let shared = 0;
  for (const w of contentWords(prompt)) if (g.has(w)) shared++;
  return shared >= 2;
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2));
}

export function jaccard(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export const NEAR_DUPLICATE_JACCARD = 0.7;

export function scoreTasks(results: TaskSetResult[]): TaskMetrics {
  const ok = results.filter(r => r.tasks !== null) as Array<TaskSetResult & { tasks: NonNullable<TaskSetResult['tasks']> }>;
  let pairs = 0, dupes = 0, covered = 0, withExpected = 0, total = 0, adaptive = 0, targeted = 0;
  for (const r of ok) {
    total += r.tasks.length;
    for (let i = 0; i < r.tasks.length; i++) {
      for (let j = i + 1; j < r.tasks.length; j++) {
        pairs++;
        if (jaccard(r.tasks[i].prompt, r.tasks[j].prompt) >= NEAR_DUPLICATE_JACCARD) dupes++;
      }
    }
    if (r.history_gaps?.length) {
      adaptive++;
      if (r.tasks.some(t => r.history_gaps!.some(g => addressesGap(t.prompt, g)))) targeted++;
    }
    if (r.expected_kinds?.length) {
      withExpected++;
      const kinds = new Set(r.tasks.map(t => t.kind));
      if (r.expected_kinds.every(k => kinds.has(k))) covered++;
    }
  }
  return {
    n: results.length,
    failed: results.length - ok.length,
    mean_tasks: ratio(total, ok.length),
    near_duplicate_rate: ratio(dupes, pairs),
    kind_coverage: withExpected === 0 ? 1 : covered / withExpected,
    gap_targeting: adaptive === 0 ? null : targeted / adaptive,
  };
}

// ─── Topic filter ────────────────────────────────────────────────────────────

export interface TopicFilterSetResult {
  id: string;
  labels: Record<string, boolean>; // term → should keep
  kept: string[] | null;           // null = call failed
}

export interface TopicFilterMetrics {
  sets: number;
  failed: number;
  keep: BinaryStats;
  f1: number | null;
  accuracy: number;
}

export function scoreTopicFilter(results: TopicFilterSetResult[]): TopicFilterMetrics {
  const pairs: Array<{ expected: boolean; actual: boolean }> = [];
  let failed = 0;
  for (const r of results) {
    if (r.kept === null) { failed++; continue; }
    const kept = new Set(r.kept.map(t => t.toLowerCase()));
    for (const [term, keep] of Object.entries(r.labels)) {
      pairs.push({ expected: keep, actual: kept.has(term.toLowerCase()) });
    }
  }
  const keep = binaryStats(pairs);
  const f1 = keep.precision === null || keep.recall === null || keep.precision + keep.recall === 0
    ? null
    : (2 * keep.precision * keep.recall) / (keep.precision + keep.recall);
  return {
    sets: results.length,
    failed,
    keep,
    f1,
    accuracy: ratio(keep.tp + keep.tn, pairs.length),
  };
}

// ─── Baseline comparison ─────────────────────────────────────────────────────

export interface MetricRegression {
  metric: string;
  baseline: number;
  current: number;
}

// Higher-is-better metrics; a drop larger than `tolerance` is a regression.
// Lower-is-better metrics are listed in `lowerIsBetter`.
export function compareToBaseline(
  current: Record<string, number | null>,
  baseline: Record<string, number | null>,
  tolerance = 0.03,
  lowerIsBetter: string[] = ['stage_mae', 'near_duplicate_rate', 'failed'],
): MetricRegression[] {
  const out: MetricRegression[] = [];
  for (const [metric, cur] of Object.entries(current)) {
    const base = baseline[metric];
    if (typeof cur !== 'number' || typeof base !== 'number') continue;
    const worse = lowerIsBetter.includes(metric) ? cur - base > tolerance : base - cur > tolerance;
    if (worse) out.push({ metric, baseline: base, current: cur });
  }
  return out;
}

// ─── Retrieval ───────────────────────────────────────────────────────────────
// Chunk-level IR metrics over human-labelled relevant chunk keys. Unanswerable
// questions (no relevant chunk exists) are excluded from P/R/MRR — those
// metrics are undefined without a relevant set — and are instead summarized by
// their top retrieval score, which later abstention thresholds are tuned on.

export interface RetrievalCaseResult {
  id: string;
  category: string;
  answerable: boolean;
  relevant: string[];          // relevant chunk keys
  retrieved: string[];         // retrieved chunk keys, best first
  top_score: number | null;    // score of the first hit in the mode used
}

export function precisionAtK(relevant: Set<string>, retrieved: string[], k: number): number {
  if (k <= 0) return 0;
  return retrieved.slice(0, k).filter(x => relevant.has(x)).length / k;
}

export function recallAtK(relevant: Set<string>, retrieved: string[], k: number): number {
  if (relevant.size === 0) return 0;
  return new Set(retrieved.slice(0, k).filter(x => relevant.has(x))).size / relevant.size;
}

export function reciprocalRank(relevant: Set<string>, retrieved: string[], k = Infinity): number {
  const i = retrieved.slice(0, k).findIndex(x => relevant.has(x));
  return i < 0 ? 0 : 1 / (i + 1);
}

export interface RetrievalGroupMetrics {
  n: number;
  precision_at_k: number;
  recall_at_k: number;
  mrr: number;
  coverage: number;            // share of questions with >= 1 relevant chunk in the top k
}

export interface RetrievalMetrics extends RetrievalGroupMetrics {
  k: number;
  n_unanswerable: number;
  by_category: Record<string, RetrievalGroupMetrics>;
  mean_top_score_answerable: number | null;
  mean_top_score_unanswerable: number | null;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

function group(results: RetrievalCaseResult[], k: number): RetrievalGroupMetrics {
  const n = results.length;
  if (n === 0) return { n: 0, precision_at_k: 0, recall_at_k: 0, mrr: 0, coverage: 0 };
  let p = 0, r = 0, rr = 0, cov = 0;
  for (const c of results) {
    const rel = new Set(c.relevant);
    p += precisionAtK(rel, c.retrieved, k);
    r += recallAtK(rel, c.retrieved, k);
    rr += reciprocalRank(rel, c.retrieved, k);
    if (c.retrieved.slice(0, k).some(x => rel.has(x))) cov++;
  }
  return { n, precision_at_k: round(p / n), recall_at_k: round(r / n), mrr: round(rr / n), coverage: round(cov / n) };
}

export function scoreRetrieval(results: RetrievalCaseResult[], k: number): RetrievalMetrics {
  const answerable = results.filter(c => c.answerable && c.relevant.length > 0);
  const unanswerable = results.filter(c => !c.answerable);
  const by_category: Record<string, RetrievalGroupMetrics> = {};
  for (const cat of [...new Set(answerable.map(c => c.category))].sort()) {
    by_category[cat] = group(answerable.filter(c => c.category === cat), k);
  }
  const meanTop = (cs: RetrievalCaseResult[]) => {
    const xs = cs.map(c => c.top_score).filter((x): x is number => x != null);
    return xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  };
  return {
    k,
    ...group(answerable, k),
    n_unanswerable: unanswerable.length,
    by_category,
    mean_top_score_answerable: meanTop(answerable),
    mean_top_score_unanswerable: meanTop(unanswerable),
  };
}
