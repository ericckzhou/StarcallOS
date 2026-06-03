import React, { useCallback, useEffect, useState } from 'react';
import type { StarHub, StarHubEdge } from '@starcall/shared';

interface MemberLite { id: number; name: string; source_filename?: string }

// New hubs default to a random palette color rather than always the same purple.
const HUB_PALETTE = ['#818cf8', '#f472b6', '#34d399', '#fbbf24', '#22d3ee', '#fb7185', '#a78bfa', '#4ade80', '#60a5fa', '#fb923c'];
const randomHubColor = () => HUB_PALETTE[Math.floor(Math.random() * HUB_PALETTE.length)];

// Top-level hub manager: lists every star hub (even ones whose source was
// deleted) with inline rename/recolor/description, member removal, and delete.
export default function HubsPane({ onChanged }: { onChanged?: () => void }) {
  const [hubs, setHubs] = useState<StarHub[]>([]);
  const [membersByHub, setMembersByHub] = useState<Map<number, MemberLite[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ name: string; color: string; description: string; parentHubId: number | null }>({ name: '', color: '#818cf8', description: '', parentHubId: null });
  const [creating, setCreating] = useState(false);
  const [newHub, setNewHub] = useState<{ name: string; color: string; description: string }>(() => ({ name: '', color: randomHubColor(), description: '' }));
  const [edges, setEdges] = useState<StarHubEdge[]>([]);
  const [connectingId, setConnectingId] = useState<number | null>(null);
  const [edgeDraft, setEdgeDraft] = useState<{ target: number | null; label: string; directed: boolean }>({ target: null, label: '', directed: true });

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([window.api.hubs.list(), window.api.hubs.memberships(), window.api.concepts.graph(), window.api.hubs.edges.list()])
      .then(([hs, ms, g, es]) => {
        const nameById = new Map<number, MemberLite>();
        for (const n of (g as { nodes: MemberLite[] }).nodes) nameById.set(n.id, n);
        const m = new Map<number, MemberLite[]>();
        for (const { hub_id, concept_id } of ms as Array<{ hub_id: number; concept_id: number }>) {
          const arr = m.get(hub_id) ?? [];
          const lite = nameById.get(concept_id) ?? { id: concept_id, name: `#${concept_id}` };
          arr.push(lite);
          m.set(hub_id, arr);
        }
        setHubs(hs as StarHub[]);
        setMembersByHub(m);
        setEdges(es as StarHubEdge[]);
        setLoading(false);
      });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  function notify() {
    window.dispatchEvent(new Event('starcall:graphChanged'));
    onChanged?.();
  }

  async function saveEdit(id: number) {
    const name = draft.name.trim();
    if (!name) return;
    try {
      await window.api.hubs.update({ id, name, color: draft.color, description: draft.description.trim(), parentHubId: draft.parentHubId });
    } catch (e) {
      // The repo rejects a parent that would form a cycle; the option list
      // already excludes those, so this is just a backstop.
      console.error('[starcall:ipc] hubs.update', e);
      return;
    }
    setEditingId(null);
    refresh();
    notify();
  }
  async function removeHub(id: number) {
    await window.api.hubs.delete(id);
    refresh();
    notify();
  }
  async function removeMember(hubId: number, conceptId: number) {
    await window.api.hubs.removeMember({ hubId, conceptId });
    refresh();
    notify();
  }
  async function addEdge(aHubId: number) {
    if (edgeDraft.target == null) return;
    await window.api.hubs.edges.create({ aHubId, bHubId: edgeDraft.target, label: edgeDraft.label.trim(), directed: edgeDraft.directed });
    setConnectingId(null);
    setEdgeDraft({ target: null, label: '', directed: true });
    refresh();
    notify();
  }
  async function removeEdge(id: number) {
    await window.api.hubs.edges.delete(id);
    refresh();
    notify();
  }
  async function createHub() {
    const name = newHub.name.trim();
    if (!name) return;
    await window.api.hubs.create({ name, color: newHub.color, description: newHub.description.trim() });
    setNewHub({ name: '', color: randomHubColor(), description: '' });
    setCreating(false);
    refresh();
    notify();
  }

  // ─── Nesting tree ──────────────────────────────────────────────────────────
  // Hubs form a tree via parent_hub_id. A hub whose parent was deleted leaves a
  // dangling id (ON DELETE SET NULL prevents that in the DB, but we stay
  // defensive) — treat it as a root.
  const hubById = new Map(hubs.map(h => [h.id, h]));
  const childrenOf = (parentId: number | null): StarHub[] =>
    hubs
      .filter(h => (parentId === null ? h.parent_hub_id == null || !hubById.has(h.parent_hub_id) : h.parent_hub_id === parentId))
      .sort((a, b) => a.name.localeCompare(b.name));

  // A hub plus its descendants — the set excluded from its own parent picker so
  // the dropdown can never form a cycle.
  const descendantIds = (id: number): Set<number> => {
    const out = new Set<number>();
    const walk = (pid: number) => {
      for (const c of hubs) {
        if (c.parent_hub_id === pid && !out.has(c.id)) { out.add(c.id); walk(c.id); }
      }
    };
    walk(id);
    return out;
  };

  function renderHubCard(h: StarHub, depth: number): React.ReactNode {
    const members = membersByHub.get(h.id) ?? [];
    const isEditing = editingId === h.id;
    const blocked = new Set<number>([h.id, ...descendantIds(h.id)]);
    const parentOptions = hubs.filter(o => !blocked.has(o.id)).sort((a, b) => a.name.localeCompare(b.name));
    const childCount = childrenOf(h.id).length;
    const selectStyle: React.CSSProperties = {
      flex: 1, minWidth: 0, background: 'transparent', border: '1px solid #1f2937', borderRadius: 4,
      padding: '6px 8px', color: '#cbd5e1', fontSize: 12, outline: 'none', fontFamily: 'inherit',
      // accent-color recolors the native option highlight (blue → indigo) in
      // Chromium/Electron.
      accentColor: '#818cf8',
    };
    const hubName = (id: number) => hubs.find(o => o.id === id)?.name ?? `#${id}`;
    const myEdges = edges.filter(e => e.a_hub_id === h.id || e.b_hub_id === h.id);
    const connectOptions = hubs.filter(o => o.id !== h.id).sort((a, b) => a.name.localeCompare(b.name));
    const isConnecting = connectingId === h.id;
    return (
      <div key={h.id} style={{ marginLeft: depth * 22, position: 'relative' }}>
        {depth > 0 && (
          <span aria-hidden="true" style={{ position: 'absolute', left: -14, top: 16, color: '#4338ca', fontSize: 13 }}>↳</span>
        )}
        <div style={{ borderRadius: 10, background: 'rgba(13,13,22,0.22)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', border: '1px solid rgba(49,46,129,0.6)', borderLeft: depth > 0 ? `3px solid ${h.color}` : '1px solid rgba(49,46,129,0.6)', padding: 14 }}>
          {isEditing ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <input type="color" value={draft.color} onChange={e => setDraft(d => ({ ...d, color: e.target.value }))} title="Hub color"
                style={{ width: 30, height: 30, padding: 0, border: '1px solid #263244', borderRadius: 4, background: 'transparent', cursor: 'pointer', flexShrink: 0 }} />
              <input autoFocus value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') void saveEdit(h.id); else if (e.key === 'Escape') setEditingId(null); }}
                style={{ flex: 1, minWidth: 0, background: 'rgba(17,24,39,0.28)', border: '1px solid #263244', borderRadius: 4, padding: '6px 8px', color: '#e2e8f0', fontSize: 14, fontWeight: 700, outline: 'none' }} />
              <button onClick={() => void saveEdit(h.id)} style={{ background: '#312e81', border: '1px solid #6366f1', borderRadius: 4, padding: '6px 12px', color: '#e0e7ff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Save</button>
              <button onClick={() => setEditingId(null)} title="Cancel" style={{ background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, padding: '6px 10px', color: '#94a3b8', fontSize: 14, lineHeight: 1, cursor: 'pointer' }}>×</button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: members.length || h.description ? 10 : 0 }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: h.color, flexShrink: 0 }} />
              <span style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>{h.name}</span>
              <span style={{ fontSize: 11, color: '#64748b' }}>{h.member_count} member{h.member_count === 1 ? '' : 's'}</span>
              {childCount > 0 && (
                <span style={{ fontSize: 11, color: '#818cf8' }}>· {childCount} sub-hub{childCount === 1 ? '' : 's'}</span>
              )}
              <button onClick={() => { setEditingId(h.id); setDraft({ name: h.name, color: h.color, description: h.description ?? '', parentHubId: h.parent_hub_id }); }}
                title="Edit hub"
                style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, padding: '3px 9px', color: '#a5b4fc', fontSize: 11, cursor: 'pointer' }}>Edit</button>
              <button onClick={() => void removeHub(h.id)} title={`Delete hub "${h.name}"`} aria-label={`Delete hub ${h.name}`}
                style={{ background: 'transparent', border: '1px solid #7f1d1d', borderRadius: 4, padding: '3px 9px', color: '#fca5a5', fontSize: 13, lineHeight: 1, cursor: 'pointer' }}>×</button>
            </div>
          )}
          {isEditing && (
            <>
              <input value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
                placeholder="Description (optional)"
                style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(17,24,39,0.28)', border: '1px solid #1f2937', borderRadius: 4, padding: '6px 8px', color: '#cbd5e1', fontSize: 12, outline: 'none', marginBottom: 10 }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 11, color: '#64748b', flexShrink: 0 }}>Parent hub</span>
                <select value={draft.parentHubId ?? ''} title="Nest this hub under another hub"
                  onChange={e => setDraft(d => ({ ...d, parentHubId: e.target.value ? Number(e.target.value) : null }))}
                  style={selectStyle}>
                  <option value="">— None (top level) —</option>
                  {parentOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
            </>
          )}
          {!isEditing && h.description && (
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: members.length ? 10 : 0, lineHeight: 1.5 }}>{h.description}</div>
          )}
          {members.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {members.map(m => (
                <span key={m.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '2px 4px 2px 8px', borderRadius: 999, background: 'rgba(30,27,75,0.5)', border: '1px solid #4338ca', color: '#c7d2fe' }}>
                  {m.name}
                  <button onClick={() => void removeMember(h.id, m.id)} title={`Remove ${m.name} from ${h.name}`}
                    style={{ background: 'transparent', border: 'none', color: '#a5b4fc', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '0 2px' }}>×</button>
                </span>
              ))}
            </div>
          )}
          {/* Connections — user-curated edges to other hubs, shown on the Map. */}
          <div style={{ marginTop: members.length || h.description || isEditing ? 10 : 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Links</span>
            {myEdges.map(e => {
              const outgoing = e.a_hub_id === h.id;
              const other = outgoing ? e.b_hub_id : e.a_hub_id;
              const arrow = e.directed ? (outgoing ? '→' : '←') : '↔';
              const dirSym = e.directed ? '→' : '↔';
              return (
                <span key={e.id} title={`${hubName(e.a_hub_id)} ${dirSym} ${hubName(e.b_hub_id)}${e.label ? `: ${e.label}` : ''}`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '2px 4px 2px 8px', borderRadius: 999, background: 'rgba(76,29,149,0.32)', border: '1px solid #6d28d9', color: '#ddd6fe' }}>
                  <span style={{ opacity: 0.85 }}>{arrow}</span>{hubName(other)}{e.label ? <span style={{ color: '#a78bfa' }}>· {e.label}</span> : null}
                  <button onClick={() => void removeEdge(e.id)} title="Remove connection" aria-label="Remove connection"
                    style={{ background: 'transparent', border: 'none', color: '#c4b5fd', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '0 2px' }}>×</button>
                </span>
              );
            })}
            {!isConnecting && connectOptions.length > 0 && (
              <button onClick={() => { setConnectingId(h.id); setEdgeDraft({ target: null, label: '', directed: true }); }}
                style={{ background: 'transparent', border: '1px dashed #4338ca', borderRadius: 999, padding: '2px 9px', color: '#a5b4fc', fontSize: 11, cursor: 'pointer' }}>+ connect</button>
            )}
          </div>
          {isConnecting && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
              <select value={edgeDraft.target ?? ''} onChange={e => setEdgeDraft(d => ({ ...d, target: e.target.value ? Number(e.target.value) : null }))}
                style={{ ...selectStyle, flex: '0 1 180px' }}>
                <option value="">Link to hub…</option>
                {connectOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <input value={edgeDraft.label} onChange={e => setEdgeDraft(d => ({ ...d, label: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') void addEdge(h.id); else if (e.key === 'Escape') setConnectingId(null); }}
                placeholder="Label (optional)"
                style={{ flex: '1 1 120px', minWidth: 0, background: 'rgba(17,24,39,0.28)', border: '1px solid #1f2937', borderRadius: 4, padding: '6px 8px', color: '#cbd5e1', fontSize: 12, outline: 'none' }} />
              <button onClick={() => setEdgeDraft(d => ({ ...d, directed: !d.directed }))} title="Toggle one-way / mutual"
                style={{ background: 'transparent', border: '1px solid #4338ca', borderRadius: 4, padding: '6px 10px', color: '#c4b5fd', fontSize: 12, cursor: 'pointer', flexShrink: 0 }}>
                {edgeDraft.directed ? '→ one-way' : '↔ mutual'}
              </button>
              <button onClick={() => void addEdge(h.id)} disabled={edgeDraft.target == null}
                style={{ background: edgeDraft.target != null ? '#312e81' : '#1e1e2e', border: `1px solid ${edgeDraft.target != null ? '#6366f1' : '#1f2937'}`, borderRadius: 4, padding: '6px 12px', color: edgeDraft.target != null ? '#e0e7ff' : '#475569', fontSize: 12, fontWeight: 700, cursor: edgeDraft.target != null ? 'pointer' : 'not-allowed', flexShrink: 0 }}>Add</button>
              <button onClick={() => setConnectingId(null)} title="Cancel" aria-label="Cancel"
                style={{ background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, padding: '6px 9px', color: '#94a3b8', fontSize: 14, lineHeight: 1, cursor: 'pointer', flexShrink: 0 }}>×</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Depth-first: each hub, immediately followed by its subtree. Flattened into
  // one column; depth drives the left indentation in renderHubCard.
  const renderTree = (parentId: number | null, depth: number): React.ReactNode[] =>
    childrenOf(parentId).flatMap(h => [renderHubCard(h, depth), ...renderTree(h.id, depth + 1)]);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 32, position: 'relative', zIndex: 1 }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: '#e2e8f0' }}>Star Hubs</h1>
          <span style={{ fontSize: 12, color: '#6b7280' }}>{hubs.length} hub{hubs.length === 1 ? '' : 's'}</span>
          <button
            onClick={() => setCreating(v => { const open = !v; if (open) setNewHub(h => ({ ...h, color: randomHubColor() })); return open; })}
            style={{ marginLeft: 'auto', background: '#312e81', border: '1px solid #6366f1', borderRadius: 6, padding: '6px 12px', color: '#e0e7ff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
          >+ New hub</button>
        </div>

        {creating && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, padding: 12, borderRadius: 8, background: 'rgba(13,13,22,0.22)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', border: '1px solid #312e81' }}>
            <input type="color" value={newHub.color} onChange={e => setNewHub(h => ({ ...h, color: e.target.value }))} title="Hub color"
              style={{ width: 30, height: 30, padding: 0, border: '1px solid #263244', borderRadius: 4, background: 'transparent', cursor: 'pointer', flexShrink: 0 }} />
            <input autoFocus value={newHub.name} onChange={e => setNewHub(h => ({ ...h, name: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') void createHub(); else if (e.key === 'Escape') setCreating(false); }}
              placeholder="Hub name"
              style={{ flex: 1, minWidth: 0, background: 'rgba(17,24,39,0.28)', border: '1px solid #263244', borderRadius: 4, padding: '7px 9px', color: '#e2e8f0', fontSize: 13, outline: 'none' }} />
            <input value={newHub.description} onChange={e => setNewHub(h => ({ ...h, description: e.target.value }))}
              placeholder="Description (optional)"
              style={{ flex: 1, minWidth: 0, background: 'rgba(17,24,39,0.28)', border: '1px solid #1f2937', borderRadius: 4, padding: '7px 9px', color: '#cbd5e1', fontSize: 12, outline: 'none' }} />
            <button onClick={() => void createHub()} disabled={!newHub.name.trim()}
              style={{ background: newHub.name.trim() ? '#312e81' : '#1e1e2e', border: `1px solid ${newHub.name.trim() ? '#6366f1' : '#1f2937'}`, borderRadius: 4, padding: '7px 12px', color: newHub.name.trim() ? '#e0e7ff' : '#475569', fontSize: 12, fontWeight: 700, cursor: newHub.name.trim() ? 'pointer' : 'not-allowed' }}>Create</button>
          </div>
        )}

        {loading && <div style={{ color: '#4b5563', fontSize: 13, padding: 20 }}>Loading hubs…</div>}
        {!loading && hubs.length === 0 && (
          <div style={{ color: '#4b5563', fontSize: 13, padding: 20, textAlign: 'center', lineHeight: 1.6 }}>
            No hubs yet. Create one above, or group concepts via Select mode in the concept list.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {renderTree(null, 0)}
        </div>
      </div>
    </div>
  );
}
