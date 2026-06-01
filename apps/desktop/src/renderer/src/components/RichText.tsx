import React, { useEffect, useRef, useState } from 'react';

// ─── Minimal inline Markdown → React nodes ───────────────────────────────────
// Supports **bold** / __bold__ and *italic* / _italic_, with newlines preserved.
// Intentionally tiny: no headings/lists/links — just the two emphasis marks the
// authoring fields need. Renders to React nodes (not dangerouslySetInnerHTML),
// so user text can never inject markup.

function renderItalic(text: string, kp: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*([^*]+?)\*|_([^_]+?)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<em key={`${kp}-em${i++}`}>{m[1] ?? m[2]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderInline(text: string, kp: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*([^]+?)\*\*|__([^]+?)__/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(...renderItalic(text.slice(last, m.index), `${kp}-b${i}p`));
    out.push(<strong key={`${kp}-b${i}`}>{renderItalic(m[1] ?? m[2], `${kp}-b${i}i`)}</strong>);
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(...renderItalic(text.slice(last), `${kp}-t`));
  return out;
}

export function renderMarkdown(text: string, kp = 'md'): React.ReactNode {
  return text.split('\n').map((ln, idx) => (
    <React.Fragment key={`${kp}-l${idx}`}>
      {idx > 0 && <br />}
      {renderInline(ln, `${kp}-l${idx}`)}
    </React.Fragment>
  ));
}

// Cmd/Ctrl+B and Cmd/Ctrl+I wrap the current selection in the matching marker.
// Returns true if it handled the event. Usable on any plain <textarea>.
export function applyMarkdownShortcut(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  value: string,
  onChange: (v: string) => void,
): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  const k = e.key.toLowerCase();
  if (k !== 'b' && k !== 'i') return false;
  e.preventDefault();
  const el = e.currentTarget;
  const marker = k === 'b' ? '**' : '*';
  const start = el.selectionStart;
  const end = el.selectionEnd;
  onChange(value.slice(0, start) + marker + value.slice(start, end) + marker + value.slice(end));
  // Restore the selection around the original text, now shifted by the marker.
  requestAnimationFrame(() => {
    el.selectionStart = start + marker.length;
    el.selectionEnd = end + marker.length;
  });
  return true;
}

// ─── RichTextArea ────────────────────────────────────────────────────────────
// A textarea that renders formatted Markdown when not focused ("render on
// blur") and drops back to a raw <textarea> when clicked, so the markers stay
// editable. Cmd/Ctrl+B and Cmd/Ctrl+I wrap the current selection.
//
// `textStyle` is applied to BOTH the textarea and the preview box so the field
// looks identical in either mode. Call sites pass their existing textarea style.

export function RichTextArea({
  value,
  onChange,
  onBlur,
  placeholder = '',
  rows,
  readOnly = false,
  spellCheck,
  textStyle,
  placeholderColor = '#6b7280',
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  rows?: number;
  readOnly?: boolean;
  spellCheck?: boolean;
  textStyle: React.CSSProperties;
  placeholderColor?: string;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // On entering edit mode, focus and drop the caret at the end.
  useEffect(() => {
    if (editing && ref.current) {
      const el = ref.current;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }
  }, [editing]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    applyMarkdownShortcut(e, value, onChange);
  }

  if (editing && !readOnly) {
    return (
      <textarea
        ref={ref}
        value={value}
        placeholder={placeholder}
        spellCheck={spellCheck}
        rows={rows}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { setEditing(false); onBlur?.(); }}
        style={textStyle}
      />
    );
  }

  const previewStyle: React.CSSProperties = {
    ...textStyle,
    cursor: readOnly ? 'default' : 'text',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    minHeight: textStyle.minHeight ?? 40,
    // A textarea's `resize` doesn't apply to a div; strip it to avoid a stray handle.
    resize: undefined,
  };
  return (
    <div onClick={() => { if (!readOnly) setEditing(true); }} style={previewStyle}>
      {value
        ? renderMarkdown(value)
        : <span style={{ color: placeholderColor }}>{placeholder}</span>}
    </div>
  );
}
