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
}

interface Props {
  conceptId: number;
}

// User-authored free-form notes rendered below the LLM-managed Overview
// fields. CRUD against window.api.concepts.notes; survives every other
// operation (re-extract, enrich, regenerate) via FK cascade + the
// cleanup module never touching this table.
export default function UserNotesSection({ conceptId }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<number | null>(null);
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

  async function addNote() {
    const created = await window.api.concepts.notes.create({
      conceptId,
      heading: 'Untitled note',
      body: '',
    });
    setNotes(prev => [...prev, created as Note]);
  }

  async function saveNote(id: number, patch: { heading?: string; body?: string }) {
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
    setNotes(out as Note[]);
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
            onSave={patch => saveNote(n.id, patch)}
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
  note, saving, canMoveUp, canMoveDown, onSave, onDelete, onMoveUp, onMoveDown,
}: {
  note: Note;
  saving: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSave: (patch: { heading?: string; body?: string }) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [heading, setHeading] = useState(note.heading);
  const [body, setBody] = useState(note.body);

  useEffect(() => { setHeading(note.heading); }, [note.heading]);
  useEffect(() => { setBody(note.body); }, [note.body]);

  const headingDirty = heading !== note.heading;
  const bodyDirty    = body !== note.body;

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
