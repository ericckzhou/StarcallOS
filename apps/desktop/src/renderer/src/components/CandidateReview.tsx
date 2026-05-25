import React, { useEffect, useState, useCallback } from 'react';

interface EvidenceSpan {
  source: string;
  quote: string;
  page: number;
  pattern?: string;
}

interface ConceptCandidate {
  id: number;
  source_id: number;
  term: string;
  normalized: string;
  confidence: number;
  mention_count: number;
  first_page: number;
  section_path: string[];
  evidence: EvidenceSpan[];
  signals: string[];
  topic_relevance_score?: number;
  topic_relevance_reasons?: string[];
  is_boilerplate?: boolean;
  is_broad?: boolean;
}

interface RelationCandidate {
  id: number;
  from: string;
  to: string;
  kind: string;
  quote: string;
  page: number;
}

interface MisconceptionCandidate {
  id: number;
  quote: string;
  page: number;
  section_path: string[];
}

interface EquationCandidate {
  id: number;
  latex: string;
  variables: string[];
  page: number;
  reading_order: number;
  section_path: string[];
  attached_term: string | null;
}

interface Bundle {
  concepts: ConceptCandidate[];
  relations: RelationCandidate[];
  misconceptions: MisconceptionCandidate[];
  equations: EquationCandidate[];
}

type SubTab = 'concepts' | 'relations' | 'misconceptions' | 'equations';
type Bucket = 'all' | 'high' | 'medium' | 'low' | 'suspicious' | 'off_topic' | 'boilerplate' | 'broad';

const BUCKET_COLOR: Record<Bucket, string> = {
  all:         '#9ca3af',
  high:        '#22c55e',
  medium:      '#818cf8',
  low:         '#f59e0b',
  suspicious:  '#ef4444',
  off_topic:   '#a855f7',
  boilerplate: '#6b7280',
  broad:       '#06b6d4',
};

const BUCKET_LABEL: Record<Bucket, string> = {
  all:         'All',
  high:        'High (≥0.85)',
  medium:      'Medium (0.55–0.84)',
  low:         'Low (<0.55)',
  suspicious:  'Suspicious',
  off_topic:   'Off-topic',
  boilerplate: 'Boilerplate',
  broad:       'Too broad',
};

function isSuspicious(c: ConceptCandidate): boolean {
  // High confidence but no evidence quote
  const hasAnyQuote = c.evidence.some(e => e.quote && e.quote.trim().length > 0);
  if (c.confidence >= 0.7 && !hasAnyQuote) return true;
  // Term length outliers
  if (c.term.length > 80) return true;
  if (c.term.replace(/\s+/g, '').length <= 1) return true;
  // Formula / math symbols leaked through
  if (/[\\{}=<>∑∫∂∇αβγδεζηθικλμνξπρστυφχψω]/.test(c.term)) return true;
  // Code fence leak
  if (c.term.includes('```') || c.term.startsWith('`')) return true;
  // Long all-caps run (probably a shout sentence, not a concept name)
  if (c.term.length >= 30 && /[A-Z]/.test(c.term) && c.term === c.term.toUpperCase()) return true;
  return false;
}

function classifyBucket(c: ConceptCandidate): Bucket {
  // Quality flags from parser have priority over confidence-band classification.
  // Off-topic is the most subjective of the three — a token-overlap miss can
  // happen even on genuinely on-topic high-confidence concepts. Don't let it
  // override a strong confidence signal.
  if (c.is_boilerplate)                                return 'boilerplate';
  if (c.is_broad)                                      return 'broad';
  if (isSuspicious(c))                                 return 'suspicious';
  if (c.confidence >= 0.85)                            return 'high';
  if ((c.topic_relevance_score ?? 1.0) < 0.15)         return 'off_topic';
  if (c.confidence >= 0.55)                            return 'medium';
  return 'low';
}

// Bulk-promote gate: only the obviously safe candidates qualify automatically.
function passesBulkPromoteGate(c: ConceptCandidate & { bucket: Bucket }): boolean {
  if (c.is_boilerplate) return false;
  if (c.is_broad) return false;
  if (c.bucket === 'suspicious') return false;
  if ((c.topic_relevance_score ?? 1.0) < 0.55) return false;
  if (c.confidence < 0.9) return false;
  if (c.mention_count < 2) return false;
  return true;
}

const SIGNAL_COLOR: Record<string, string> = {
  heading:            '#f59e0b',
  definition_pattern: '#22c55e',
  bold_block:         '#a855f7',
  repetition:         '#22d3ee',
  capitalized_phrase: '#6b7280',
};

const RELATION_COLOR: Record<string, string> = {
  requires:       '#f59e0b',
  causes:         '#ef4444',
  enables:        '#22c55e',
  contrasts_with: '#a855f7',
  example_of:     '#22d3ee',
};

function confColor(c: number): string {
  if (c >= 0.9) return '#22c55e';
  if (c >= 0.55) return '#818cf8';
  if (c >= 0.3) return '#f59e0b';
  return '#6b7280';
}

interface Props {
  sourceId: number;
  sourceTitle?: string;
  onPromoted?: () => void;
}

