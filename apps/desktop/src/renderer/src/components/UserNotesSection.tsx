import React, { useEffect, useRef, useState } from 'react';

// Notes record reserved for the DetailPane "Paper" tab; hidden from this list
// so the scratchpad and structured notes don't visually collide.
const PAPER_NOTE_HEADING = '__paper__';

interface Note {
  id: number;
  concept_id: number;
  position: number;
  heading: string;
  body: string;
  linked_annotation_id: number | null;
}

// Minimal shape of a PDF highlight we can link a note to.
interface HighlightOption {
  id: number;
  page: number;
  snippet: string;
  color: string;
}

interface Props {
  conceptId: number;
  sourceId: number;
  onJumpToAnnotation: (page: number) => void;
}

// User-authored free-form notes rendered below the LLM-managed Overview
// fields. CRUD against window.api.concepts.notes; survives every other
// operation (re-extract, enrich, regenerate) via FK cascade + the
// cleanup module never touching this table.
export default function UserNotesSection({ conceptId, sourceId, onJumpToAnnotation }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [highlights, setHighlights] = useState<HighlightOption[]>([]);
  // Soft-delete with a 5s undo window instead of a confirm popup.
  const [pendingDeletes, setPendingDeletes] = useState<Note[]>([]);
  const deleteTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    setLoading(true);
    window.api.concepts.notes.list(conceptId).then(rows => {
      setNotes((rows as Note[]).filter(n => n.heading !== PAPER_NOTE_HEADING));
      setLoading(false);
    });
  }, [conceptId]);

  // Highlights this note can link to: this concept's highlights plus any
  // source-wide highlights (all are visible in this concept's source viewer).
  useEffect(() => {
    let cancelled = false;
    window.api.sources.annotations.list(sourceId).then(rows => {
      if (cancelled) return;
      const opts = rows
        .filter(a => a.type === 'highlight' && (a.concept_id === conceptId || a.scope === 'source'))
        .map(a => ({
          id: a.id,
          page: a.page,
          snippet: (a.selected_text || a.label || '').trim().replace(/\s+/g, ' ').slice(0, 80) || `Highlight p.${a.page}`,
          color: a.color,
        }));
      setHighlights(opts);
    }).catch(() => { if (!cancelled) setHighlights([]); });
    return () => { cancelled = true; };
  }, [sourceId, conceptId]);

  async function addNote() {
    const created = await window.api.concepts.notes.create({
      conceptId,
      heading: 'Untitled note',
      body: '',
    });
    setNotes(prev => [...prev, created as Note]);
  }

  async function saveNote(id: number, patch: { heading?: string; body?: string; linkedAnnotationId?: number | null }) {
    setSavingId(id);
    try {
      const updated = await window.api.concepts.notes.update({ id, ...patch });
      if (updated) {
        setNotes(prev => prev.map(n => (n.id === id ? (updated as Note) : n)));
      }
    } finally {
      setSavingId(null);
    }
  }

  function removeNote(id: number) {
    if (deleteTimers.current.has(id)) return;
    const note = notes.find(n => n.id === id);
    if (!note) return;
    setNotes(prev => prev.filter(n => n.id !== id));
    setPendingDeletes(prev => [...prev, note]);
    const timer = setTimeout(() => {
      deleteTimers.current.delete(id);
      setPendingDeletes(prev => prev.filter(n => n.id !== id));
      void window.api.concepts.notes.delete(id);
    }, 5000);
    deleteTimers.current.set(id, timer);
  }

  function undoRemoveNote(note: Note) {
    const timer = deleteTimers.current.get(note.id);
    if (timer) { clearTimeout(timer); deleteTimers.current.delete(note.id); }
    setPendingDeletes(prev => prev.filter(n => n.id !== note.id));
    setNotes(prev => [...prev, note].sort((a, b) => a.position - b.position));
  }

  useEffect(() => () => { for (const t of deleteTimers.current.values()) clearTimeout(t); }, []);

  async function move(id: number, dir: -1 | 1) {
    const idx = notes.findIndex(n => n.id === id);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= notes.length) return;
    const reordered = [...notes];
    [reordered[idx], reordered[target]] = [reordered[target], reordered[idx]];
    setNotes(reordered);
    const out = await window.api.concepts.notes.reorder({
      conceptId,
      orderedIds: reordered.map(n => n.id),
    });
    // reorder returns ALL notes (including the hidden __paper__ scratchpad) —
    // keep it out of the visible list.
    setNotes((out as Note[]).filter(n => n.heading !== PAPER_NOTE_HEADING));
  }

  return (
    <div>
      <div style={{
        fontSize: 10, fontWeight: 700, color: '#4b5563',
        textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12,
      }}>
        My Notes
      </div>

      {loading && (
        <div style={{ color: '#4b5563', fontSize: 12 }}>Loading notes…</div>
      )}

      {!loading && notes.length === 0 && (
        <div style={{ color: '#4b5563', fontSize: 12, marginBottom: 12 }}>
          Add your own follow-ups, connections, or reminders below — these are never
          touched by re-extract, enrich, or regenerate.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 12 }}>
        {notes.map((n, i) => (
          <NoteRow
            key={n.id}
            note={n}
            saving={savingId === n.id}
            canMoveUp={i > 0}
            canMoveDown={i < notes.length - 1}
            highlights={highlights}
            linkedHighlight={highlights.find(h => h.id === n.linked_annotation_id) ?? null}
            onSave={patch => saveNote(n.id, patch)}
            onLink={annotationId => saveNote(n.id, { linkedAnnotationId: annotationId })}
            onJump={onJumpToAnnotation}
            onDelete={() => removeNote(n.id)}
            onMoveUp={() => move(n.id, -1)}
            onMoveDown={() => move(n.id, 1)}
          />
        ))}
      </div>

      {pendingDeletes.map(n => (
        <div key={`pending-${n.id}`} style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8,
          background: 'rgba(13,13,22,0.6)', border: '1px solid #1f2937', borderRadius: 6,
          padding: '8px 10px', fontSize: 12, color: '#94a3b8',
        }}>
          <span>Note deleted{n.heading && n.heading !== 'Untitled note' ? ` — “${n.heading}”` : ''}.</span>
          <button
            onClick={() => undoRemoveNote(n)}
            style={{ marginLeft: 'auto', background: '#1e1b4b', border: '1px solid #6366f1', borderRadius: 4, color: '#c7d2fe', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '3px 9px' }}
          >Undo</button>
        </div>
      ))}

      <button
        onClick={addNote}
        style={{
          background: 'transparent',
          border: '1px dashed #374151',
          borderRadius: 6,
          padding: '8px 14px',
          color: '#a5b4fc',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
          alignSelf: 'flex-start',
        }}
      >
        + Add note
      </button>
    </div>
  );
}

