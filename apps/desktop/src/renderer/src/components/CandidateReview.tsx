import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  BUCKET_COLOR,
  BUCKET_LABEL,
  BUCKET_HINT,
  CANDIDATE_FILTER_CHIPS,
  RELATION_COLOR,
  SIGNAL_COLOR,
  buildTopicFitPrompt,
  classifyBucket,
  confColor,
  parseTopicFitJson,
  passesBulkPromoteGate,
  type Bucket,
  type Bundle,
  type ConceptCandidate,
  type EquationCandidate,
  type MisconceptionCandidate,
  type RelationCandidate,
  type SubTab,
} from './candidates/shared';
import {
  ConceptsPanel as CandidateConceptsPanel,
  EquationsPanel as CandidateEquationsPanel,
  MisconceptionsPanel as CandidateMisconceptionsPanel,
  RelationsPanel as CandidateRelationsPanel,
} from './candidates/panels';

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
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<'visible' | 'eligible'>('visible');
  const [rejectConfirming, setRejectConfirming] = useState(false);
  // LLM topic-fit filter â€” soft filter on top of the bucket/signal pass.
  const [llmFilterOpen, setLlmFilterOpen]   = useState(false);
  const [llmKeepIds, setLlmKeepIds]         = useState<Set<number> | null>(null);
  const [llmFilterEnabled, setLlmFilterEnabled] = useState(true); // toggle without losing the saved set
  const [llmFilterMsg, setLlmFilterMsg]     = useState<string | null>(null);
  const [llmCopied, setLlmCopied]           = useState(false);
  const [llmPaste, setLlmPaste]             = useState('');
  const [llmApiBusy, setLlmApiBusy]         = useState(false);

  // Persisted LLM filter is stored as normalized terms (stable across
  // re-extracts where row IDs churn). We map terms â†’ current candidate IDs
  // every time the bundle reloads.
  const [llmKeepTerms, setLlmKeepTerms] = useState<Set<string> | null>(null);

  // Single combined refresh â€” loads bundle and saved filter in parallel,
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
    }).catch(e => {
      console.error('[starcall:ipc] candidates.refresh', e);
      setLoading(false);
    });
  }, [sourceId]);

  useEffect(() => { refresh(); }, [refresh]);

  // "/" focuses candidate search (unless already typing); Esc clears + blurs.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === '/' && !typing && subTab === 'concepts') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [subTab]);

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

  // â”€â”€ LLM topic-fit filter helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Generates a prompt that hands the LLM the source title + the current
  // candidate list, asks it to flag which belong to the book's topic. Parses
  // the response and sets a soft filter on the list (no DB writes).
  async function copyTopicFitPrompt(): Promise<void> {
    await navigator.clipboard.writeText(topicFitPrompt);
    setLlmCopied(true);
    setTimeout(() => setLlmCopied(false), 2000);
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
    const unmatchedPart = unmatched > 0 ? ` (${unmatched} stale decision${unmatched === 1 ? '' : 's'} ignored)` : '';
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

  async function runConfiguredLlmFilter(): Promise<void> {
    if (filtered.length === 0) {
      setBulkMsg('No visible candidates to send to the configured LLM filter.');
      return;
    }
    setLlmApiBusy(true);
    setBulkMsg(null);
    setLlmFilterMsg(
      `Filtering ${filtered.length} visible candidate${filtered.length === 1 ? '' : 's'} with your configured LLM(s) — ` +
      `batched and paced to respect provider rate limits. This may take a moment…`,
    );
    const unsubProgress = window.api.candidates.onLlmFilterProgress(p => {
      setLlmFilterMsg(`Filtering… batch ${p.done}/${p.total} · ${p.sent} candidates checked`);
    });
    try {
      const result = await window.api.candidates.llmFilter({
        sourceId,
        sourceTitle,
        fullCoverage: true,
        candidates: filtered.map(c => ({
          id: c.id,
          normalized: c.normalized,
          term: c.term,
          mention_count: c.mention_count,
          first_page: c.first_page,
          final_score: c.final_score ?? c.concept_score ?? c.confidence,
          confidence: c.confidence,
          signals: c.signals,
          labels: c.labels,
        })),
      });
      applyTopicFitFilter(JSON.stringify({ decisions: result.decisions }));
      const provLabel = result.providers && result.providers.length > 0 ? result.providers.join(' + ') : result.provider;
      setBulkMsg(
        `LLM filter (${provLabel}) kept ${result.keepTerms.length} of ${result.sent} candidates` +
        `${result.batches ? ` across ${result.batches} batch${result.batches === 1 ? '' : 'es'}` : ''}. ` +
        (result.sent < filtered.length ? `${filtered.length - result.sent} beyond the per-run cap were left for a later pass.` : ''),
      );
    } catch (e) {
      const msg = `LLM filter failed: ${e instanceof Error ? e.message : String(e)}`;
      setLlmFilterMsg(msg);
      setBulkMsg(msg);
    } finally {
      unsubProgress();
      setLlmApiBusy(false);
    }
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

  async function rejectAllFiltered(ids: number[]) {
    setBulkBusy(true);
    setBulkMsg(null);
    try {
      const r = await window.api.candidates.rejectBulk(ids);
      const idSet = new Set(ids);
      setBundle(b => ({ ...b, concepts: b.concepts.filter(c => !idSet.has(c.id)) }));
      setBulkMsg(`Rejected ${r.rejected} candidate${r.rejected === 1 ? '' : 's'}`);
      onPromoted?.();
    } catch (e) {
      setBulkMsg(`Bulk reject failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBulkBusy(false);
      setRejectConfirming(false);
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

  async function createRelation(input: { from: string; to: string; kind: string; quote?: string; page?: number }) {
    const created = await window.api.candidates.relationCreate({ sourceId, ...input }) as RelationCandidate;
    setBundle(b => ({ ...b, relations: [...b.relations, created] }));
  }

  async function updateRelation(id: number, input: { from: string; to: string; kind: string; quote?: string; page?: number }) {
    const updated = await window.api.candidates.relationUpdate({ id, ...input }) as RelationCandidate;
    setBundle(b => ({ ...b, relations: b.relations.map(r => r.id === id ? updated : r) }));
  }

  async function deleteRelation(id: number) {
    await window.api.candidates.relationDelete(id);
    setBundle(b => ({ ...b, relations: b.relations.filter(r => r.id !== id) }));
  }

  async function createMisconception(input: { quote: string; page?: number; section_path?: string[] }) {
    const created = await window.api.candidates.misconceptionCreate({ sourceId, ...input }) as MisconceptionCandidate;
    setBundle(b => ({ ...b, misconceptions: [...b.misconceptions, created] }));
  }

  async function updateMisconception(id: number, input: { quote: string; page?: number; section_path?: string[] }) {
    const updated = await window.api.candidates.misconceptionUpdate({ id, ...input }) as MisconceptionCandidate;
    setBundle(b => ({ ...b, misconceptions: b.misconceptions.map(m => m.id === id ? updated : m) }));
  }

  async function deleteMisconception(id: number) {
    await window.api.candidates.misconceptionDelete(id);
    setBundle(b => ({ ...b, misconceptions: b.misconceptions.filter(m => m.id !== id) }));
  }

  async function createEquation(input: { latex: string; page?: number; variables?: string[]; section_path?: string[]; attached_term?: string | null }) {
    const created = await window.api.candidates.equationCreate({ sourceId, ...input }) as EquationCandidate;
    setBundle(b => ({ ...b, equations: [...b.equations, created] }));
  }

  async function updateEquation(id: number, input: { latex: string; page?: number; variables?: string[]; section_path?: string[]; attached_term?: string | null }) {
    const updated = await window.api.candidates.equationUpdate({ id, ...input }) as EquationCandidate;
    setBundle(b => ({ ...b, equations: b.equations.map(eq => eq.id === id ? updated : eq) }));
  }

  async function deleteEquation(id: number) {
    await window.api.candidates.equationDelete(id);
    setBundle(b => ({ ...b, equations: b.equations.filter(eq => eq.id !== id) }));
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
  const searchQuery = search.trim().toLowerCase();
  const filtered = withBucket.filter(c =>
    (bucket === 'all' || c.bucket === bucket) &&
    (c.final_score ?? c.concept_score ?? c.confidence) >= minConf &&
    (signalFilter === 'any' || c.signals.includes(signalFilter) || (c.labels ?? []).includes(signalFilter)) &&
    (!llmFilterEnabled || llmKeepIds === null || llmKeepIds.has(c.id)) &&
    (searchQuery === '' || c.term.toLowerCase().includes(searchQuery) || c.normalized.toLowerCase().includes(searchQuery)),
  );
  // Count of candidates per signal/label for the chip pills (respects bucket + LLM filter).
  const filterCounts: Record<string, number> = {};
  for (const c of withBucket) {
    if (bucket !== 'all' && c.bucket !== bucket) continue;
    if (llmFilterEnabled && llmKeepIds !== null && !llmKeepIds.has(c.id)) continue;
    const keys = new Set([...(c.signals ?? []), ...(c.labels ?? [])]);
    for (const s of keys) filterCounts[s] = (filterCounts[s] ?? 0) + 1;
  }
  const knownNormalized = new Set(bundle.concepts.map(c => c.normalized));
  const topicFitPrompt = buildTopicFitPrompt(sourceTitle, filtered);
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
          ? `Promotes every candidate that passes the safe-default gate: final_score >= 0.80, no suspicious labels, and definition, strong typography, or repeated domain evidence. Ignores the current bucket and signal filters.`
          : `Bulk-creates concept rows from every visible candidate (bucket "${BUCKET_LABEL[bucket]}", signal "${signalFilter}", min score ${minConf.toFixed(2)}). No LLM calls - pure DB upserts. Tasks generate lazily on first review.`;
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

      {rejectConfirming && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 50,
          background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#0d0d16', border: '1px solid #1f2937', borderRadius: 8,
            padding: 20, width: 440, display: 'flex', flexDirection: 'column', gap: 12,
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#fca5a5' }}>
              Reject {filtered.length} candidate{filtered.length === 1 ? '' : 's'}?
            </div>
            <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.6 }}>
              Rejects every visible candidate (bucket "{BUCKET_LABEL[bucket]}", signal "{signalFilter}", min score {minConf.toFixed(2)}). This deletes the candidate rows; it does not touch already-promoted concepts. Re-extract can regenerate candidates.
              <div style={{ marginTop: 8, color: '#6b7280', fontSize: 11 }}>
                Top of list: {filtered.slice(0, 3).map(c => c.term).join(' · ')}{filtered.length > 3 ? ` … +${filtered.length - 3} more` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button
                onClick={() => setRejectConfirming(false)}
                disabled={bulkBusy}
                style={{ background: 'transparent', border: '1px solid #374151', borderRadius: 4, padding: '5px 14px', color: '#9ca3af', fontSize: 12, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={() => rejectAllFiltered(filtered.map(c => c.id))}
                disabled={bulkBusy}
                style={{ background: '#3f1d1d', border: '1px solid #ef4444', borderRadius: 4, padding: '5px 14px', color: '#fecaca', fontSize: 12, cursor: bulkBusy ? 'wait' : 'pointer', fontWeight: 600 }}
              >
                {bulkBusy ? 'Rejecting…' : `Reject ${filtered.length}`}
              </button>
            </div>
          </div>
        </div>
      )}

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
                Filters all {filtered.length} visible candidate{filtered.length === 1 ? '' : 's'} in paced batches across your configured provider(s).
              </div>
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              alignItems: 'center',
              gap: 12,
              padding: '10px 12px',
              border: '1px solid rgba(129, 140, 248, 0.30)',
              borderRadius: 7,
              background: 'rgba(15, 23, 42, 0.38)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
              backdropFilter: 'blur(10px)',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: '#dbeafe' }}>Configured LLM</span>
                  <span style={{
                    fontSize: 10,
                    color: '#93c5fd',
                    border: '1px solid rgba(96, 165, 250, 0.36)',
                    borderRadius: 999,
                    padding: '1px 7px',
                    background: 'rgba(37, 99, 235, 0.12)',
                    whiteSpace: 'nowrap',
                  }}>
                    {filtered.length} visible
                  </span>
                </div>
                <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.45, marginTop: 4 }}>
                  Runs a compact API batch using your Profile settings, then saves the kept concepts.
                </div>
              </div>
              <button
                onClick={runConfiguredLlmFilter}
                disabled={llmApiBusy || filtered.length === 0}
                title="Use the API provider and model selected in Profile settings to filter the currently visible candidates."
                style={{
                  background: llmApiBusy || filtered.length === 0
                    ? 'rgba(15, 23, 42, 0.42)'
                    : 'rgba(79, 70, 229, 0.34)',
                  border: `1px solid ${llmApiBusy || filtered.length === 0 ? 'rgba(71, 85, 105, 0.44)' : 'rgba(129, 140, 248, 0.72)'}`,
                  borderRadius: 6,
                  padding: '6px 13px',
                  color: llmApiBusy || filtered.length === 0 ? '#64748b' : '#dbeafe',
                  fontSize: 11,
                  fontWeight: 800,
                  cursor: llmApiBusy || filtered.length === 0 ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                  boxShadow: llmApiBusy || filtered.length === 0 ? 'none' : '0 0 18px rgba(79, 70, 229, 0.16)',
                }}
              >
                {llmApiBusy ? 'Filtering...' : 'Run API Filter'}
              </button>
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
              {topicFitPrompt.slice(0, 600)}{topicFitPrompt.length > 600 ? '\n… (truncated; full prompt is on your clipboard)' : ''}
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
              placeholder='Paste e.g. {"decisions":[{"term":"gradient descent","keep":true},{"term":"summary","keep":false}]}'
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

      {/* Top bar â€” bucket chips, counters, slider, and run-extraction */}
      <div style={{
        padding: '8px 16px', borderBottom: '1px solid #1f2937',
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap',
        order: 2,
      }}>
        {subTab === 'concepts' && (
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <input
              ref={searchRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { e.preventDefault(); setSearch(''); searchRef.current?.blur(); }
              }}
              placeholder="Search title…  ( / )"
              style={{
                width: 160, boxSizing: 'border-box',
                background: 'rgba(13,13,22,0.35)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
                border: '1px solid #263244', borderRadius: 3,
                padding: '3px 22px 3px 8px', color: '#e2e8f0', fontSize: 11, outline: 'none',
              }}
            />
            {search && (
              <button
                onClick={() => { setSearch(''); searchRef.current?.focus(); }}
                title="Clear search"
                style={{
                  position: 'absolute', right: 5, background: 'transparent', border: 'none',
                  color: '#6b7280', fontSize: 13, lineHeight: 1, cursor: 'pointer', padding: 0,
                }}
              >×</button>
            )}
          </div>
        )}
        {subTab === 'concepts' && (['all', 'high', 'medium', 'low', 'off_topic', 'broad', 'boilerplate', 'suspicious'] as const).map(b => {
          const count = bucketCounts[b];
          const selected = bucket === b;
          const color = BUCKET_COLOR[b];
          // Hide empty buckets (keep "all" and whatever is currently selected).
          if (count === 0 && b !== 'all' && !selected) return null;
          return (
            <button
              key={b}
              onClick={() => setBucket(b)}
              title={BUCKET_HINT[b]}
              style={{
                background: selected ? 'rgba(129, 140, 248, 0.10)' : 'transparent',
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
                    title={`Promote every candidate that passes the safe-default gate: final_score >= 0.80, no suspicious labels, with definition, strong typography, or repeated domain evidence. Ignores the current bucket filter.`}
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
                {filtered.length > 0 && (
                  <button
                    onClick={() => setRejectConfirming(true)}
                    disabled={bulkBusy}
                    title={`Reject every concept currently visible (respects bucket + signal + slider). Deletes the candidate rows; promoted concepts are untouched.`}
                    style={{
                      background: '#3f1d1d', border: '1px solid #ef4444', borderRadius: 3,
                      padding: '3px 10px', fontSize: 10, cursor: bulkBusy ? 'wait' : 'pointer',
                      color: '#fecaca', opacity: bulkBusy ? 0.5 : 1, fontWeight: 600,
                    }}
                  >
                    {bulkBusy ? 'Rejecting…' : `Reject ${filtered.length} visible`}
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
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '3px 8px',
                border: '1px solid rgba(67, 56, 202, 0.45)',
                borderRadius: 5,
                background: 'rgba(4, 6, 26, 0.38)',
                backdropFilter: 'blur(10px)',
              }}>
                <span style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>min score</span>
                <input
                  className="score-range"
                  type="range" min={0} max={1} step={0.05} value={minConf}
                  onChange={e => setMinConf(parseFloat(e.target.value))}
                  style={{ '--score-fill': `${Math.max(0, Math.min(1, minConf)) * 100}%` } as React.CSSProperties}
                />
                <span style={{ fontSize: 11, color: confColor(minConf), minWidth: 28, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{minConf.toFixed(2)}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Sub-tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid rgba(31, 41, 55, 0.75)', background: 'transparent', flexShrink: 0, order: 1 }}>
        {subTabBtn('concepts',       'Concepts',       bucketCounts.all)}
        {subTabBtn('relations',      'Relations',      bundle.relations.length)}
        {subTabBtn('misconceptions', 'Misconceptions', bundle.misconceptions.length)}
        {subTabBtn('equations',      'Equations',      bundle.equations.length)}
      </div>

      {/* Signal-source chips (Concepts sub-tab only) */}
      {subTab === 'concepts' && (
        <div style={{
          padding: '6px 16px', borderBottom: '1px solid rgba(31, 41, 55, 0.75)',
          display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap',
          background: 'transparent',
          order: 3,
        }}>
          <span style={{ fontSize: 9, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em', marginRight: 4 }}>tag</span>
          {(() => {
            const anyCount = withBucket.filter(c =>
              (bucket === 'all' || c.bucket === bucket) &&
              (!llmFilterEnabled || llmKeepIds === null || llmKeepIds.has(c.id)),
            ).length;
            const chips = [
              { key: 'any', label: 'Any tag', color: '#9ca3af', count: anyCount },
              ...CANDIDATE_FILTER_CHIPS
                .map(chip => ({ ...chip, count: filterCounts[chip.key] ?? 0 }))
                .filter(chip => chip.count > 0 || signalFilter === chip.key),
            ];
            return chips.map(({ key, label, color, count }) => {
            const selected = signalFilter === key;
            return (
              <button
                key={key}
                onClick={() => setSignalFilter(key)}
                style={{
                  background: selected ? 'rgba(129, 140, 248, 0.10)' : 'transparent',
                  border: `1px solid ${selected ? color : '#1f2937'}`,
                  color: selected ? color : '#6b7280',
                  borderRadius: 3, padding: '2px 7px', fontSize: 10, cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                {label} <span style={{ color: selected ? color : '#4b5563', marginLeft: 3 }}>{count}</span>
              </button>
            );
            });
          })()}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', order: 4 }}>
        {loading && (
          <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 12 }}>Loading candidates…</div>
        )}

        {!loading && subTab === 'concepts' && (
          <CandidateConceptsPanel
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
          <CandidateRelationsPanel
            relations={bundle.relations}
            knownTerms={knownNormalized}
            onCreate={createRelation}
            onUpdate={updateRelation}
            onDelete={deleteRelation}
          />
        )}

        {!loading && subTab === 'misconceptions' && (
          <CandidateMisconceptionsPanel
            misconceptions={bundle.misconceptions}
            onCreate={createMisconception}
            onUpdate={updateMisconception}
            onDelete={deleteMisconception}
          />
        )}

        {!loading && subTab === 'equations' && (
          <CandidateEquationsPanel
            equations={bundle.equations}
            unattached={unattachedEquations}
            byTerm={equationsByTerm}
            onCreate={createEquation}
            onUpdate={updateEquation}
            onDelete={deleteEquation}
          />
        )}
      </div>
    </div>
  );
}