export default function CandidateReview({ sourceId, sourceTitle, onPromoted }: Props) {
  const [bundle, setBundle] = useState<Bundle>({ concepts: [], relations: [], misconceptions: [], equations: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [minConf, setMinConf] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  const extractMsg: string | null = null;
  const [subTab, setSubTab] = useState<SubTab>('concepts');
  const [bucket, setBucket] = useState<Bucket>('all');
  const [signalFilter, setSignalFilter] = useState<string>('any');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<'visible' | 'eligible'>('visible');
  // LLM topic-fit filter — soft filter on top of the bucket/signal pass.
  const [llmFilterOpen, setLlmFilterOpen]   = useState(false);
  const [llmKeepIds, setLlmKeepIds]         = useState<Set<number> | null>(null);
  const [llmFilterEnabled, setLlmFilterEnabled] = useState(true); // toggle without losing the saved set
  const [llmFilterMsg, setLlmFilterMsg]     = useState<string | null>(null);
  const [llmCopied, setLlmCopied]           = useState(false);
  const [llmPaste, setLlmPaste]             = useState('');

  // Persisted LLM filter is stored as normalized terms (stable across
  // re-extracts where row IDs churn). We map terms → current candidate IDs
  // every time the bundle reloads.
  const [llmKeepTerms, setLlmKeepTerms] = useState<Set<string> | null>(null);

  // Single combined refresh — loads bundle and saved filter in parallel,
  // sets both atomically. Kills the source-switch flicker where one races
  // ahead of the other and briefly shows "All candidates filtered out".
  const refresh = useCallback(() => {
    setLoading(true);
    void Promise.all([
      window.api.candidates.bySource(sourceId),
      window.api.sources.llmFilterGet(sourceId),
    ]).then(([b, stored]) => {
      setBundle(b as Bundle);
      if (!stored || stored.length === 0) {
        setLlmKeepTerms(null);
      } else {
        setLlmKeepTerms(new Set(stored.map(t => t.toLowerCase())));
        setLlmFilterEnabled(true);
      }
      setLoading(false);
    });
  }, [sourceId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Re-derive the active id-set whenever bundle OR saved-terms change.
  // Also clears the stale "Filter active" toast when the keep-set collapses.
  useEffect(() => {
    if (!llmKeepTerms) {
      setLlmKeepIds(null);
      setLlmFilterMsg(null);
      return;
    }
    const keep = new Set<number>();
    for (const c of bundle.concepts) {
      if (llmKeepTerms.has(c.normalized.toLowerCase())) keep.add(c.id);
    }
    setLlmKeepIds(keep.size > 0 ? keep : null);
    if (keep.size === 0) setLlmFilterMsg(null);
  }, [bundle, llmKeepTerms]);

  // ── LLM topic-fit filter helpers ─────────────────────────────────────────
  // Generates a prompt that hands the LLM the source title + the current
  // candidate list, asks it to flag which belong to the book's topic. Parses
  // the response and sets a soft filter on the list (no DB writes).
  function buildTopicFitPrompt(): string {
    // Send the normalized term as the stable key. Row IDs change on every
    // Re-extract; terms don't. The LLM keys its response by "term" so the
    // filter survives re-extracts.
    const list = withBucket.slice(0, 400).map(c =>
      JSON.stringify({ term: c.normalized, display: c.term, mentions: c.mention_count, page: c.first_page }),
    ).join('\n');
    const title = sourceTitle || '(unknown source title)';
    return [
      `You're filtering candidate concepts extracted from a book.`,
      `Book title: "${title}"`,
      ``,
      `For each candidate below, decide whether it ACTUALLY belongs to this book's domain.`,
      `Reject: overly broad terms, boilerplate ("Summary", "References"), generic words, and concepts that aren't really about this book's subject.`,
      `Keep: concepts that a reader of this book would specifically want to learn.`,
      ``,
      `Candidates (one JSON object per line, use the "term" value as the key):`,
      list,
      ``,
      `Respond ONLY with this JSON shape (one entry per candidate term you decide on — you can omit ones you're unsure about):`,
      `{"decisions":[{"term":"<term verbatim>","keep":true|false}]}`,
    ].join('\n');
  }
  async function copyTopicFitPrompt(): Promise<void> {
    await navigator.clipboard.writeText(buildTopicFitPrompt());
    setLlmCopied(true);
    setTimeout(() => setLlmCopied(false), 2000);
  }
  function parseTopicFitJson(raw: string): { decisions?: Array<{ id?: number; term?: string; keep: boolean }> } | null {
    if (!raw.trim()) return null;
    let body = raw.trim();
    const fenced = body.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) body = fenced[1].trim();
    if (!body.startsWith('{')) {
      const start = body.indexOf('{');
      const end   = body.lastIndexOf('}');
      if (start >= 0 && end > start) body = body.slice(start, end + 1);
    }
    try {
      const obj = JSON.parse(body) as { decisions?: Array<{ id?: number; term?: string; keep: boolean }> };
      if (!Array.isArray(obj.decisions)) return null;
      return obj;
    } catch {
      return null;
    }
  }
  function applyTopicFitFilter(raw: string): void {
    const parsed = parseTopicFitJson(raw);
    if (!parsed?.decisions) {
      setLlmFilterMsg('Could not parse JSON. Expected {"decisions":[{"term":"…","keep":true|false}, …]}.');
      return;
    }
    // Build lookup maps from current candidates so we can resolve both
    // term-keyed (new, preferred) and id-keyed (legacy / mid-flight) decisions.
    const termToCandidate = new Map<string, ConceptCandidate>();
    const idToCandidate   = new Map<number, ConceptCandidate>();
    for (const c of bundle.concepts) {
      termToCandidate.set(c.normalized.toLowerCase(), c);
      idToCandidate.set(c.id, c);
    }
    const keptTerms = new Set<string>();
    const keepIds   = new Set<number>();
    let unmatched = 0;
    let totalKept = 0;
    for (const d of parsed.decisions) {
      if (d.keep !== true) continue;
      totalKept += 1;
      let c: ConceptCandidate | undefined;
      if (typeof d.term === 'string') {
        c = termToCandidate.get(d.term.toLowerCase());
      }
      if (!c && typeof d.id === 'number') {
        c = idToCandidate.get(d.id);
      }
      if (c) {
        keptTerms.add(c.normalized.toLowerCase());
        keepIds.add(c.id);
      } else {
        unmatched += 1;
      }
    }
    if (keepIds.size === 0) {
      const reason = totalKept === 0
        ? 'No candidates marked keep:true in the response. Nothing filtered.'
        : `${totalKept} keep:true decisions in the response, but none matched current candidates. The response is likely stale (re-extracted since you copied the prompt). Re-copy the prompt and try again.`;
      setLlmFilterMsg(reason);
      return;
    }
    const termsArr = [...keptTerms];
    setLlmKeepTerms(new Set(termsArr));
    setLlmKeepIds(keepIds);
    setLlmFilterEnabled(true);
    const unmatchedPart = unmatched > 0 ? ` (${unmatched} stale id${unmatched === 1 ? '' : 's'} ignored)` : '';
    setLlmFilterMsg(`Filter active: ${keepIds.size} candidate${keepIds.size === 1 ? '' : 's'} kept${unmatchedPart}.`);
    setLlmFilterOpen(false);
    setLlmPaste('');
    void window.api.sources.llmFilterSet({ sourceId, keepTerms: termsArr });
  }
  function clearTopicFitFilter(): void {
    setLlmKeepTerms(null);
    setLlmKeepIds(null);
    setLlmFilterMsg(null);
    setLlmPaste('');
    void window.api.sources.llmFilterSet({ sourceId, keepTerms: null });
  }

  async function promoteAllFiltered(ids: number[]) {
    setBulkBusy(true);
    setBulkMsg(null);
    try {
      const r = await window.api.candidates.promoteBulk(ids);
      const promotedSet = new Set(r.promoted);
      // Drop the candidates that were successfully promoted (their candidate rows
      // are deleted server-side); leave failures in place for inspection.
      const failedIds = new Set(r.errors.map(e => e.candidateId));
      setBundle(b => ({
        ...b,
        concepts: b.concepts.filter(c => !ids.includes(c.id) || failedIds.has(c.id) || !promotedSet.has(c.id)),
      }));
      const errPart = r.errors.length > 0 ? ` · ${r.errors.length} failed` : '';
      setBulkMsg(`Promoted ${r.promoted.length} of ${ids.length}${errPart}`);
      onPromoted?.();
    } catch (e) {
      setBulkMsg(`Bulk promote failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBulkBusy(false);
      setConfirming(false);
    }
  }

  async function act(id: number, fn: () => Promise<unknown>) {
    setBusy(s => new Set(s).add(id));
    try {
      await fn();
      setBundle(b => ({ ...b, concepts: b.concepts.filter(c => c.id !== id) }));
      onPromoted?.();
    } finally {
      setBusy(s => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  // Bucket pass + slider pass. Suspicious always shows regardless of slider.
  // Bucket counts honor the active LLM filter so the chips reflect what's
  // actually selectable, not the pre-filter total.
  const bucketCounts: Record<Bucket, number> = {
    all: 0, high: 0, medium: 0, low: 0,
    suspicious: 0, off_topic: 0, boilerplate: 0, broad: 0,
  };
  const withBucket: Array<ConceptCandidate & { bucket: Bucket }> = bundle.concepts.map(c => {
    const b = classifyBucket(c);
    const passesLlm = !llmFilterEnabled || llmKeepIds === null || llmKeepIds.has(c.id);
    const passesLlmEffective = !llmFilterEnabled || passesLlm;
    if (passesLlmEffective) {
      bucketCounts[b] += 1;
      bucketCounts.all += 1;
    }
    return Object.assign(c, { bucket: b });
  });
  const filtered = withBucket.filter(c =>
    (bucket === 'all' || c.bucket === bucket) &&
    (c.bucket === 'suspicious' || c.confidence >= minConf) &&
    (signalFilter === 'any' || c.signals.includes(signalFilter)) &&
    (!llmFilterEnabled || llmKeepIds === null || llmKeepIds.has(c.id)),
  );
  // Count of candidates per signal for the chip pills (respects bucket + LLM filter)
  const signalCounts: Record<string, number> = {};
  for (const c of withBucket) {
    if (bucket !== 'all' && c.bucket !== bucket) continue;
    if (llmFilterEnabled && llmKeepIds !== null && !llmKeepIds.has(c.id)) continue;
    for (const s of c.signals) signalCounts[s] = (signalCounts[s] ?? 0) + 1;
  }
  const signalChips: Array<{ key: string; label: string; color: string }> = [
    { key: 'any',                label: 'Any signal',   color: '#9ca3af' },
    { key: 'heading',            label: 'Heading',      color: SIGNAL_COLOR.heading },
    { key: 'definition_pattern', label: 'Definition',   color: SIGNAL_COLOR.definition_pattern },
    { key: 'bold_block',         label: 'Bold',         color: SIGNAL_COLOR.bold_block },
    { key: 'repetition',         label: 'Repetition',   color: SIGNAL_COLOR.repetition },
    { key: 'capitalized_phrase', label: 'Cap. phrase',  color: SIGNAL_COLOR.capitalized_phrase },
  ];
  const knownNormalized = new Set(bundle.concepts.map(c => c.normalized));
  const equationsByTerm = new Map<string, EquationCandidate[]>();
  for (const eq of bundle.equations) {
    if (!eq.attached_term) continue;
    const list = equationsByTerm.get(eq.attached_term) ?? [];
    list.push(eq);
    equationsByTerm.set(eq.attached_term, list);
  }
  const unattachedEquations = bundle.equations.filter(eq => !eq.attached_term);

  const subTabBtn = (key: SubTab, label: string, count: number): React.ReactNode => (
    <button
      key={key}
      onClick={() => setSubTab(key)}
      style={{
        background: subTab === key ? '#1a1a2e' : 'transparent',
        border: 'none',
        borderBottom: `2px solid ${subTab === key ? '#818cf8' : 'transparent'}`,
        color: subTab === key ? '#e2e8f0' : '#6b7280',
        padding: '8px 14px', fontSize: 11, fontWeight: 600,
        letterSpacing: '0.05em', textTransform: 'uppercase', cursor: 'pointer',
      }}
    >
      {label} <span style={{ color: subTab === key ? '#818cf8' : '#4b5563', marginLeft: 4 }}>{count}</span>
    </button>
  );

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {confirming && (() => {
        const targetList = confirmTarget === 'eligible'
          ? withBucket.filter(passesBulkPromoteGate)
          : filtered;
        const description = confirmTarget === 'eligible'
          ? `Promotes every candidate that passes the safe-default gate: confidence ≥ 0.9, mention_count ≥ 2, topic_relevance_score ≥ 0.55, and not suspicious / boilerplate / broad. Ignores the current bucket and signal filters.`
          : `Bulk-creates concept rows from every visible candidate (bucket "${BUCKET_LABEL[bucket]}", signal "${signalFilter}", min confidence ${minConf.toFixed(2)}). No LLM calls — pure DB upserts. Tasks generate lazily on first review.`;
        return (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 50,
            background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              background: '#0d0d16', border: '1px solid #1f2937', borderRadius: 8,
              padding: 20, width: 440, display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#bbf7d0' }}>
                Promote {targetList.length} concept{targetList.length === 1 ? '' : 's'}?
              </div>
              <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.6 }}>
                {description}
                <div style={{ marginTop: 8, color: '#6b7280', fontSize: 11 }}>
                  Top of list: {targetList.slice(0, 3).map(c => c.term).join(' · ')}{targetList.length > 3 ? ` … +${targetList.length - 3} more` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                <button
                  onClick={() => setConfirming(false)}
                  disabled={bulkBusy}
                  style={{ background: 'transparent', border: '1px solid #374151', borderRadius: 4, padding: '5px 14px', color: '#9ca3af', fontSize: 12, cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => promoteAllFiltered(targetList.map(c => c.id))}
                  disabled={bulkBusy}
                  style={{ background: '#14532d', border: '1px solid #22c55e', borderRadius: 4, padding: '5px 14px', color: '#bbf7d0', fontSize: 12, cursor: bulkBusy ? 'wait' : 'pointer', fontWeight: 600 }}
                >
                  {bulkBusy ? 'Promoting…' : `Promote ${targetList.length}`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {bulkMsg && (
        <div style={{
          padding: '6px 16px', background: '#0d0d16', borderBottom: '1px solid #1f2937',
          fontSize: 11, color: bulkMsg.startsWith('Bulk promote failed') ? '#fca5a5' : '#86efac',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span>{bulkMsg}</span>
          <button onClick={() => setBulkMsg(null)} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#4b5563', cursor: 'pointer', fontSize: 14 }}>×</button>
        </div>
      )}

      {/* Active LLM filter is now indicated by the LLM-kept chip in the bucket bar
          (toggle to enable/disable) and by a Clear button in the LLM filter modal. */}

      {llmFilterOpen && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 50,
          background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#0d0d16', border: '1px solid #1f2937', borderRadius: 8,
            padding: 20, width: 640, maxHeight: '80vh', display: 'flex', flexDirection: 'column', gap: 14,
            overflow: 'hidden',
          }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#c7d2fe' }}>LLM topic-fit filter</div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, lineHeight: 1.5 }}>
                Source: <span style={{ color: '#9ca3af' }}>{sourceTitle || '(no title set)'}</span>
                <br />
                Sending {Math.min(withBucket.length, 400)} of {withBucket.length} candidates to be classified.
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>1. Copy this prompt to ChatGPT (or any LLM):</span>
              <button onClick={copyTopicFitPrompt} style={{
                marginLeft: 'auto', background: '#1e1b4b', border: '1px solid #4338ca', borderRadius: 3,
                padding: '3px 10px', fontSize: 11, color: llmCopied ? '#86efac' : '#c7d2fe', cursor: 'pointer', fontWeight: 600,
              }}>
                {llmCopied ? '✓ Copied' : 'Copy Prompt'}
              </button>
            </div>
            <pre style={{
              margin: 0, padding: '10px 12px', background: '#000', border: '1px solid #1f2937', borderRadius: 4,
              color: '#9ca3af', fontSize: 10, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              fontFamily: 'ui-monospace, Consolas, monospace', maxHeight: 140, overflow: 'auto',
            }}>
              {buildTopicFitPrompt().slice(0, 600)}{buildTopicFitPrompt().length > 600 ? '\n… (truncated; full prompt is on your clipboard)' : ''}
            </pre>

            <div style={{ fontSize: 11, color: '#9ca3af' }}>2. Paste the LLM&apos;s JSON answer here (auto-parses on paste):</div>
            <textarea
              autoFocus
              value={llmPaste}
              onChange={e => {
                const v = e.target.value;
                setLlmPaste(v);
                setLlmFilterMsg(null);
                const parsed = parseTopicFitJson(v);
                if (parsed?.decisions && parsed.decisions.length > 0) {
                  applyTopicFitFilter(v);
                }
              }}
              placeholder='Paste e.g. {"decisions":[{"id":123,"keep":true},{"id":124,"keep":false}, …]}'
              rows={8}
              style={{
                width: '100%', boxSizing: 'border-box', resize: 'vertical',
                background: '#000', border: `1px solid ${llmFilterMsg?.startsWith('Could not') ? '#7f1d1d' : '#312e81'}`,
                borderRadius: 4, padding: '8px 10px', color: '#e2e8f0', fontSize: 11, lineHeight: 1.5,
                fontFamily: 'ui-monospace, Consolas, monospace', outline: 'none',
              }}
            />
            {llmFilterMsg && (
              <div style={{ fontSize: 11, color: llmFilterMsg.startsWith('Could not') ? '#fca5a5' : '#86efac' }}>
                {llmFilterMsg}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              {llmKeepIds && (
                <button
                  onClick={() => { clearTopicFitFilter(); setLlmFilterOpen(false); }}
                  title="Wipe the saved LLM filter from this source"
                  style={{ background: '#1a0a0a', border: '1px solid #7f1d1d', borderRadius: 4, padding: '5px 14px', color: '#fca5a5', fontSize: 12, cursor: 'pointer' }}
                >
                  Clear saved filter
                </button>
              )}
              <div style={{ marginLeft: 'auto' }} />
              <button
                onClick={() => { setLlmFilterOpen(false); setLlmPaste(''); setLlmFilterMsg(null); }}
                style={{ background: 'transparent', border: '1px solid #374151', borderRadius: 4, padding: '5px 14px', color: '#9ca3af', fontSize: 12, cursor: 'pointer' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top bar — bucket chips, counters, slider, refresh, run-extraction */}
      <div style={{
        padding: '8px 16px', borderBottom: '1px solid #1f2937',
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap',
      }}>
        {subTab === 'concepts' && (['all', 'high', 'medium', 'low', 'off_topic', 'broad', 'boilerplate', 'suspicious'] as const).map(b => {
          const count = bucketCounts[b];
          const selected = bucket === b;
          const color = BUCKET_COLOR[b];
          return (
            <button
              key={b}
              onClick={() => setBucket(b)}
              style={{
                background: selected ? '#1a1a2e' : 'transparent',
                border: `1px solid ${selected ? color : '#1f2937'}`,
                color: selected ? color : '#6b7280',
                borderRadius: 3, padding: '3px 8px', fontSize: 10, cursor: 'pointer',
                fontWeight: 600, letterSpacing: '0.03em',
              }}
            >
              {BUCKET_LABEL[b]} <span style={{ color: selected ? color : '#4b5563', marginLeft: 4 }}>{count}</span>
            </button>
          );
        })}
        {subTab === 'concepts' && llmKeepIds && llmKeepIds.size > 0 && (
          <button
            onClick={() => setLlmFilterEnabled(v => !v)}
            title={llmFilterEnabled
              ? 'Click to disable the saved LLM topic-fit filter (keeps the saved set).'
              : 'Click to re-enable your saved LLM topic-fit filter.'}
            style={{
              background: llmFilterEnabled ? '#1e1b4b' : 'transparent',
              border: `1px solid ${llmFilterEnabled ? '#818cf8' : '#1f2937'}`,
              color: llmFilterEnabled ? '#c7d2fe' : '#4b5563',
              borderRadius: 3, padding: '3px 8px', fontSize: 10, cursor: 'pointer',
              fontWeight: 700, letterSpacing: '0.03em',
            }}
          >
            {llmFilterEnabled ? '● LLM-kept' : '○ LLM-kept'} <span style={{ color: llmFilterEnabled ? '#818cf8' : '#4b5563', marginLeft: 4 }}>{llmKeepIds.size}</span>
          </button>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {subTab === 'concepts' && (() => {
            const eligible = withBucket.filter(passesBulkPromoteGate);
            return (
              <>
                {eligible.length > 0 && (
                  <button
                    onClick={() => {
                      setConfirmTarget('eligible');
                      setConfirming(true);
                    }}
                    disabled={bulkBusy}
                    title={`Promote every candidate that passes the safe-default gate: confidence ≥ 0.9, mention_count ≥ 2, topic_relevance ≥ 0.55, not suspicious / boilerplate / broad. Ignores the current bucket filter.`}
                    style={{
                      background: '#0e3a25', border: '1px solid #22c55e', borderRadius: 3,
                      padding: '3px 10px', fontSize: 10, cursor: bulkBusy ? 'wait' : 'pointer',
                      color: '#bbf7d0', opacity: bulkBusy ? 0.5 : 1, fontWeight: 700,
                    }}
                  >
                    {bulkBusy ? 'Promoting…' : `Promote ${eligible.length} eligible`}
                  </button>
                )}
                {filtered.length > 0 && (
                  <button
                    onClick={() => {
                      setConfirmTarget('visible');
                      setConfirming(true);
                    }}
                    disabled={bulkBusy}
                    title={`Bulk-promote every concept currently visible (respects bucket + signal + slider). No LLM calls.`}
                    style={{
                      background: '#14532d', border: '1px solid #22c55e', borderRadius: 3,
                      padding: '3px 10px', fontSize: 10, cursor: bulkBusy ? 'wait' : 'pointer',
                      color: '#bbf7d0', opacity: bulkBusy ? 0.5 : 1, fontWeight: 600,
                    }}
                  >
                    {bulkBusy ? 'Promoting…' : `Promote ${filtered.length} visible`}
                  </button>
                )}
                <button
                  onClick={() => setLlmFilterOpen(true)}
                  title={`Generate a prompt for ChatGPT (or any LLM). Paste the JSON answer back, soft-filters the list to candidates the LLM agrees fit the book's topic.`}
                  style={{
                    background: '#1e1b4b', border: '1px solid #818cf8', borderRadius: 3,
                    padding: '3px 10px', fontSize: 10, cursor: 'pointer',
                    color: '#c7d2fe', fontWeight: 600,
                  }}
                >
                  LLM topic filter
                </button>
              </>
            );
          })()}
          {subTab === 'concepts' && (
            <>
              <span style={{ fontSize: 10, color: '#6b7280' }}>min confidence</span>
              <input
                type="range" min={0} max={1} step={0.05} value={minConf}
                onChange={e => setMinConf(parseFloat(e.target.value))}
                style={{ width: 120 }}
              />
              <span style={{ fontSize: 11, color: confColor(minConf), minWidth: 28 }}>{minConf.toFixed(2)}</span>
            </>
          )}
          <button
            onClick={refresh}
            style={{ background: 'transparent', border: '1px solid #1f2937', borderRadius: 3, padding: '3px 10px', fontSize: 10, cursor: 'pointer', color: '#9ca3af' }}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Sub-tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid #1f2937', background: '#0d0d16', flexShrink: 0 }}>
        {subTabBtn('concepts',       'Concepts',       bucketCounts.all)}
        {subTabBtn('relations',      'Relations',      bundle.relations.length)}
        {subTabBtn('misconceptions', 'Misconceptions', bundle.misconceptions.length)}
        {subTabBtn('equations',      'Equations',      bundle.equations.length)}
      </div>

      {/* Signal-source chips (Concepts sub-tab only) */}
      {subTab === 'concepts' && (
        <div style={{
          padding: '6px 16px', borderBottom: '1px solid #1f2937',
          display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap',
          background: '#0a0a0f',
        }}>
          <span style={{ fontSize: 9, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em', marginRight: 4 }}>signal</span>
          {signalChips.map(({ key, label, color }) => {
            const selected = signalFilter === key;
            const count = key === 'any'
              ? Object.values(signalCounts).reduce((a, b) => a + b, 0)
              : (signalCounts[key] ?? 0);
            return (
              <button
                key={key}
                onClick={() => setSignalFilter(key)}
                style={{
                  background: selected ? '#1a1a2e' : 'transparent',
                  border: `1px solid ${selected ? color : '#1f2937'}`,
                  color: selected ? color : '#6b7280',
                  borderRadius: 3, padding: '2px 7px', fontSize: 10, cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                {label} <span style={{ color: selected ? color : '#4b5563', marginLeft: 3 }}>{count}</span>
              </button>
            );
          })}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && (
          <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 12 }}>Loading candidates…</div>
        )}

        {!loading && subTab === 'concepts' && (
          <ConceptsPanel
            filtered={filtered}
            totalConcepts={bundle.concepts.length}
            extractMsg={extractMsg}
            expanded={expanded}
            setExpanded={setExpanded}
            busy={busy}
            equationsByTerm={equationsByTerm}
            act={act}
            llmKeepIds={llmFilterEnabled ? llmKeepIds : null}
          />
        )}

        {!loading && subTab === 'relations' && (
          <RelationsPanel relations={bundle.relations} knownTerms={knownNormalized} />
        )}

        {!loading && subTab === 'misconceptions' && (
          <MisconceptionsPanel misconceptions={bundle.misconceptions} />
        )}

        {!loading && subTab === 'equations' && (
          <EquationsPanel
            equations={bundle.equations}
            unattached={unattachedEquations}
            byTerm={equationsByTerm}
          />
        )}
      </div>
    </div>
  );
}

// ─── Concepts panel (existing list) ───────────────────────────────────────────

function ConceptsPanel({ filtered, totalConcepts, extractMsg, expanded, setExpanded, busy, equationsByTerm, act, llmKeepIds }: {
  filtered: Array<ConceptCandidate & { bucket?: Bucket }>;
  totalConcepts: number;
  extractMsg: string | null;
  expanded: number | null;
  setExpanded: (n: number | null) => void;
  busy: Set<number>;
  equationsByTerm: Map<string, EquationCandidate[]>;
  act: (id: number, fn: () => Promise<unknown>) => Promise<void>;
  llmKeepIds: Set<number> | null;
}) {
  if (filtered.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 12 }}>
        {totalConcepts === 0
          ? 'No candidates for this source. Click "Re-extract" on the source in the left panel to (re-)parse it.'
          : 'All candidates filtered out. Lower the confidence threshold.'}
        {extractMsg && (
          <div style={{ marginTop: 12, color: '#9ca3af', fontSize: 11 }}>{extractMsg}</div>
        )}
      </div>
    );
  }
  return (
    <>
      {filtered.map(c => {
        const isOpen = expanded === c.id;
        const isBusy = busy.has(c.id);
        const topQuote = c.evidence[0]?.quote ?? '';
        const attachedEqs = equationsByTerm.get(c.normalized) ?? [];
        const llmKept = !!llmKeepIds?.has(c.id);
        return (
          <div key={c.id} style={{ borderBottom: '1px solid #111827', padding: '10px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => setExpanded(isOpen ? null : c.id)}
                style={{ background: 'transparent', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 11, width: 14 }}
              >
                {isOpen ? '▾' : '▸'}
              </button>
              <div style={{
                minWidth: 36, textAlign: 'right', fontFamily: 'monospace',
                fontSize: 12, color: confColor(c.confidence), fontWeight: 600,
              }}>
                {c.confidence.toFixed(2)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.term}
                </div>
                <div style={{ marginTop: 2, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: '#6b7280' }}>×{c.mention_count}</span>
                  <span style={{ fontSize: 10, color: '#6b7280' }}>p.{c.first_page}</span>
                  {c.section_path.length > 0 && (
                    <span style={{ fontSize: 10, color: '#4b5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>
                      {c.section_path.join(' › ')}
                    </span>
                  )}
                  {c.signals.map(s => (
                    <span key={s} style={{
                      fontSize: 9, color: SIGNAL_COLOR[s] ?? '#6b7280',
                      border: `1px solid ${SIGNAL_COLOR[s] ?? '#374151'}`,
                      borderRadius: 2, padding: '1px 5px',
                    }}>
                      {s.replace(/_/g, ' ')}
                    </span>
                  ))}
                  {attachedEqs.length > 0 && (
                    <span style={{
                      fontSize: 9, color: '#fbbf24',
                      border: '1px solid #b45309',
                      borderRadius: 2, padding: '1px 5px',
                    }}>
                      ƒ ×{attachedEqs.length}
                    </span>
                  )}
                  {c.bucket && (c.bucket === 'low' || c.bucket === 'suspicious') && (
                    <span style={{
                      fontSize: 9, color: BUCKET_COLOR[c.bucket],
                      border: `1px solid ${BUCKET_COLOR[c.bucket]}`,
                      borderRadius: 2, padding: '1px 5px',
                      fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em',
                    }}>
                      {c.bucket}
                    </span>
                  )}
                  {llmKept && (
                    <span title="Kept by your saved LLM topic-fit filter" style={{
                      fontSize: 9, color: '#c7d2fe',
                      border: '1px solid #4338ca',
                      borderRadius: 2, padding: '1px 5px',
                      fontWeight: 700, letterSpacing: '0.03em',
                    }}>
                      ● LLM
                    </span>
                  )}
                </div>
              </div>
              <button
                disabled={isBusy}
                onClick={() => act(c.id, () => window.api.candidates.promote(c.id))}
                style={{
                  background: '#14532d', border: '1px solid #22c55e', borderRadius: 3,
                  padding: '4px 10px', fontSize: 11, cursor: isBusy ? 'wait' : 'pointer',
                  color: '#bbf7d0', opacity: isBusy ? 0.5 : 1,
                }}
              >
                Promote
              </button>
              <button
                disabled={isBusy}
                onClick={() => act(c.id, () => window.api.candidates.reject(c.id))}
                style={{
                  background: 'transparent', border: '1px solid #374151', borderRadius: 3,
                  padding: '4px 10px', fontSize: 11, cursor: isBusy ? 'wait' : 'pointer',
                  color: '#9ca3af', opacity: isBusy ? 0.5 : 1,
                }}
              >
                Reject
              </button>
            </div>

            {!isOpen && topQuote && (
              <div style={{ marginLeft: 64, marginTop: 4, fontSize: 11, color: '#6b7280', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                “{topQuote}”
              </div>
            )}

            {isOpen && (
              <div style={{ marginLeft: 64, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {c.evidence.map((e, i) => (
                  <div key={i} style={{ fontSize: 11, color: '#9ca3af', lineHeight: 1.5 }}>
                    <span style={{
                      display: 'inline-block', minWidth: 72, color: SIGNAL_COLOR[e.source] ?? '#6b7280',
                      fontWeight: 600, fontSize: 10,
                    }}>
                      {e.source}{e.pattern ? `:${e.pattern}` : ''}
                    </span>
                    <span style={{ color: '#4b5563', marginRight: 6 }}>p.{e.page}</span>
                    <span style={{ fontStyle: 'italic' }}>“{e.quote}”</span>
                  </div>
                ))}
                {attachedEqs.length > 0 && (
                  <div style={{ marginTop: 4, paddingTop: 6, borderTop: '1px dashed #1f2937' }}>
                    <div style={{ fontSize: 10, color: '#fbbf24', fontWeight: 600, marginBottom: 4 }}>
                      EQUATIONS ({attachedEqs.length})
                    </div>
                    {attachedEqs.map(eq => (
                      <div key={eq.id} style={{ fontSize: 11, color: '#d1d5db', lineHeight: 1.6, marginBottom: 4 }}>
                        <span style={{ color: '#4b5563', marginRight: 6, fontSize: 10 }}>p.{eq.page}</span>
                        <code style={{
                          background: '#0d0d16', border: '1px solid #1f2937', borderRadius: 3,
                          padding: '2px 6px', fontSize: 11, color: '#fde68a',
                        }}>
                          {eq.latex}
                        </code>
                        {eq.variables.length > 0 && (
                          <span style={{ marginLeft: 8, fontSize: 10, color: '#6b7280' }}>
                            vars: {eq.variables.slice(0, 6).join(', ')}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ─── Relations panel ──────────────────────────────────────────────────────────

function RelationsPanel({ relations, knownTerms }: { relations: RelationCandidate[]; knownTerms: Set<string> }) {
  if (relations.length === 0) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 12 }}>No relation candidates.</div>;
  }
  function norm(s: string): string {
    return s.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9\s-]/g, '').trim();
  }
  return (
    <>
      {relations.map(r => {
        const fromKnown = knownTerms.has(norm(r.from));
        const toKnown   = knownTerms.has(norm(r.to));
        const color = RELATION_COLOR[r.kind] ?? '#6b7280';
        return (
          <div key={r.id} style={{ borderBottom: '1px solid #111827', padding: '10px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Term name={r.from} known={fromKnown} />
              <span style={{
                fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase',
                border: `1px solid ${color}`, borderRadius: 2, padding: '1px 6px',
              }}>
                {r.kind.replace(/_/g, ' ')}
              </span>
              <Term name={r.to} known={toKnown} />
              <span style={{ marginLeft: 'auto', fontSize: 10, color: '#4b5563' }}>p.{r.page}</span>
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic', lineHeight: 1.5 }}>
              “{r.quote}”
            </div>
          </div>
        );
      })}
    </>
  );
}

function Term({ name, known }: { name: string; known: boolean }) {
  return (
    <span style={{
      fontSize: 13, color: known ? '#e2e8f0' : '#6b7280',
      fontWeight: 500,
      borderBottom: known ? '1px solid #312e81' : '1px dashed #1f2937',
      paddingBottom: 1,
    }}>
      {name}
    </span>
  );
}

// ─── Misconceptions panel ─────────────────────────────────────────────────────

function MisconceptionsPanel({ misconceptions }: { misconceptions: MisconceptionCandidate[] }) {
  if (misconceptions.length === 0) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 12 }}>No misconception phrases detected.</div>;
  }
  return (
    <>
      {misconceptions.map(m => (
        <div key={m.id} style={{ borderBottom: '1px solid #111827', padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{
              fontSize: 9, color: '#fca5a5', border: '1px solid #7f1d1d',
              borderRadius: 2, padding: '1px 5px', textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>
              misconception phrase
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#4b5563' }}>p.{m.page}</span>
          </div>
          <div style={{ fontSize: 12, color: '#e2e8f0', lineHeight: 1.6, fontStyle: 'italic' }}>
            “{m.quote}”
          </div>
          {m.section_path.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 10, color: '#4b5563' }}>
              {m.section_path.join(' › ')}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

// ─── Equations panel ─────────────────────────────────────────────────────────

function EquationsPanel({ equations, unattached, byTerm }: {
  equations: EquationCandidate[];
  unattached: EquationCandidate[];
  byTerm: Map<string, EquationCandidate[]>;
}) {
  if (equations.length === 0) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 12 }}>No equation candidates.</div>;
  }
  const attached = [...byTerm.entries()].sort((a, b) => b[1].length - a[1].length);
  return (
    <>
      {attached.map(([term, eqs]) => (
        <div key={term} style={{ borderBottom: '1px solid #111827', padding: '10px 16px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#c7d2fe', marginBottom: 6 }}>
            {term} <span style={{ color: '#4b5563', fontWeight: 400, fontSize: 10 }}>· {eqs.length} equation{eqs.length === 1 ? '' : 's'}</span>
          </div>
          {eqs.map(eq => (
            <EquationRow key={eq.id} eq={eq} />
          ))}
        </div>
      ))}
      {unattached.length > 0 && (
        <div style={{ borderTop: '1px solid #1f2937', padding: '12px 16px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
            Unattached ({unattached.length})
          </div>
          {unattached.map(eq => <EquationRow key={eq.id} eq={eq} />)}
        </div>
      )}
    </>
  );
}

function EquationRow({ eq }: { eq: EquationCandidate }) {
  return (
    <div style={{ fontSize: 11, color: '#d1d5db', lineHeight: 1.6, marginBottom: 4 }}>
      <span style={{ color: '#4b5563', marginRight: 6, fontSize: 10 }}>p.{eq.page}</span>
      <code style={{
        background: '#0d0d16', border: '1px solid #1f2937', borderRadius: 3,
        padding: '2px 6px', fontSize: 11, color: '#fde68a',
      }}>
        {eq.latex}
      </code>
      {eq.variables.length > 0 && (
        <span style={{ marginLeft: 8, fontSize: 10, color: '#6b7280' }}>
          vars: {eq.variables.slice(0, 6).join(', ')}
        </span>
      )}
    </div>
  );
}
