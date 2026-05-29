import React, { useEffect, useRef, useState } from 'react';

export interface ConstellationLink {
  name: string;
  reason: string;
}

interface Hit {
  id: number;
  name: string;
  importance: string;
  source_filename?: string;
}

interface Props {
  conceptId: number;
  value: ConstellationLink[];
  onChange: (next: ConstellationLink[]) => void;
}

const IMP_COLOR: Record<string, string> = {
  foundational: '#f59e0b', core: '#818cf8', supporting: '#22d3ee',
  peripheral: '#6b7280', reference_only: '#374151',
};

interface EvidenceOption {
  index: number;
  page: number;
  kind: string;
  label: string;
  quote?: string;
}

function evidenceReason(ev: EvidenceOption): string {
  const text = (ev.quote || ev.label || ev.kind || '').trim().replace(/\s+/g, ' ').slice(0, 110);
  return `p.${ev.page}: ${text}`;
}

// Clip to n chars, appending an ellipsis when the text was actually truncated.
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function evidenceTitle(ev: EvidenceOption): string {
  return clip(`p.${ev.page} ${(ev.quote || ev.label || ev.kind || '').trim()}`, 64);
}

// Typeahead concept linker. Selecting a concept does NOT immediately add it —
// the user must first state WHY the two concepts relate; that reason is stored
// alongside the link and surfaced on the Constellation Map.
export default function WhereItReappearsEditor({ conceptId, value, onChange }: Props) {
  const [input, setInput] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  // A link awaiting its reason. editIndex = index in `value` being edited, or
  // null when it's a brand-new link.
  const [pending, setPending] = useState<{ name: string; targetId: number | null; reason: string; editIndex: number | null; evLabel?: string } | null>(null);
  const [evOpen, setEvOpen] = useState(false);
  const [evOptions, setEvOptions] = useState<EvidenceOption[]>([]);
  const [evLoading, setEvLoading] = useState(false);
  // Target concept's highlights + notes, used to resolve an evidence span back
  // to the note linked to its backing highlight (if any).
  const [targetHighlights, setTargetHighlights] = useState<Array<{ id: number; page: number; selected_text: string }>>([]);
  const [targetNotes, setTargetNotes] = useState<Array<{ id: number; heading: string; body: string; linked_annotation_id: number | null }>>([]);
  const queryIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const prefix = input.trim();
    if (prefix.length === 0) { setHits([]); setOpen(false); return; }
    const myQueryId = ++queryIdRef.current;
    debounceRef.current = setTimeout(() => {
      window.api.concepts.searchByPrefix({ conceptId, prefix, limit: 8 }).then(rows => {
        if (myQueryId !== queryIdRef.current) return;
        const selected = new Set(value.map(v => v.name.toLowerCase()));
        const filtered = (rows as Hit[]).filter(h => !selected.has(h.name.toLowerCase()));
        setHits(filtered);
        setActiveIdx(0);
        setOpen(filtered.length > 0);
      });
    }, 120);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [input, conceptId, value]);

  // Bumped when evidence changes elsewhere (e.g. a highlight is added in the
  // source viewer) so the open selector refreshes instead of going stale.
  const [evRefreshTick, setEvRefreshTick] = useState(0);
  useEffect(() => {
    const handler = () => setEvRefreshTick(t => t + 1);
    window.addEventListener('starcall:evidenceChanged', handler);
    return () => window.removeEventListener('starcall:evidenceChanged', handler);
  }, []);

  // Load the linked (target) concept's evidence spans so the reason can point
  // at one of them. Re-runs whenever the pending link's target changes.
  const targetId = pending?.targetId ?? null;
  useEffect(() => {
    if (targetId == null) { setEvOptions([]); setTargetHighlights([]); setTargetNotes([]); return; }
    let cancelled = false;
    setEvLoading(true);
    (async () => {
      const meta = await window.api.concepts.sourceEvidence(targetId);
      if (cancelled) return;
      setEvOptions(((meta?.evidence ?? []) as EvidenceOption[]));
      if (meta?.sourceId != null) {
        const anns = await window.api.sources.annotations.list(meta.sourceId);
        if (cancelled) return;
        // Include source-wide highlights too — a note may link to either.
        setTargetHighlights(anns
          .filter(a => a.type === 'highlight' && (a.concept_id === targetId || a.scope === 'source'))
          .map(a => ({ id: a.id, page: a.page, selected_text: a.selected_text })));
      } else {
        setTargetHighlights([]);
      }
      const notes = await window.api.concepts.notes.list(targetId);
      if (cancelled) return;
      setTargetNotes((notes as Array<{ id: number; heading: string; body: string; linked_annotation_id: number | null }>));
    })().catch(() => {
      if (!cancelled) { setEvOptions([]); setTargetHighlights([]); setTargetNotes([]); }
    }).finally(() => { if (!cancelled) setEvLoading(false); });
    return () => { cancelled = true; };
  }, [targetId, evRefreshTick]);

  // Resolve an evidence span to the note linked to its backing highlight, if
  // any. Highlights create evidence spans (kind 'highlight') carrying the
  // selected text; a note may link to that highlight via linked_annotation_id.
  function noteTextForEvidence(ev: EvidenceOption): string | null {
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    const evq = norm(ev.quote ?? '');
    if (!evq) return null;
    // Match the backing highlight on the same page. Use containment (either
    // direction) so a truncated evidence quote still matches its highlight.
    const hl = targetHighlights.find(a => {
      if (a.page !== ev.page) return false;
      const at = norm(a.selected_text);
      return !!at && (at === evq || at.includes(evq) || evq.includes(at));
    });
    if (!hl) return null;
    const note = targetNotes.find(n => n.linked_annotation_id === hl.id);
    if (!note) return null;
    const txt = (note.body?.trim() || note.heading?.trim() || '');
    return txt || null;
  }

  // Close the editor when the surrounding concept changes (e.g. switching tabs
  // from Timothy to Corinthians) — otherwise a stale pending link from the
  // previous concept would render as a self-relationship on the new one.
  useEffect(() => {
    setPending(null);
    setInput('');
    setHits([]);
    setOpen(false);
    setEvOpen(false);
  }, [conceptId]);

  function beginAdd(h: Hit) {
    setPending({ name: h.name, targetId: h.id, reason: '', editIndex: null });
    setInput(''); setHits([]); setOpen(false);
    setTimeout(() => reasonRef.current?.focus(), 0);
  }

  async function beginEdit(i: number) {
    const link = value[i];
    setPending({ name: link.name, targetId: null, reason: link.reason, editIndex: i });
    setTimeout(() => reasonRef.current?.focus(), 0);
    // Existing links only store the name — resolve the target id so its
    // evidence spans can populate the selector.
    try {
      const rows = await window.api.concepts.searchByPrefix({ conceptId, prefix: link.name, limit: 8 });
      const exact = (rows as Hit[]).find(h => h.name.toLowerCase() === link.name.toLowerCase());
      if (exact) setPending(p => (p && p.editIndex === i ? { ...p, targetId: exact.id } : p));
    } catch { /* selector simply stays empty if resolution fails */ }
  }

  function confirmPending() {
    if (!pending) return;
    const reason = pending.reason.trim();
    if (!reason) return; // reason is required
    const link: ConstellationLink = { name: pending.name, reason };
    if (pending.editIndex == null) onChange([...value, link]);
    else onChange(value.map((l, idx) => (idx === pending.editIndex ? link : l)));
    setPending(null);
  }

  function removeAt(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
    if (pending?.editIndex === i) setPending(null);
  }

  function addBestHit() {
    if (hits.length === 0) return;
    const exact = hits.find(h => h.name.toLowerCase() === input.trim().toLowerCase());
    beginAdd(exact ?? hits[0]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || hits.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(hits.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); beginAdd(hits[activeIdx]); }
    else if (e.key === 'Escape') { setOpen(false); }
  }

  function renderReasonBox() {
    if (!pending) return null;
    const ready = pending.reason.trim().length > 0;
    // On reopen we only have the stored reason (which may be a note's text).
    // Reverse-match it to an evidence span so the selector shows that span's
    // TITLE, not the note text.
    const r = pending.reason.trim();
    const matchedEv = r
      ? evOptions.find(ev => evidenceReason(ev) === r || noteTextForEvidence(ev) === r)
      : undefined;
    const matchedLabel = matchedEv ? evidenceTitle(matchedEv) : null;
    return (
      <div style={{ border: '1px solid #4338ca', borderRadius: 8, padding: 10, background: 'rgba(13,13,22,0.86)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12, color: '#c7d2fe' }}>
          Why does this relate to <span style={{ fontWeight: 800 }}>{pending.name}</span>?
        </div>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setEvOpen(o => !o)}
            onBlur={() => setTimeout(() => setEvOpen(false), 120)}
            disabled={evOptions.length === 0}
            title={evOptions.length === 0 ? `${pending.name} has no evidence spans to link to` : `Link to an evidence span in ${pending.name}`}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: 'transparent', border: '1px solid #263244', borderRadius: 4,
              padding: '5px 8px', color: evOptions.length === 0 ? '#475569' : '#c7d2fe', fontSize: 11,
              cursor: evOptions.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: (pending.evLabel || matchedLabel) ? '#e0e7ff' : undefined }}>
              {evLoading
                ? 'Loading evidence…'
                : pending.evLabel
                  ? pending.evLabel
                  : matchedLabel
                    ? matchedLabel
                    : evOptions.length === 0
                      ? `No evidence in ${pending.name}`
                      : `Link to evidence in ${pending.name}…`}
            </span>
            <span style={{ color: '#6b7280' }}>▾</span>
          </button>
          {evOpen && evOptions.length > 0 && (
            <div
              role="listbox"
              style={{
                position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2, zIndex: 20,
                background: 'rgba(13,13,22,0.6)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                border: '1px solid #312e81', borderRadius: 6,
                maxHeight: 240, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              }}
            >
              {evOptions.map(ev => (
                <button
                  key={ev.index}
                  type="button"
                  className="rel-opt"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => {
                    // Prefer the note linked to this span's highlight; fall back
                    // to the evidence title.
                    const reason = noteTextForEvidence(ev) ?? evidenceReason(ev);
                    const evLabel = evidenceTitle(ev);
                    setPending(p => (p ? { ...p, reason, evLabel } : p));
                    setEvOpen(false);
                    setTimeout(() => reasonRef.current?.focus(), 0);
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'transparent',
                    border: 'none', padding: '6px 10px', fontSize: 11, color: '#e2e8f0', cursor: 'pointer',
                  }}
                >
                  <span style={{ flexShrink: 0, color: '#818cf8', fontWeight: 700 }}>p.{ev.page}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {(ev.quote || ev.label || ev.kind || '').trim() || '(no text)'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <textarea
          ref={reasonRef}
          value={pending.reason}
          onChange={e => setPending(p => (p ? { ...p, reason: e.target.value } : p))}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); confirmPending(); }
            else if (e.key === 'Escape') { e.preventDefault(); setPending(null); }
          }}
          placeholder={`Pick an evidence span in ${pending.name} above, or write why they relate…`}
          rows={3}
          style={{ background: '#111827', border: '1px solid #263244', borderRadius: 4, padding: '7px 9px', color: '#e2e8f0', fontSize: 12, lineHeight: 1.5, resize: 'vertical', outline: 'none', fontFamily: 'inherit' }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={confirmPending}
            disabled={!ready}
            title={ready ? '' : 'A reason is required'}
            style={{ background: ready ? '#312e81' : '#111827', border: `1px solid ${ready ? '#6366f1' : '#1f2937'}`, borderRadius: 4, padding: '5px 12px', color: ready ? '#e0e7ff' : '#475569', fontSize: 12, fontWeight: 700, cursor: ready ? 'pointer' : 'not-allowed' }}
          >
            {pending.editIndex == null ? 'Link' : 'Save reason'}
          </button>
          <button
            onClick={() => setPending(null)}
            style={{ background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, padding: '5px 12px', color: '#94a3b8', fontSize: 12, cursor: 'pointer' }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {value.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          {value.map((link, i) => (
            pending && pending.editIndex === i ? (
              <div key={`edit-${i}`}>{renderReasonBox()}</div>
            ) : (
            <div
              key={`${link.name}-${i}`}
              className="cm-link-card"
              role="button"
              tabIndex={0}
              onClick={() => beginEdit(i)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); beginEdit(i); } }}
              title="Edit reason"
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: '#1e1b4b', border: '1px solid #312e81', borderRadius: 8,
                padding: '7px 8px 7px 0', cursor: 'pointer', overflow: 'hidden',
              }}
            >
              {/* Left accent bar for visual hierarchy. */}
              <span style={{ alignSelf: 'stretch', width: 3, borderRadius: 3, background: '#6366f1', flexShrink: 0 }} aria-hidden="true" />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#e0e7ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {link.name}
                </span>
                {/* Reason stays hidden on the card — click to reveal/edit it.
                    A faint dot just signals a reason exists vs. needs one. */}
                <span
                  title={link.reason ? 'Has a reason — click to view/edit' : 'No reason yet — click to add'}
                  style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: link.reason ? '#818cf8' : 'transparent', border: link.reason ? 'none' : '1px solid #475569' }}
                  aria-hidden="true"
                />
              </div>
              {/* Edit affordance (appears on hover/focus). */}
              <span className="cm-link-edit" aria-hidden="true" style={{ flexShrink: 0, color: '#a5b4fc', display: 'inline-flex' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </span>
              <button
                className="cm-link-del"
                onClick={e => { e.stopPropagation(); removeAt(i); }}
                title={`Remove "${link.name}"`}
                aria-label={`Remove link to ${link.name}`}
                style={{
                  background: 'transparent', border: 'none', color: '#a5b4fc',
                  fontSize: 15, lineHeight: 1, cursor: 'pointer', flexShrink: 0,
                  width: 22, height: 22, borderRadius: 5, marginRight: 6,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}
              >×</button>
            </div>
            )
          ))}
        </div>
      )}

      {pending == null ? (
        <div style={{ position: 'relative' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 6 }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              onFocus={() => { if (hits.length > 0) setOpen(true); }}
              onBlur={() => setTimeout(() => setOpen(false), 120)}
              placeholder="Type to link any concept..."
              style={{
                width: '100%', background: '#0d0d16', border: '1px solid #1f2937',
                borderRadius: 4, padding: '6px 10px', color: '#e2e8f0', fontSize: 12,
                outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
              }}
            />
            <button
              type="button"
              disabled={hits.length === 0}
              onMouseDown={e => e.preventDefault()}
              onClick={addBestHit}
              title={hits.length > 0 ? `Link ${hits[0].name}` : 'Type a matching concept name first'}
              style={{
                background: hits.length > 0 ? '#1e1b4b' : 'transparent',
                border: hits.length > 0 ? '1px solid #6366f1' : '1px solid #1f2937',
                borderRadius: 4, color: hits.length > 0 ? '#c7d2fe' : '#475569',
                cursor: hits.length > 0 ? 'pointer' : 'not-allowed',
                fontSize: 11, fontWeight: 700, padding: '0 10px', whiteSpace: 'nowrap',
              }}
            >
              + Link
            </button>
          </div>
          {open && hits.length > 0 && (
            <div
              role="listbox"
              style={{
                position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2, zIndex: 10,
                background: '#0d0d16', border: '1px solid #1f2937', borderRadius: 4,
                maxHeight: 240, overflowY: 'auto', boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
              }}
            >
              {hits.map((h, i) => (
                <button
                  key={h.id}
                  role="option"
                  aria-selected={i === activeIdx}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => beginAdd(h)}
                  onMouseEnter={() => setActiveIdx(i)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    background: i === activeIdx ? '#1e1b4b' : 'transparent',
                    border: 'none', textAlign: 'left',
                    padding: '6px 10px', fontSize: 12, color: '#e2e8f0', cursor: 'pointer',
                  }}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {h.name}
                  </span>
                  <span style={{ fontSize: 10, color: IMP_COLOR[h.importance] ?? '#6b7280' }}>
                    {h.importance}
                  </span>
                  {h.source_filename && (
                    <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, color: '#64748b' }}>
                      {h.source_filename}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : pending.editIndex == null ? renderReasonBox() : null}
    </div>
  );
}
