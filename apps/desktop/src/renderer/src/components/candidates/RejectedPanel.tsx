import React, { useCallback, useEffect, useState } from 'react';
import type { CandidateRejection } from '@starcall/shared';

// Remembered rejections for one source (re-extract won't recreate them).
// Restoring brings the rejected row back immediately; "Restore all" clears
// every rejection for the source. Collapsed by default; hidden when empty.
const KIND_LABEL: Record<CandidateRejection['kind'], string> = {
  concept: 'Concept',
  relation: 'Relation',
  misconception: 'Misconception',
  prerequisite: 'Prerequisite',
};

export default function RejectedPanel({ sourceId, changeKey, onRestored }: {
  sourceId: number;
  // Any value that changes when candidates change, so the count stays current.
  changeKey: string;
  onRestored: () => void;
}) {
  const [items, setItems] = useState<CandidateRejection[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    window.api.candidates.rejectionsList(sourceId)
      .then(setItems)
      .catch(e => console.error('[starcall:ipc] candidates.rejectionsList', e));
  }, [sourceId]);

  useEffect(() => { load(); }, [load, changeKey]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try {
      await fn();
      load();
      onRestored();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (items.length === 0) return null;
  return (
    <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-panel)', fontSize: 11 }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Rejected candidates stay rejected across re-extract until restored"
        style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '5px 16px', fontSize: 11 }}
      >
        {open ? '▾' : '▸'} Rejected ({items.length})
      </button>
      {open && (
        <div style={{ padding: '0 16px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {items.map(r => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--text-faint)', width: 92, flexShrink: 0 }}>{KIND_LABEL[r.kind]}</span>
              <span style={{ color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>
                {r.label}
              </span>
              <button
                onClick={() => void run(() => window.api.candidates.rejectionUndo(r.id))}
                disabled={busy}
                title="Restore this candidate and forget the rejection"
                style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 6px', color: 'var(--indigo-400)', fontSize: 10, cursor: busy ? 'wait' : 'pointer' }}
              >
                ↺ Restore
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
            <button
              onClick={() => void run(() => window.api.candidates.rejectionsClear(sourceId))}
              disabled={busy}
              title="Restore every rejected candidate for this source"
              style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 6px', color: 'var(--text-muted)', fontSize: 10, cursor: busy ? 'wait' : 'pointer' }}
            >
              ↺ Restore all
            </button>
            {err && <span style={{ color: 'var(--text-danger)' }}>{err}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
