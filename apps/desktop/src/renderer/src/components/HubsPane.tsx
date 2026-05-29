import React, { useCallback, useEffect, useState } from 'react';
import type { StarHub } from '@starcall/shared';

interface MemberLite { id: number; name: string; source_filename?: string }

// Top-level hub manager: lists every star hub (even ones whose source was
// deleted) with inline rename/recolor/description, member removal, and delete.
export default function HubsPane({ onChanged }: { onChanged?: () => void }) {
  const [hubs, setHubs] = useState<StarHub[]>([]);
  const [membersByHub, setMembersByHub] = useState<Map<number, MemberLite[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ name: string; color: string; description: string }>({ name: '', color: '#818cf8', description: '' });
  const [creating, setCreating] = useState(false);
  const [newHub, setNewHub] = useState<{ name: string; color: string; description: string }>({ name: '', color: '#818cf8', description: '' });

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([window.api.hubs.list(), window.api.hubs.memberships(), window.api.concepts.graph()])
      .then(([hs, ms, g]) => {
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
    await window.api.hubs.update({ id, name, color: draft.color, description: draft.description.trim() });
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
  async function createHub() {
    const name = newHub.name.trim();
    if (!name) return;
    await window.api.hubs.create({ name, color: newHub.color, description: newHub.description.trim() });
    setNewHub({ name: '', color: '#818cf8', description: '' });
    setCreating(false);
    refresh();
    notify();
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 32, position: 'relative', zIndex: 1 }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: '#e2e8f0' }}>Star Hubs</h1>
          <span style={{ fontSize: 12, color: '#6b7280' }}>{hubs.length} hub{hubs.length === 1 ? '' : 's'}</span>
          <button
            onClick={() => setCreating(v => !v)}
            style={{ marginLeft: 'auto', background: '#312e81', border: '1px solid #6366f1', borderRadius: 6, padding: '6px 12px', color: '#e0e7ff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
          >+ New hub</button>
        </div>

        {creating && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, padding: 12, borderRadius: 8, background: 'rgba(13,13,22,0.4)', backdropFilter: 'blur(8px)', border: '1px solid #312e81' }}>
            <input type="color" value={newHub.color} onChange={e => setNewHub(h => ({ ...h, color: e.target.value }))} title="Hub color"
              style={{ width: 30, height: 30, padding: 0, border: '1px solid #263244', borderRadius: 4, background: 'transparent', cursor: 'pointer', flexShrink: 0 }} />
            <input autoFocus value={newHub.name} onChange={e => setNewHub(h => ({ ...h, name: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') void createHub(); else if (e.key === 'Escape') setCreating(false); }}
              placeholder="Hub name"
              style={{ flex: 1, minWidth: 0, background: 'rgba(17,24,39,0.5)', border: '1px solid #263244', borderRadius: 4, padding: '7px 9px', color: '#e2e8f0', fontSize: 13, outline: 'none' }} />
            <input value={newHub.description} onChange={e => setNewHub(h => ({ ...h, description: e.target.value }))}
              placeholder="Description (optional)"
              style={{ flex: 1, minWidth: 0, background: 'rgba(17,24,39,0.5)', border: '1px solid #1f2937', borderRadius: 4, padding: '7px 9px', color: '#cbd5e1', fontSize: 12, outline: 'none' }} />
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
          {hubs.map(h => {
            const members = membersByHub.get(h.id) ?? [];
            const isEditing = editingId === h.id;
            return (
              <div key={h.id} style={{ borderRadius: 10, background: 'rgba(13,13,22,0.4)', backdropFilter: 'blur(8px)', border: '1px solid rgba(49,46,129,0.6)', padding: 14 }}>
                {isEditing ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                    <input type="color" value={draft.color} onChange={e => setDraft(d => ({ ...d, color: e.target.value }))} title="Hub color"
                      style={{ width: 30, height: 30, padding: 0, border: '1px solid #263244', borderRadius: 4, background: 'transparent', cursor: 'pointer', flexShrink: 0 }} />
                    <input autoFocus value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') void saveEdit(h.id); else if (e.key === 'Escape') setEditingId(null); }}
                      style={{ flex: 1, minWidth: 0, background: 'rgba(17,24,39,0.5)', border: '1px solid #263244', borderRadius: 4, padding: '6px 8px', color: '#e2e8f0', fontSize: 14, fontWeight: 700, outline: 'none' }} />
                    <button onClick={() => void saveEdit(h.id)} style={{ background: '#312e81', border: '1px solid #6366f1', borderRadius: 4, padding: '6px 12px', color: '#e0e7ff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Save</button>
                    <button onClick={() => setEditingId(null)} title="Cancel" style={{ background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, padding: '6px 10px', color: '#94a3b8', fontSize: 14, lineHeight: 1, cursor: 'pointer' }}>×</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: members.length || h.description ? 10 : 0 }}>
                    <span style={{ width: 12, height: 12, borderRadius: '50%', background: h.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>{h.name}</span>
                    <span style={{ fontSize: 11, color: '#64748b' }}>{h.member_count} member{h.member_count === 1 ? '' : 's'}</span>
                    <button onClick={() => { setEditingId(h.id); setDraft({ name: h.name, color: h.color, description: h.description ?? '' }); }}
                      title="Edit hub"
                      style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, padding: '3px 9px', color: '#a5b4fc', fontSize: 11, cursor: 'pointer' }}>Edit</button>
                    <button onClick={() => void removeHub(h.id)} title={`Delete hub "${h.name}"`} aria-label={`Delete hub ${h.name}`}
                      style={{ background: 'transparent', border: '1px solid #7f1d1d', borderRadius: 4, padding: '3px 9px', color: '#fca5a5', fontSize: 13, lineHeight: 1, cursor: 'pointer' }}>×</button>
                  </div>
                )}
                {isEditing && (
                  <input value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
                    placeholder="Description (optional)"
                    style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(17,24,39,0.5)', border: '1px solid #1f2937', borderRadius: 4, padding: '6px 8px', color: '#cbd5e1', fontSize: 12, outline: 'none', marginBottom: 10 }} />
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
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
