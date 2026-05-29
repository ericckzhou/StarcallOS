import React from 'react';

// Shared, transparent ("glass") inline-edit surface for the candidate CRUD
// panels (relations / misconceptions / equations). One field-schema-driven
// editor replaces the three near-identical bespoke forms, and every fill is
// translucent so the configured background image/video shows through.

export const glassEditor: React.CSSProperties = {
  borderBottom: '1px solid rgba(31, 41, 55, 0.55)',
  padding: '12px 16px',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  background: 'rgba(8, 13, 30, 0.44)',
  backdropFilter: 'blur(12px)',
};

export const glassInput: React.CSSProperties = {
  flex: '1 1 160px',
  minWidth: 0,
  background: 'rgba(15, 23, 42, 0.42)',
  border: '1px solid rgba(148, 163, 184, 0.20)',
  borderRadius: 5,
  color: '#dbeafe',
  fontSize: 11,
  padding: '6px 8px',
  outline: 'none',
  fontFamily: 'inherit',
};

export const glassRow: React.CSSProperties = {
  borderBottom: '1px solid rgba(31, 41, 55, 0.46)',
  padding: '11px 16px',
  background: 'rgba(4, 6, 26, 0.08)',
};

export type FieldSpec = {
  key: string;
  placeholder: string;
  kind?: 'text' | 'number' | 'select';
  options?: readonly string[];
  optionLabel?: (o: string) => string;
  /** layout: 'full' = own row, 'fixed' = narrow fixed width, default = flex */
  span?: 'full' | 'fixed';
  width?: number;
};

function glassButton(variant: 'primary' | 'secondary', busy: boolean): React.CSSProperties {
  const palette = variant === 'primary'
    ? { background: 'rgba(79, 70, 229, 0.34)', border: '1px solid rgba(99, 102, 241, 0.55)', color: '#c7d2fe' }
    : { background: 'rgba(15, 23, 42, 0.24)', border: '1px solid rgba(148, 163, 184, 0.30)', color: '#94a3b8' };
  return {
    ...palette,
    borderRadius: 4,
    padding: '5px 12px',
    fontSize: 11,
    fontWeight: 600,
    cursor: busy ? 'wait' : 'pointer',
    opacity: busy ? 0.6 : 1,
  };
}

// Schema-driven editor. `draft` is a flat string record; each FieldSpec.key
// indexes into it. `preview` renders an optional live preview block (used by
// equations for the LaTeX render) above the action buttons.
export function InlineEditor({
  fields, draft, setDraft, busy, onSave, onCancel, preview,
}: {
  fields: readonly FieldSpec[];
  draft: Record<string, string>;
  setDraft: (next: Record<string, string>) => void;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
  preview?: React.ReactNode;
}) {
  const set = (key: string, value: string) => setDraft({ ...draft, [key]: value });
  return (
    <div style={glassEditor}>
      {fields.map(f => {
        const style: React.CSSProperties = {
          ...glassInput,
          ...(f.span === 'full' ? { flexBasis: '100%' } : {}),
          ...(f.span === 'fixed' ? { flex: `0 0 ${f.width ?? 80}px`, width: f.width ?? 80 } : {}),
        };
        if (f.kind === 'select' && f.options) {
          return (
            <select key={f.key} value={draft[f.key] ?? ''} onChange={e => set(f.key, e.target.value)} style={{ ...style, colorScheme: 'dark' }}>
              {f.options.map(o => (
                <option key={o} value={o} style={{ background: '#0d0d16', color: '#e2e8f0' }}>
                  {f.optionLabel ? f.optionLabel(o) : o}
                </option>
              ))}
            </select>
          );
        }
        return (
          <input
            key={f.key}
            value={draft[f.key] ?? ''}
            onChange={e => set(f.key, e.target.value)}
            placeholder={f.placeholder}
            inputMode={f.kind === 'number' ? 'numeric' : undefined}
            style={style}
          />
        );
      })}
      {preview && <div style={{ flexBasis: '100%' }}>{preview}</div>}
      <button onClick={onSave} disabled={busy} style={glassButton('primary', busy)}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button
        onClick={onCancel}
        disabled={busy}
        title="Cancel"
        aria-label="Cancel"
        style={{ ...glassButton('secondary', busy), width: 30, padding: 0, fontSize: 15, lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
      >
        ×
      </button>
    </div>
  );
}

// Centered glass modal used to host the add-form for candidate panels, so
// adding a relation/misconception/equation pops out instead of expanding inline.
export function EditorModal({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(2, 4, 14, 0.55)', backdropFilter: 'blur(3px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 620, maxWidth: '92vw',
          padding: 16, borderRadius: 12,
          background: 'rgba(13, 13, 22, 0.6)', backdropFilter: 'blur(14px)', border: '1px solid #312e81',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: '#c7d2fe', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{title}</div>
          <button
            onClick={onClose}
            title="Cancel"
            aria-label="Cancel"
            style={{ marginLeft: 'auto', width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: '1px solid #1f2937', borderRadius: 4, color: '#94a3b8', fontSize: 14, lineHeight: 1, cursor: 'pointer' }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