function NoteRow({
  note, saving, canMoveUp, canMoveDown, highlights, linkedHighlight, onSave, onLink, onJump, onDelete, onMoveUp, onMoveDown,
}: {
  note: Note;
  saving: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  highlights: HighlightOption[];
  linkedHighlight: HighlightOption | null;
  onSave: (patch: { heading?: string; body?: string }) => void;
  onLink: (annotationId: number | null) => void;
  onJump: (page: number) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [heading, setHeading] = useState(note.heading);
  const [body, setBody] = useState(note.body);
  const [linkOpen, setLinkOpen] = useState(false);

  useEffect(() => { setHeading(note.heading); }, [note.heading]);
  useEffect(() => { setBody(note.body); }, [note.body]);

  const headingDirty = heading !== note.heading;
  const bodyDirty    = body !== note.body;
  // The note points at an annotation that no longer resolves (deleted highlight).
  const danglingLink = note.linked_annotation_id != null && !linkedHighlight;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <input
          value={heading}
          onChange={e => setHeading(e.target.value)}
          onBlur={() => { if (headingDirty) onSave({ heading }); }}
          placeholder="Heading"
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            color: '#4b5563',
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            outline: 'none',
            padding: 0,
          }}
        />
        <button
          onClick={onMoveUp}
          disabled={!canMoveUp}
          title="Move up"
          style={iconBtn(!canMoveUp)}
        >▲</button>
        <button
          onClick={onMoveDown}
          disabled={!canMoveDown}
          title="Move down"
          style={iconBtn(!canMoveDown)}
        >▼</button>
        <button
          onClick={onDelete}
          title="Delete note"
          style={{
            background: 'transparent', border: '1px solid #3f1515', borderRadius: 4,
            padding: '2px 8px', fontSize: 14, color: '#fca5a5', cursor: 'pointer', lineHeight: 1,
          }}
        >×</button>
      </div>
      <textarea
        value={body}
        onChange={e => setBody(e.target.value)}
        onBlur={() => { if (bodyDirty) onSave({ body }); }}
        placeholder="Write your note here…"
        rows={Math.max(2, Math.min(8, Math.ceil((body.length || 70) / 70)))}
        style={{
          width: '100%',
          background: body ? '#111827' : '#0d0d16',
          border: `1px solid ${bodyDirty ? '#818cf8' : '#1f2937'}`,
          borderRadius: 4,
          padding: '8px 10px',
          color: body ? '#c4cfe4' : '#6b7280',
          fontSize: body ? 14 : 12,
          lineHeight: 1.65,
          fontFamily: 'inherit',
          outline: 'none',
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, position: 'relative', flexWrap: 'wrap' }}>
        {linkedHighlight ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'rgba(30,27,75,0.55)', border: '1px solid #4338ca', borderRadius: 999,
            padding: '2px 4px 2px 8px', fontSize: 11, color: '#c7d2fe', maxWidth: '100%',
          }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: linkedHighlight.color, flexShrink: 0 }} />
            <button
              onClick={() => onJump(linkedHighlight.page)}
              title="Jump to this highlight in the source"
              style={{
                background: 'transparent', border: 'none', color: '#c7d2fe', cursor: 'pointer',
                fontSize: 11, padding: 0, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              p.{linkedHighlight.page} — {linkedHighlight.snippet}
            </button>
            <button
              onClick={() => onLink(null)}
              title="Unlink highlight"
              style={{ background: 'transparent', border: 'none', color: '#a5b4fc', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '0 2px' }}
            >×</button>
          </span>
        ) : danglingLink ? (
          <button
            onClick={() => onLink(null)}
            title="The linked highlight was deleted. Click to clear."
            style={{ background: 'transparent', border: '1px dashed #3f1515', borderRadius: 999, padding: '2px 9px', fontSize: 11, color: '#6b7280', cursor: 'pointer' }}
          >
            ⚠ linked highlight removed — clear
          </button>
        ) : (
          <button
            onClick={() => { if (highlights.length) setLinkOpen(v => !v); }}
            disabled={highlights.length === 0}
            title={highlights.length === 0 ? 'No highlights on this source yet. Highlight text in the source pane first.' : 'Link this note to a highlight'}
            style={{
              background: 'transparent', border: '1px dashed #374151', borderRadius: 999,
              padding: '2px 9px', fontSize: 11,
              color: highlights.length === 0 ? '#374151' : '#a5b4fc',
              cursor: highlights.length === 0 ? 'default' : 'pointer',
            }}
          >
            🔖 Link highlight
          </button>
        )}
        {linkOpen && highlights.length > 0 && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 30, marginTop: 4,
            minWidth: 240, maxWidth: 360, maxHeight: 220, overflowY: 'auto',
            background: 'rgba(13,13,22,0.92)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid #312e81', borderRadius: 6, boxShadow: '0 16px 50px rgba(0,0,0,0.55)', padding: 4,
          }}>
            {highlights.map(h => (
              <button
                key={h.id}
                className="rel-opt"
                onClick={() => { onLink(h.id); setLinkOpen(false); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  background: 'transparent', border: 'none', borderRadius: 4, cursor: 'pointer',
                  padding: '6px 8px', color: '#cbd5e1', fontSize: 12,
                }}
              >
                <span style={{ width: 9, height: 9, borderRadius: 2, background: h.color, flexShrink: 0 }} />
                <span style={{ flexShrink: 0, color: '#6b7280', fontSize: 11 }}>p.{h.page}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.snippet}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {saving && (
        <div style={{ fontSize: 10, color: '#6b7280', marginTop: 4 }}>Saving…</div>
      )}
    </div>
  );
}

function iconBtn(disabled: boolean): React.CSSProperties {
  return {
    background: 'transparent',
    border: '1px solid #1f2937',
    borderRadius: 4,
    padding: '2px 6px',
    fontSize: 10,
    color: disabled ? '#374151' : '#9ca3af',
    cursor: disabled ? 'default' : 'pointer',
  };
}
