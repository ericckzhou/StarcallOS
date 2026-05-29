import React, { useCallback, useEffect, useState } from 'react';

interface ParseRun {
  id: number;
  source_id: number;
  started_at: string;
  completed_at: string | null;
  status: 'success' | 'failed' | 'interrupted';
  error_msg: string | null;
  mode: 'deterministic' | 'candidate_gated' | 'full';
  parser_version: string;
  grammar_version: string;
  layout_version: string;
  page_count: number;
  block_count: number;
  candidate_count: number;
  relation_count: number;
  equation_count: number;
  misconception_count: number;
  duration_ms: number;
  llm_call_count: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
  diagnostics: Record<string, unknown>;
}

const STATUS_COLOR: Record<ParseRun['status'], string> = {
  success:     '#22c55e',
  failed:      '#ef4444',
  interrupted: '#f59e0b',
};

const MODE_COLOR: Record<ParseRun['mode'], string> = {
  deterministic:   '#22c55e',
  candidate_gated: '#818cf8',
  full:            '#f59e0b',
};

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface Props {
  sourceId: number;
}

export default function ParseRunsPanel({ sourceId }: Props) {
  const [runs, setRuns] = useState<ParseRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    window.api.parseRuns.bySource(sourceId, 10).then(r => {
      setRuns(r as ParseRun[]);
      setLoading(false);
    });
  }, [sourceId]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid #1f2937',
        display: 'flex', alignItems: 'center', gap: 16,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          Parse Runs — {runs.length}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && (
          <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 12 }}>Loading runs…</div>
        )}
        {!loading && runs.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: '#374151', fontSize: 12, lineHeight: 1.6 }}>
            No parse runs recorded yet for this source.<br />
            Click Process to run the parser — every run will append here.
          </div>
        )}
        {!loading && runs.map(r => {
          const isOpen = expanded === r.id;
          const statusColor = STATUS_COLOR[r.status];
          const modeColor = MODE_COLOR[r.mode];
          return (
            <div key={r.id} style={{ borderBottom: '1px solid #111827' }}>
              <button
                onClick={() => setExpanded(isOpen ? null : r.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: isOpen ? 'rgba(26,26,46,0.45)' : 'transparent',
                  border: 'none', padding: '10px 16px', cursor: 'pointer',
                  borderLeft: `3px solid ${statusColor}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, color: statusColor,
                    border: `1px solid ${statusColor}`, borderRadius: 2,
                    padding: '1px 6px', textTransform: 'uppercase',
                  }}>
                    {r.status}
                  </span>
                  <span style={{
                    fontSize: 10, color: modeColor,
                    border: `1px solid ${modeColor}`, borderRadius: 2,
                    padding: '1px 6px',
                  }}>
                    {r.mode}
                  </span>
                  <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 6 }}>{fmtTime(r.started_at)}</span>
                  <span style={{ fontSize: 10, color: '#6b7280', marginLeft: 'auto' }}>{fmtDuration(r.duration_ms)}</span>
                </div>
                <div style={{ paddingLeft: 4, display: 'flex', gap: 12, fontSize: 11, color: '#9ca3af', flexWrap: 'wrap' }}>
                  <span><span style={{ color: '#4b5563' }}>blocks</span> {r.block_count.toLocaleString()}</span>
                  <span><span style={{ color: '#4b5563' }}>candidates</span> {r.candidate_count}</span>
                  <span><span style={{ color: '#4b5563' }}>relations</span> {r.relation_count}</span>
                  <span><span style={{ color: '#4b5563' }}>equations</span> {r.equation_count}</span>
                  <span><span style={{ color: '#4b5563' }}>misconceptions</span> {r.misconception_count}</span>
                  {r.llm_call_count > 0 && (
                    <span style={{ color: '#fbbf24' }}>
                      <span style={{ color: '#4b5563' }}>LLM</span> {r.llm_call_count} calls · {fmtTokens(r.llm_input_tokens + r.llm_output_tokens)} tok
                    </span>
                  )}
                </div>
              </button>

              {isOpen && (
                <div style={{ padding: '8px 16px 14px 22px', background: 'rgba(13,13,22,0.35)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', borderTop: '1px dashed #1f2937', fontSize: 11, color: '#9ca3af', lineHeight: 1.6 }}>
                  {r.error_msg && (
                    <div style={{
                      marginBottom: 10, padding: '8px 10px', borderRadius: 4,
                      background: '#1a0a0a', border: '1px solid #3f1515', color: '#fca5a5',
                    }}>
                      <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 4 }}>ERROR</div>
                      <div style={{ fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {r.error_msg}
                      </div>
                    </div>
                  )}
                  <KV label="page_count"   value={r.page_count.toLocaleString()} />
                  <KV label="block_count"  value={r.block_count.toLocaleString()} />
                  <KV label="duration"     value={fmtDuration(r.duration_ms)} />
                  <KV label="LLM input"    value={`${fmtTokens(r.llm_input_tokens)} tok`} />
                  <KV label="LLM output"   value={`${fmtTokens(r.llm_output_tokens)} tok`} />
                  <KV label="parser"       value={r.parser_version} mono />
                  <KV label="grammar"      value={r.grammar_version} mono />
                  <KV label="layout"       value={r.layout_version} mono />
                  <ParserQuality diagnostics={r.diagnostics} blockCount={r.block_count} />
                  {Object.keys(r.diagnostics).length > 0 && (
                    <details style={{ marginTop: 8 }}>
                      <summary style={{ cursor: 'pointer', color: '#6b7280', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                        diagnostics_json
                      </summary>
                      <pre style={{
                        marginTop: 6, padding: 10, borderRadius: 4,
                        background: '#000', color: '#86efac',
                        fontSize: 10, lineHeight: 1.5,
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        fontFamily: 'ui-monospace, Consolas, monospace',
                        maxHeight: 280, overflow: 'auto',
                      }}>
                        {JSON.stringify(r.diagnostics, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// First-class parser quality indicators derived from the run diagnostics blob.
// section-path fidelity is the leverage point for candidate ranking quality.
function ParserQuality({ diagnostics, blockCount }: { diagnostics: Record<string, unknown>; blockCount: number }) {
  const num = (v: unknown): number | null => (typeof v === 'number' && !isNaN(v) ? v : null);
  const cand = (diagnostics.candidate_diagnostics ?? {}) as Record<string, unknown>;
  const blocksSeen = num(cand.blocks_seen) ?? blockCount;
  const sectionedBlocks = num(cand.sectioned_blocks);
  const headingBlocks = num(diagnostics.heading_block_count);
  const runningHeaderSections = num(diagnostics.running_header_sections);
  const runningHeaderCandidates = num(cand.running_header_candidates);
  const mixedCandidates = num(cand.mixed_section_candidates);

  const pct = (n: number | null, d: number | null): string =>
    n != null && d != null && d > 0 ? `${Math.round((n / d) * 100)}%` : '—';

  // Only render when at least one section/heading metric is present.
  if (sectionedBlocks == null && headingBlocks == null && runningHeaderSections == null) return null;

  return (
    <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px dashed #1f2937' }}>
      <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>
        parser quality
      </div>
      <KV label="sectioned_blocks" value={`${pct(sectionedBlocks, blocksSeen)}${sectionedBlocks != null ? ` (${sectionedBlocks}/${blocksSeen})` : ''}`} />
      <KV label="heading_blocks"  value={`${pct(headingBlocks, blocksSeen)}${headingBlocks != null ? ` (${headingBlocks}/${blocksSeen})` : ''}`} />
      <KV label="running_header_sections" value={runningHeaderSections != null ? String(runningHeaderSections) : '—'} />
      {(runningHeaderCandidates != null || mixedCandidates != null) && (
        <KV label="header→section" value={`${runningHeaderCandidates ?? 0} running · ${mixedCandidates ?? 0} mixed`} />
      )}
    </div>
  );
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <span style={{ minWidth: 90, color: '#4b5563' }}>{label}</span>
      <span style={{ color: '#d1d5db', fontFamily: mono ? 'ui-monospace, Consolas, monospace' : undefined }}>{value}</span>
    </div>
  );
}
