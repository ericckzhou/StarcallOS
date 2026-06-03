import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Concept } from './ConceptPane';
import LatexMath from './LatexMath';
import { RichTextArea, renderMarkdown, applyMarkdownShortcut } from './RichText';
import PdfViewer from './PdfViewer';
import WhereItReappearsEditor, { type ConstellationLink } from './WhereItReappearsEditor';
import type { Profile } from './profile';

type Task = { id: number; kind: string; prompt: string; difficulty: number };
type Mastery = { compression_stage: number };
type Misconception = { id: number; description: string; why_think_it: string; why_wrong: string };
type Equation = { id: number; latex: string; variables: string[]; page: number };
type EvidenceScore = 'understood' | 'recognizes' | 'gap' | 'misconception';
type Grade = {
  score: EvidenceScore;
  compression_stage: number;
  gaps_detected: string[];
  misconceptions_detected: string[];
  grader_reasoning: string;
  xp_awarded?: number;
};
type HistoryRecord = {
  id: number;
  score: EvidenceScore;
  compression_stage: number;
  gaps_detected: string[];
  misconceptions_detected: string[];
  grader_reasoning: string;
  created_at: string;
  user_response?: string | null;
  task_prompt_snapshot?: string | null;
  task_kind_snapshot?: string | null;
  task_difficulty_snapshot?: number | null;
  xp_awarded?: number;
};
type StudyProgress = {
  total_xp: number;
  level: number;
  current_level_xp: number;
  next_level_xp: number;
  progress_ratio: number;
  challenges_completed?: number;
  difficulty_counts?: Record<1 | 2 | 3 | 4 | 5, number>;
};

const SCORE_COLOR: Record<EvidenceScore, string> = {
  understood:    '#22c55e',
  recognizes:    '#f59e0b',
  gap:           '#ef4444',
  misconception: '#b91c1c',
};
const SCORE_LABEL: Record<EvidenceScore, string> = {
  understood:    'understood',
  recognizes:    'recognizes',
  gap:           'gap',
  misconception: 'misconception',
};

const STAGES = ['Unseen', 'Memorized', 'Can Explain', 'Connected', 'Compressed', 'Predicts Failures'];
const STAGE_COLORS = ['#374151', '#6b7280', '#3b82f6', '#8b5cf6', '#f59e0b', '#22c55e'];
const IMP_COLOR: Record<string, string> = {
  foundational: '#f59e0b', core: '#818cf8', supporting: '#22d3ee',
  peripheral: '#6b7280', reference_only: '#374151',
};
const EVIDENCE_KIND_COLOR: Record<string, string> = {
  heading:    '#f59e0b',
  definition: '#22c55e',
  equation:   '#fbbf24',
  relation:   '#a855f7',
  chunk:      '#818cf8',
  first_page: '#6b7280',
  highlight:  '#facc15',
};
const SOURCE_PREVIEW_KEY = 'starcall.layout.sourcePreviewOpen';
const SOURCE_PREVIEW_NOTES_WIDTH_KEY = 'starcall.layout.sourcePreviewNotesWidth';

const RESCHEDULE_PRESETS_DP: { label: string; days: number }[] = [
  { label: '1d', days: 1 }, { label: '3d', days: 3 }, { label: '1w', days: 7 },
  { label: '2w', days: 14 }, { label: '1mo', days: 30 },
];

// Mirrors ReviewQueue's dueLabel so the header chip reads identically. undefined
// = still loading; null = new (never scheduled / reset to due-now).
function headerDueLabel(dueAt: string | null | undefined): { text: string; color: string; scheduled: boolean } {
  if (dueAt === undefined) return { text: '…', color: '#64748b', scheduled: false };
  if (dueAt == null) return { text: 'new', color: '#f59e0b', scheduled: false };
  const diffMs = new Date(dueAt).getTime() - Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.round(diffMs / dayMs);
  if (diffMs <= 0) {
    const overdue = Math.abs(days);
    return { text: overdue <= 0 ? 'due now' : `overdue ${overdue}d`, color: '#f87171', scheduled: true };
  }
  if (days <= 0) return { text: 'due now', color: '#f59e0b', scheduled: true };
  return { text: `due ${days}d`, color: '#64748b', scheduled: true };
}

// Self-contained reschedule/snooze control for the DetailPane header. The chip
// shows the live due state (fetched on mount + on review changes) and is itself
// the snooze trigger; review:setDue writes a pure date override (SM-2 ease/reps
// untouched; "Reset" clears to due-now).
function RescheduleButton({ conceptId }: { conceptId: number }) {
  const [open, setOpen] = useState(false);
  const [dueAt, setDueAt] = useState<string | null | undefined>(undefined); // undefined = loading

  // Fetch the due state on mount and on any review/SRS change so the header chip
  // always reflects the schedule, not just while the popover is open.
  useEffect(() => {
    let alive = true;
    const refresh = () => { void window.api.review.getSrs(conceptId).then(s => { if (alive) setDueAt(s ? s.due_at : null); }); };
    refresh();
    window.addEventListener('starcall:review-queue-stale', refresh);
    return () => { alive = false; window.removeEventListener('starcall:review-queue-stale', refresh); };
  }, [conceptId]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', onKey); };
  }, [open]);

  function apply(due: string | null) {
    setOpen(false);
    setDueAt(due); // optimistic — chip updates immediately
    void window.api.review.setDue({ conceptId, dueAt: due })
      .then(() => window.dispatchEvent(new Event('starcall:review-queue-stale')));
  }

  const dueState = headerDueLabel(dueAt);

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        title="Reschedule review"
        aria-label={`Reschedule review — ${dueState.text}`}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          height: 24, padding: '0 9px',
          background: `${dueState.color}${open ? '2e' : '14'}`,
          border: `1px solid ${dueState.color}${open ? 'aa' : '55'}`,
          borderRadius: 999,
          color: dueState.color, fontSize: 11, fontWeight: 600, lineHeight: 1,
          whiteSpace: 'nowrap', cursor: 'pointer',
        }}
      >
        {dueState.scheduled && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
          </svg>
        )}
        {dueState.text}
      </button>
      {open && (
        <div role="menu" onClick={e => e.stopPropagation()} style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 30, minWidth: 216,
          background: 'rgba(4,6,26,0.34)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
          border: '1px solid #263244', borderRadius: 8, boxShadow: '0 14px 34px rgba(0,0,0,0.6)', padding: 10,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '0 2px 7px' }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.12em' }}>Reschedule</span>
            <span style={{ fontSize: 10, color: '#94a3b8' }}>{dueState.text}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
            {RESCHEDULE_PRESETS_DP.map(p => (
              <button key={p.label} className="rel-opt" role="menuitem"
                onClick={e => { e.stopPropagation(); apply(new Date(Date.now() + p.days * 86_400_000).toISOString()); }}
                title={`Due again in ${p.label}`}
                style={{ background: 'transparent', border: '1px solid rgba(129,140,248,0.28)', borderRadius: 6, padding: '6px 0', fontSize: 11, color: '#c7d2fe', cursor: 'pointer', textAlign: 'center' }}>
                {p.label}
              </button>
            ))}
          </div>
          <label onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11, color: '#94a3b8' }}>
            <span style={{ whiteSpace: 'nowrap' }}>Pick date</span>
            <input
              type="date"
              onClick={e => e.stopPropagation()}
              min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}
              onChange={e => { e.stopPropagation(); const v = e.target.value; if (v) { const d = new Date(`${v}T00:00:00`); if (!Number.isNaN(d.getTime())) apply(d.toISOString()); } }}
              style={{ flex: 1, minWidth: 0, background: 'rgba(129,140,248,0.08)', border: '1px solid #263244', borderRadius: 6, padding: '4px 6px', fontSize: 11, color: '#e2e8f0', colorScheme: 'dark', cursor: 'pointer' }}
            />
          </label>
          <div style={{ height: 1, background: 'rgba(129,140,248,0.16)', margin: '9px 0' }} />
          <button role="menuitem"
            onClick={e => { e.stopPropagation(); apply(null); }}
            title="Clear schedule — make this due now"
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 6, padding: '5px 8px', fontSize: 11, color: '#f59e0b', cursor: 'pointer' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
            Reset (due now)
          </button>
        </div>
      )}
    </div>
  );
}

// Self-contained export control for the DetailPane header. Opens a small menu
// to export the concept as Markdown (.md) or an Anki import file (.txt,
// tab-separated) via export:concept; the main process owns the Save dialog and
// file write. Briefly flips to a check on success.
function ExportButton({ conceptId }: { conceptId: number }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', onKey); };
  }, [open]);

  function doExport(format: 'markdown' | 'anki') {
    setOpen(false);
    setStatus('saving');
    void window.api.export.concept({ conceptId, format })
      .then(res => {
        if (res.ok) { setStatus('saved'); setTimeout(() => setStatus('idle'), 1600); }
        else if (res.canceled) { setStatus('idle'); }
        else { setStatus('error'); setTimeout(() => setStatus('idle'), 2400); }
      })
      .catch(() => { setStatus('error'); setTimeout(() => setStatus('idle'), 2400); });
  }

  const tint = status === 'saved' ? '#34d399' : status === 'error' ? '#f87171' : (open ? '#a5b4fc' : '#6b7280');
  const optStyle: React.CSSProperties = {
    width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    background: 'transparent', border: '1px solid rgba(129,140,248,0.28)', borderRadius: 6,
    padding: '6px 9px', marginTop: 6, fontSize: 11, color: '#c7d2fe', cursor: 'pointer',
  };
  const extStyle: React.CSSProperties = { fontSize: 9, color: '#64748b', fontVariantNumeric: 'tabular-nums' };

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        title="Export concept (Markdown / Anki)"
        aria-label="Export concept"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={status === 'saving'}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 26, height: 24, background: open ? 'rgba(129,140,248,0.12)' : 'transparent',
          border: `1px solid ${open ? 'rgba(129,140,248,0.5)' : '#1f2937'}`, borderRadius: 4,
          color: tint, cursor: status === 'saving' ? 'default' : 'pointer',
        }}
      >
        {status === 'saved' ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>
        )}
      </button>
      {open && (
        <div role="menu" onClick={e => e.stopPropagation()} style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 30, minWidth: 158,
          background: 'rgba(4,6,26,0.34)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
          border: '1px solid #263244', borderRadius: 8, boxShadow: '0 14px 34px rgba(0,0,0,0.6)', padding: 9,
        }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.12em', padding: '0 2px' }}>Export as</div>
          <button className="rel-opt" role="menuitem" onClick={e => { e.stopPropagation(); doExport('markdown'); }} title="Export as Markdown (.md)" style={optStyle}>
            <span>Markdown</span><span style={extStyle}>.md</span>
          </button>
          <button className="rel-opt" role="menuitem" onClick={e => { e.stopPropagation(); doExport('anki'); }} title="Export as an Anki import file (.txt, tab-separated)" style={optStyle}>
            <span>Anki</span><span style={extStyle}>.txt</span>
          </button>
        </div>
      )}
    </div>
  );
}

interface Props { concept: Concept | null; onDeleted?: (conceptId: number) => void; profile?: Profile; }

export default function DetailPane({ concept, onDeleted, profile }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [mastery, setMastery] = useState<Mastery | null>(null);
  const [misconceptions, setMisconceptions] = useState<Misconception[]>([]);
  const [equations, setEquations] = useState<Equation[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [tab, setTab] = useState<'overview' | 'paper' | 'annotations' | 'challenge' | 'history'>('overview');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [response, setResponse] = useState('');
  const [grading, setGrading] = useState(false);
  const [grade, setGrade] = useState<Grade | null>(null);
  const [generatingTasks, setGeneratingTasks] = useState(false);
  const [taskGenError, setTaskGenError] = useState<string | null>(null);
  const [progress, setProgress] = useState<StudyProgress | null>(null);
  const [evidenceKinds, setEvidenceKinds] = useState<string[]>([]);
  const [sourcePreviewOpen, setSourcePreviewOpen] = useState(() => localStorage.getItem(SOURCE_PREVIEW_KEY) === 'true');
  const [sourcePreviewNotesWidth, setSourcePreviewNotesWidth] = useState(() => Number(localStorage.getItem(SOURCE_PREVIEW_NOTES_WIDTH_KEY)) || 760);
  const sourcePreviewSplitRef = useRef<HTMLDivElement>(null);
  const [jumpTarget, setJumpTarget] = useState<{ page: number; nonce: number } | null>(null);
  // Per-concept dismissed evidence-kind chips (a view preference, localStorage).
  const [dismissedKinds, setDismissedKinds] = useState<string[]>([]);
  useEffect(() => {
    if (!concept) { setDismissedKinds([]); return; }
    try {
      const raw = localStorage.getItem(`starcall.concept.${concept.id}.dismissedKinds`);
      setDismissedKinds(raw ? (JSON.parse(raw) as string[]) : []);
    } catch { setDismissedKinds([]); }
  }, [concept?.id]);
  function dismissKind(k: string): void {
    if (!concept) return;
    setDismissedKinds(prev => {
      if (prev.includes(k)) return prev;
      const next = [...prev, k];
      localStorage.setItem(`starcall.concept.${concept.id}.dismissedKinds`, JSON.stringify(next));
      return next;
    });
  }

  // Open the source preview (if closed) and scroll the PDF to a page — used
  // when a note's linked highlight chip is clicked.
  function handleJumpToAnnotation(page: number): void {
    setSourcePreviewOpen(true);
    setJumpTarget({ page, nonce: Date.now() });
  }

  useEffect(() => {
    if (!concept) return;
    setTasks([]); setMastery(null); setMisconceptions([]); setEquations([]);
    setHistory([]); setGrade(null); setSelectedTask(null); setResponse('');
    setTaskGenError(null); setGeneratingTasks(false);
    setEvidenceKinds([]);
    Promise.all([
      window.api.concepts.tasks(concept.id),
      window.api.concepts.mastery(concept.id),
      window.api.concepts.misconceptions(concept.id),
      window.api.evidence.history(concept.id),
      window.api.concepts.equations(concept.id),
      window.api.evidence.progress(),
      window.api.concepts.sourceEvidence(concept.id),
    ]).then(([t, m, mis, h, eq, prog, se]) => {
      const tl = t as Task[];
      setTasks(tl);
      setMastery(m as Mastery | null);
      setMisconceptions(mis as Misconception[]);
      setHistory((h as HistoryRecord[]).slice().reverse());
      setEquations(eq as Equation[]);
      setProgress(prog as StudyProgress);
      if (tl.length > 0) setSelectedTask(tl[0]);
      const evidence = (se as { evidence?: Array<{ kind: string }> } | null)?.evidence ?? [];
      setEvidenceKinds([...new Set(evidence.map(e => e.kind))]);
    });
  }, [concept?.id]);

  useEffect(() => {
    localStorage.setItem(SOURCE_PREVIEW_KEY, String(sourcePreviewOpen));
  }, [sourcePreviewOpen]);

  useEffect(() => {
    localStorage.setItem(SOURCE_PREVIEW_NOTES_WIDTH_KEY, String(sourcePreviewNotesWidth));
  }, [sourcePreviewNotesWidth]);

  function beginSourcePreviewResize(e: React.MouseEvent<HTMLElement>): void {
    e.preventDefault();
    const container = sourcePreviewSplitRef.current;
    if (!container) return;
    const onMove = (moveEvent: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const next = Math.max(360, Math.min(moveEvent.clientX - rect.left, rect.width - 420));
      setSourcePreviewNotesWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  async function generateTasks() {
    if (!concept) return;
    setGeneratingTasks(true);
    setTaskGenError(null);
    try {
      const result = await window.api.concepts.ensureTasks(concept.id);
      const tl = result as Task[];
      setTasks(tl);
      if (tl.length > 0) setSelectedTask(tl[0]);
    } catch (e) {
      setTaskGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingTasks(false);
    }
  }

  async function regenerateTasks() {
    if (!concept) return;
    const ok = window.confirm(
      'Regenerate all 5 challenge tasks for this concept? Existing tasks will be replaced. Past History entries are kept.',
    );
    if (!ok) return;
    setGeneratingTasks(true);
    setTaskGenError(null);
    try {
      const result = await window.api.concepts.regenerateTasks(concept.id);
      const tl = result as Task[];
      setTasks(tl);
      setSelectedTask(tl.length > 0 ? tl[0] : null);
      setGrade(null);
      setResponse('');
    } catch (e) {
      setTaskGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingTasks(false);
    }
  }

  async function handleDeleteRecord(recordId: number) {
    if (!concept) return;
    const ok = window.confirm('Delete this history entry? This cannot be undone. Mastery stage will be recomputed from the remaining attempts.');
    if (!ok) return;
    try {
      await window.api.evidence.delete(recordId);
      setHistory(prev => prev.filter(h => h.id !== recordId));
      // Re-fetch mastery + progress so the concept header and profile reflect
      // the recomputed state (deleting the row that held the highest stage
      // drops the concept back to MAX(remaining) or Unseen if none left).
      const [m, prog] = await Promise.all([
        window.api.concepts.mastery(concept.id),
        window.api.evidence.progress(),
      ]);
      setMastery(m as Mastery | null);
      setProgress(prog as StudyProgress);
      window.dispatchEvent(new Event('starcall:progressChanged'));
      window.dispatchEvent(new Event('starcall:review-queue-stale'));
    } catch (e) {
      window.alert(`Failed to delete: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleSubmit() {
    if (!selectedTask || !concept || !response.trim()) return;
    setGrading(true);
    try {
      const result = await window.api.evidence.submit({
        taskId: selectedTask.id, conceptId: concept.id,
        userResponse: response,
      });
      const g = result as Grade;
      setGrade(g);
      setMastery({ compression_stage: g.compression_stage });
      setHistory(prev => [result as HistoryRecord, ...prev]);
      setProgress(await window.api.evidence.progress() as StudyProgress);
      window.dispatchEvent(new Event('starcall:progressChanged'));
      window.dispatchEvent(new Event('starcall:review-queue-stale'));
    } finally {
      setGrading(false);
    }
  }

  if (!concept) {
    return (
      <main style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#374151',
        fontSize: 14,
        position: 'relative',
        overflow: 'hidden',
        background: 'transparent',
      }}>
        <span style={{ position: 'relative', zIndex: 1 }}>Select a concept to explore.</span>
      </main>
    );
  }

  const stage = mastery?.compression_stage ?? 0;
  // Header evidence-kind chips. evidenceKinds is a snapshot from sourceEvidence
  // at load; the "equation" kind is derived live from the equations state so
  // adding/deleting an equation updates the chip without a refetch.
  const headerKinds = (() => {
    const set = new Set(evidenceKinds);
    if (equations.length > 0) set.add('equation');
    else set.delete('equation');
    // 'highlight' spans exist for the Evidence rail but add noise as a header
    // chip — every highlight would surface one.
    set.delete('highlight');
    for (const k of dismissedKinds) set.delete(k);
    return [...set];
  })();
  const TAB_LABELS = {
    overview: 'Overview',
    paper: 'Paper',
    annotations: 'Annotations',
    challenge: 'Challenges',
    history: `History${history.length ? ` (${history.length})` : ''}`,
  };
  const activeTabContent = (
    <>
      {tab === 'overview' && <OverviewTab concept={concept} misconceptions={misconceptions} equations={equations} onEquationsChange={setEquations} />}
      {tab === 'paper' && <PaperTab conceptId={concept.id} />}
      {tab === 'annotations' && concept.source_id != null && <AnnotationsTab conceptId={concept.id} sourceId={concept.source_id} onJumpToAnnotation={handleJumpToAnnotation} />}
      {tab === 'challenge' && (
        <ChallengeTab
          tasks={tasks} selectedTask={selectedTask} onSelectTask={setSelectedTask}
          response={response} onResponseChange={setResponse}
          grading={grading} grade={grade}
          generatingTasks={generatingTasks} taskGenError={taskGenError}
          onGenerateTasks={generateTasks}
          onRegenerateTasks={regenerateTasks}
          onSubmit={handleSubmit} onReset={() => { setGrade(null); setResponse(''); }}
        />
      )}
      {tab === 'history' && <HistoryTab records={history} onDelete={handleDeleteRecord} />}
    </>
  );
  const tabBar = (
    <div style={{ display: 'flex', gap: 2 }}>
      {(['overview', 'paper', 'annotations', 'challenge', 'history'] as const).map(t => (
        <button key={t} onClick={() => setTab(t)} style={{
          background: 'none', border: 'none', padding: '6px 16px', fontSize: 12, cursor: 'pointer',
          color: tab === t ? '#818cf8' : '#4b5563',
          borderBottom: `2px solid ${tab === t ? '#818cf8' : 'transparent'}`,
          fontWeight: tab === t ? 600 : 400, marginBottom: -1,
        }}>
          {TAB_LABELS[t]}
        </button>
      ))}
    </div>
  );

  if (sourcePreviewOpen) {
    return (
      <main ref={sourcePreviewSplitRef} style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <section style={{
          flex: `0 0 ${sourcePreviewNotesWidth}px`, minWidth: 360, maxWidth: '70%',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          borderRight: '1px solid #1f2937',
        }}>
          <header style={{
            padding: '12px 24px 0',
            borderBottom: '1px solid rgba(31,41,55,0.72)',
            background: 'rgba(4,6,26,0.34)',
            backdropFilter: 'blur(14px)',
            flexShrink: 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, minWidth: 0 }}>
              <EditableTitle concept={concept} compact />
              <ImportancePill concept={concept} compact />
              {headerKinds.map(k => (
                <KindChip key={k} kind={k} onDismiss={() => dismissKind(k)} />
              ))}
              <TagBar concept={concept} />
              <span style={{ marginLeft: 'auto', fontSize: 11, padding: '3px 10px', borderRadius: 12, background: `${STAGE_COLORS[stage]}22`, color: STAGE_COLORS[stage], fontWeight: 600, flexShrink: 0 }}>
                {STAGES[stage]}
              </span>
              <RescheduleButton conceptId={concept.id} />
              <ExportButton conceptId={concept.id} />
              <button
                onClick={() => setSourcePreviewOpen(false)}
                title="Hide source"
                style={{ background: '#1e1b4b', border: '1px solid #4338ca', borderRadius: 4, padding: '3px 10px', color: '#c7d2fe', fontSize: 0, cursor: 'pointer', flexShrink: 0 }}
              >
                ×
                <span style={{ fontSize: 11 }}>Source</span>
              </button>
            </div>
            {tabBar}
          </header>
          <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
            {activeTabContent}
          </div>
        </section>
        <section style={{ flex: 1, minWidth: 520, display: 'flex', overflow: 'hidden' }}>
          <PdfViewer
            key={`preview:${concept.id}`}
            conceptId={concept.id}
            conceptName={concept.name}
            stabilityKey={tab}
            onResizeMouseDown={beginSourcePreviewResize}
            jumpTarget={jumpTarget}
          />
        </section>
      </main>
    );
  }

  return (
    <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <header style={{
        padding: '14px 24px 0',
        borderBottom: '1px solid rgba(31,41,55,0.72)',
        background: 'rgba(4,6,26,0.34)',
        backdropFilter: 'blur(14px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <EditableTitle concept={concept} />
          <ImportancePill concept={concept} />
          {headerKinds.map(k => (
            <KindChip key={k} kind={k} onDismiss={() => dismissKind(k)} />
          ))}
          <TagBar concept={concept} />
          <span style={{ marginLeft: 'auto', fontSize: 11, padding: '3px 10px', borderRadius: 12, background: `${STAGE_COLORS[stage]}22`, color: STAGE_COLORS[stage], fontWeight: 600 }}>
            {STAGES[stage]}
          </span>
          <RescheduleButton conceptId={concept.id} />
          <ExportButton conceptId={concept.id} />
          <button
            onClick={() => setSourcePreviewOpen(v => !v)}
            title="Show source on the right"
            style={{
              background: 'transparent',
              border: '1px solid #1f2937',
              borderRadius: 4, padding: '3px 10px',
              color: '#6b7280',
              fontSize: 11, cursor: 'pointer',
            }}
          >
            Source
          </button>
        </div>
        {tabBar}
      </header>

      <div style={{
        flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        overflowY: 'auto', padding: 24,
      }}>
        {activeTabContent}
      </div>
    </main>
  );
}

// Heading used for the single notes record that backs Paper mode. Hidden from
// the structured "My Notes" list so the two views don't visually collide.
export const PAPER_NOTE_HEADING = '__paper__';

// Paper mode: a low-chrome personal-synthesis scratchpad backed by one
// dedicated per-concept notes record. Notebook-style autosave (debounced +
// on blur + on tab/concept switch) — never an explicit save. Plain text only;
// [[concept]] / [[p.133]] backlinks stay literal for a future linking pass.
function PaperTab({ conceptId }: { conceptId: number }) {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const textRef = useRef('');
  const noteIdRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    window.api.concepts.notes.list(conceptId).then(rows => {
      if (cancelled) return;
      const paper = (rows as Array<{ id: number; heading: string; body: string }>)
        .find(n => n.heading === PAPER_NOTE_HEADING);
      noteIdRef.current = paper?.id ?? null;
      const body = paper?.body ?? '';
      textRef.current = body;
      setText(body);
      dirtyRef.current = false;
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [conceptId]);

  const flush = useCallback(async () => {
    if (!dirtyRef.current) return;
    const body = textRef.current;
    // Don't create an empty record just because the tab was opened.
    if (noteIdRef.current == null && body.trim() === '') return;
    dirtyRef.current = false;
    if (noteIdRef.current == null) {
      const created = await window.api.concepts.notes.create({
        conceptId, heading: PAPER_NOTE_HEADING, body,
      });
      noteIdRef.current = (created as { id: number }).id;
    } else {
      await window.api.concepts.notes.update({ id: noteIdRef.current, body });
    }
    setSavedAt(Date.now());
  }, [conceptId]);

  // Flush pending edits when switching concept/tab (component unmount).
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    void flush();
  }, [flush]);

  function onChange(v: string) {
    setText(v);
    textRef.current = v;
    dirtyRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void flush(); }, 400);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '60vh' }}>
      <RichTextArea
        value={loaded ? text : ''}
        onChange={onChange}
        onBlur={() => { void flush(); }}
        readOnly={!loaded}
        placeholder={loaded ? 'Think on paper. Synthesize, connect, draft — autosaves.' : 'Loading…'}
        spellCheck
        placeholderColor="#4b5563"
        textStyle={{
          flex: 1, width: '100%', boxSizing: 'border-box',
          background: 'transparent', border: 'none', outline: 'none', resize: 'none',
          color: '#d8dee9', fontSize: 15, lineHeight: 1.8,
          fontFamily: 'ui-serif, Georgia, "Times New Roman", serif',
          padding: 0, minHeight: '58vh',
        }}
      />
      <div style={{ fontSize: 10, color: '#374151', marginTop: 8, height: 12 }}>
        {savedAt ? 'Saved' : ''}
      </div>
    </div>
  );
}

// ─── Annotations tab ─────────────────────────────────────────────────────────
// Unified surface for the source→highlight→evidence→note workflow:
//   - Each highlight card pairs with its linked note inline (no more silo).
//   - "+ Note" on a highlight creates one auto-linked to it.
//   - Standalone notes (no linked highlight) live below.
//   - "Other Evidence" (heading/chunk/equation/relation/first_page) is
//     editable inline here — the source pane's rail is now display+delete only.
// Refetches on `starcall:evidenceChanged` / `starcall:notesChanged`.

interface HighlightLite {
  id: number;
  page: number;
  color: string;
  selected_text: string;
  label: string;
  note_body: string;
}
interface NoteLite {
  id: number;
  heading: string;
  body: string;
  linked_annotation_id: number | null;
  position: number;
}
interface EvidenceLite {
  index: number;
  page: number;
  kind: string;
  label: string;
  quote?: string;
}

const ANNOTATIONS_PAPER_HEADING = '__paper__';
const ANNOTATIONS_EVIDENCE_KINDS = ['chunk', 'heading', 'definition', 'equation', 'relation', 'first_page', 'highlight'];

function AnnotationsTab({ conceptId, sourceId, onJumpToAnnotation }: {
  conceptId: number;
  sourceId: number;
  onJumpToAnnotation: (page: number) => void;
}) {
  const [highlights, setHighlights] = useState<HighlightLite[]>([]);
  const [notes, setNotes] = useState<NoteLite[]>([]);
  const [evidence, setEvidence] = useState<EvidenceLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState<{ heading: string; body: string } | null>(null);
  const [editingEvIdx, setEditingEvIdx] = useState<number | null>(null);
  const [evDraft, setEvDraft] = useState<{ page: string; kind: string; label: string; quote: string } | null>(null);
  // Only one ⋯ menu open at a time across the whole tab.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  // Which standalone note is currently picking a highlight to relink to.
  const [linkingNoteId, setLinkingNoteId] = useState<number | null>(null);
  // Drag-to-reorder state for the standalone notes list.
  const [dragNoteId, setDragNoteId] = useState<number | null>(null);
  const [dragOverNoteId, setDragOverNoteId] = useState<number | null>(null);

  useEffect(() => {
    const handler = () => setRefreshTick(t => t + 1);
    window.addEventListener('starcall:evidenceChanged', handler);
    window.addEventListener('starcall:notesChanged', handler);
    return () => {
      window.removeEventListener('starcall:evidenceChanged', handler);
      window.removeEventListener('starcall:notesChanged', handler);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      window.api.sources.annotations.list(sourceId),
      window.api.concepts.notes.list(conceptId),
      window.api.concepts.sourceEvidence(conceptId),
    ]).then(([anns, ns, se]) => {
      if (cancelled) return;
      setHighlights(anns
        .filter(a => a.type === 'highlight' && (a.concept_id === conceptId || a.scope === 'source'))
        .map(a => ({ id: a.id, page: a.page, color: a.color, selected_text: a.selected_text, label: a.label, note_body: a.note_body }))
        .sort((x, y) => x.page - y.page || x.id - y.id));
      setNotes((ns as NoteLite[]).filter(n => n.heading !== ANNOTATIONS_PAPER_HEADING).sort((a, b) => a.position - b.position));
      setEvidence(((se?.evidence ?? []) as EvidenceLite[]));
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sourceId, conceptId, refreshTick]);

  function bump() { setRefreshTick(t => t + 1); }
  function notifyEv() { window.dispatchEvent(new Event('starcall:evidenceChanged')); }
  function notifyNotes() { window.dispatchEvent(new Event('starcall:notesChanged')); }

  async function deleteHighlight(h: HighlightLite) {
    try {
      await window.api.sources.annotations.delete(h.id);
      try { await window.api.concepts.deleteEvidenceSpan({ conceptId, page: h.page, kind: 'highlight', quote: h.selected_text }); } catch { /* span may not exist */ }
      try {
        const ns = await window.api.concepts.notes.list(conceptId);
        await Promise.all((ns as Array<{ id: number; linked_annotation_id: number | null }>)
          .filter(n => n.linked_annotation_id === h.id)
          .map(n => window.api.concepts.notes.update({ id: n.id, linkedAnnotationId: null })));
      } catch { /* best-effort */ }
      notifyEv(); notifyNotes(); bump();
    } catch (e) { console.error('[AnnotationsTab] deleteHighlight', e); }
  }

  async function createNoteForHighlight(h: HighlightLite) {
    try {
      const created = await window.api.concepts.notes.create({ conceptId, heading: `p.${h.page}`, body: '' }) as { id: number };
      await window.api.concepts.notes.update({ id: created.id, linkedAnnotationId: h.id });
      setEditingNoteId(created.id);
      setNoteDraft({ heading: `p.${h.page}`, body: '' });
      notifyNotes(); bump();
    } catch (e) { console.error('[AnnotationsTab] createNoteForHighlight', e); }
  }
  async function createStandaloneNote() {
    try {
      const created = await window.api.concepts.notes.create({ conceptId, heading: '', body: '' }) as { id: number };
      setEditingNoteId(created.id);
      setNoteDraft({ heading: '', body: '' });
      notifyNotes(); bump();
    } catch (e) { console.error('[AnnotationsTab] createStandaloneNote', e); }
  }
  function startEditNote(n: NoteLite) {
    setEditingNoteId(n.id);
    setNoteDraft({ heading: n.heading, body: n.body });
  }
  async function saveNote() {
    if (editingNoteId == null || !noteDraft) return;
    try {
      await window.api.concepts.notes.update({ id: editingNoteId, heading: noteDraft.heading, body: noteDraft.body });
      notifyNotes(); bump();
    } finally {
      setEditingNoteId(null);
      setNoteDraft(null);
    }
  }
  function cancelEditNote() { setEditingNoteId(null); setNoteDraft(null); }
  async function deleteNote(id: number) {
    try { await window.api.concepts.notes.delete(id); notifyNotes(); bump(); }
    catch (e) { console.error('[AnnotationsTab] deleteNote', e); }
  }
  async function unlinkNote(id: number) {
    try { await window.api.concepts.notes.update({ id, linkedAnnotationId: null }); notifyNotes(); bump(); }
    catch (e) { console.error('[AnnotationsTab] unlinkNote', e); }
  }
  async function linkNoteToHighlight(noteId: number, annotationId: number) {
    try {
      await window.api.concepts.notes.update({ id: noteId, linkedAnnotationId: annotationId });
      setLinkingNoteId(null);
      notifyNotes(); bump();
    } catch (e) { console.error('[AnnotationsTab] linkNoteToHighlight', e); }
  }

  // Drag-reorder notes WITHIN a single group — either the standalone set
  // (group === null) or the notes attached to one highlight (group === its
  // annotation id). The reorder IPC takes the full ordered id list, so we
  // permute only that group's slots within `notes` and leave every other note
  // pinned in place. Cross-group drops are ignored.
  async function reorderNotes(draggedId: number, targetId: number) {
    if (draggedId === targetId) return;
    const dragged = notes.find(n => n.id === draggedId);
    const target = notes.find(n => n.id === targetId);
    if (!dragged || !target) return;
    const group = dragged.linked_annotation_id ?? null;
    if ((target.linked_annotation_id ?? null) !== group) return; // same group only
    const order = notes.filter(n => (n.linked_annotation_id ?? null) === group).map(n => n.id);
    const from = order.indexOf(draggedId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    let qi = 0;
    const fullOrder = notes.map(n => ((n.linked_annotation_id ?? null) === group ? order[qi++] : n.id));
    const byId = new Map(notes.map(n => [n.id, n]));
    setNotes(fullOrder.map((id, i) => ({ ...byId.get(id)!, position: i })));
    try {
      const out = await window.api.concepts.notes.reorder({ conceptId, orderedIds: fullOrder });
      const fresh = (out as NoteLite[]).filter(n => n.heading !== ANNOTATIONS_PAPER_HEADING).sort((a, b) => a.position - b.position);
      setNotes(fresh);
      notifyNotes();
    } catch (e) { console.error('[AnnotationsTab] reorderNotes', e); bump(); }
  }

  function startEditEvidence(ev: EvidenceLite) {
    setEditingEvIdx(ev.index);
    setEvDraft({ page: String(ev.page), kind: ev.kind, label: ev.label, quote: ev.quote ?? '' });
  }
  async function saveEvidence() {
    if (editingEvIdx == null || !evDraft) return;
    try {
      await window.api.concepts.updateEvidence({
        conceptId, index: editingEvIdx,
        page: Number(evDraft.page) || 1,
        kind: evDraft.kind,
        label: evDraft.label.trim() || evDraft.kind,
        quote: evDraft.quote.trim() || undefined,
      });
      notifyEv(); bump();
    } finally {
      setEditingEvIdx(null);
      setEvDraft(null);
    }
  }
  function cancelEditEvidence() { setEditingEvIdx(null); setEvDraft(null); }
  async function deleteEvidenceSpan(index: number) {
    try { await window.api.concepts.deleteEvidence({ conceptId, index }); notifyEv(); bump(); }
    catch (e) { console.error('[AnnotationsTab] deleteEvidence', e); }
  }

  function snippet(text: string, max = 220): string {
    const t = (text ?? '').trim().replace(/\s+/g, ' ');
    return t.length > max ? `${t.slice(0, max)}…` : t;
  }

  // A highlight can carry more than one note, so group rather than 1:1 map.
  const notesByHl = new Map<number, NoteLite[]>();
  for (const n of notes) {
    if (n.linked_annotation_id == null) continue;
    const arr = notesByHl.get(n.linked_annotation_id);
    if (arr) arr.push(n); else notesByHl.set(n.linked_annotation_id, [n]);
  }
  const standaloneNotes = notes.filter(n => n.linked_annotation_id == null);
  const otherEvidence = evidence.filter(e => e.kind !== 'highlight' && e.index >= 0);

  const card: React.CSSProperties = {
    background: 'rgba(13,13,22,0.35)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    border: '1px solid rgba(31,41,55,0.7)', borderRadius: 6,
    // No overflow:hidden — would clip the ⋯ menu popovers. Color bar gets its
    // own rounded corners below so it still hugs the card edge cleanly.
  };
  const sectionHeading: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em',
  };
  const inp: React.CSSProperties = {
    background: 'rgba(17,24,39,0.45)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    border: '1px solid #263244', borderRadius: 4, padding: '5px 8px', color: '#e2e8f0', fontSize: 12, outline: 'none', boxSizing: 'border-box',
  };
  const ghostBtn: React.CSSProperties = {
    background: 'transparent', border: '1px solid #1f2937', borderRadius: 4,
    padding: '2px 8px', fontSize: 10, color: '#a5b4fc', cursor: 'pointer',
  };
  const primaryBtn: React.CSSProperties = {
    background: '#312e81', border: '1px solid #6366f1', borderRadius: 4,
    padding: '3px 10px', fontSize: 11, color: '#e0e7ff', cursor: 'pointer',
  };

  function renderNoteEditor(): React.ReactNode {
    if (!noteDraft) return null;
    return (
      <>
        <textarea
          value={noteDraft.body}
          onChange={e => setNoteDraft(d => d ? { ...d, body: e.target.value } : d)}
          onKeyDown={e => applyMarkdownShortcut(e, noteDraft.body, body => setNoteDraft(d => d ? { ...d, body } : d))}
          placeholder="Write your note here…  (**bold**, *italic*)"
          rows={3}
          autoFocus
          style={{ ...inp, background: 'transparent', width: '100%', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button onClick={() => void saveNote()} style={primaryBtn}>Save</button>
          <button onClick={cancelEditNote} style={ghostBtn}>Cancel</button>
        </div>
      </>
    );
  }

  // Drag handle (six-dot grip) for reordering standalone notes.
  const gripIcon = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
    </svg>
  );

  // Single ⋯ overflow menu shared by every row. Items declare their label and
  // a `danger` flag (red); the menu wrapper uses the .anno-actions class so
  // it inherits the card's hover-reveal behavior.
  function renderActionMenu(
    menuId: string,
    items: Array<{ label: string; onClick: () => void; danger?: boolean }>,
    wrapperStyle?: React.CSSProperties,
    accent?: string,
  ): React.ReactNode {
    const isOpen = openMenuId === menuId;
    return (
      <div
        className="anno-actions"
        data-open={isOpen ? 'true' : 'false'}
        style={{ position: 'relative', display: 'inline-block', ...wrapperStyle }}
      >
        <button
          onClick={() => setOpenMenuId(prev => prev === menuId ? null : menuId)}
          onBlur={() => setTimeout(() => setOpenMenuId(prev => prev === menuId ? null : prev), 130)}
          title="More actions"
          aria-haspopup="true"
          aria-expanded={isOpen}
          style={{
            background: 'transparent', border: '1px solid #1f2937', borderRadius: 4,
            padding: '1px 8px', color: '#94a3b8', cursor: 'pointer',
            fontSize: 14, lineHeight: 1,
          }}
        >⋯</button>
        {isOpen && (
          <div
            role="menu"
            style={{
              position: 'absolute', top: '100%', right: 0, marginTop: 3, zIndex: 30,
              background: 'rgba(13,13,22,0.94)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
              border: `1px solid ${accent ? 'transparent' : '#312e81'}`, borderRadius: 6,
              boxShadow: '0 8px 24px rgba(0,0,0,0.55)', padding: 3,
            }}
          >
            {items.map((it, i) => (
              <button
                key={i}
                role="menuitem"
                className="rel-opt"
                onMouseDown={e => e.preventDefault()}
                onClick={() => { setOpenMenuId(null); it.onClick(); }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', whiteSpace: 'nowrap',
                  background: 'transparent', border: 'none', borderRadius: 4,
                  padding: '4px 9px', fontSize: 11,
                  color: it.danger ? '#fca5a5' : '#cbd5e1', cursor: 'pointer',
                }}
              >{it.label}</button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 22 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, paddingBottom: 6, borderBottom: '1px solid rgba(31,41,55,0.7)' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>Annotations</div>
        <div style={{ fontSize: 11, color: '#64748b' }}>
          {highlights.length} highlight{highlights.length === 1 ? '' : 's'} · {notes.length} note{notes.length === 1 ? '' : 's'} · {otherEvidence.length} evidence
        </div>
        <button onClick={() => void createStandaloneNote()} style={{ ...primaryBtn, marginLeft: 'auto' }}>+ Note</button>
      </div>

      {/* HIGHLIGHTS — each paired with its linked note inline */}
      <section>
        <div style={{ ...sectionHeading, marginBottom: 14 }}>Highlights</div>
        {loading ? (
          <div style={{ fontSize: 12, color: '#4b5563' }}>Loading…</div>
        ) : highlights.length === 0 ? (
          <div style={{ fontSize: 12, color: '#4b5563', padding: '14px', lineHeight: 1.6, ...card, borderStyle: 'dashed' }}>
            No highlights yet. Open the <span style={{ color: '#a5b4fc' }}>Source</span> pane, select text, and click Highlight — it'll show up here paired with an optional note.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {highlights.map(h => {
              const linkedNotes = notesByHl.get(h.id) ?? [];
              return (
                <div key={h.id} className="anno-card" style={{ ...card, display: 'flex', alignItems: 'stretch' }}>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 4, background: h.color, flexShrink: 0,
                      // Match the card's border-radius so the bar hugs the edge
                      // now that the card no longer clips with overflow: hidden.
                      borderTopLeftRadius: 5,
                      borderBottomLeftRadius: 5,
                    }}
                  />
                  <div style={{ flex: 1, padding: '10px 12px', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, minHeight: 22 }}>
                      <span style={{ fontSize: 11, color: '#a5b4fc', fontWeight: 700 }}>p.{h.page}</span>
                      {h.label && (<span style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic' }}>{h.label}</span>)}
                      <div className="anno-actions" style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                        <button onClick={() => onJumpToAnnotation(h.page)} title="Jump to this highlight in source" style={{ ...ghostBtn, borderColor: `color-mix(in srgb, ${h.color} 55%, transparent)` }}>Jump</button>
                        <button onClick={() => void createNoteForHighlight(h)} title="Add a note linked to this highlight" style={{ ...ghostBtn, borderColor: `color-mix(in srgb, ${h.color} 55%, transparent)` }}>+ Note</button>
                      </div>
                      {renderActionMenu(`hl-${h.id}`, [
                        { label: 'Delete', onClick: () => void deleteHighlight(h), danger: true },
                      ], undefined, h.color)}
                    </div>
                    {/* Pull-quote treatment for the highlighted text */}
                    <div style={{
                      fontSize: 13, color: '#cbd5e1', lineHeight: 1.55, fontStyle: 'italic',
                      borderLeft: `2px solid ${h.color}`, paddingLeft: 10,
                      wordBreak: 'break-word',
                    }}>
                      {snippet(h.selected_text) || <span style={{ color: '#475569', fontStyle: 'normal' }}>(no text captured)</span>}
                    </div>
                    {/* Optional memo (the popover's comment field) — only renders when set */}
                    {h.note_body && h.note_body.trim() && (
                      <div style={{
                        marginTop: 8, fontSize: 11, color: '#94a3b8', lineHeight: 1.5,
                        paddingLeft: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      }}>
                        {snippet(h.note_body, 240)}
                      </div>
                    )}
                    {linkedNotes.map(linked => {
                      const editingThisNote = editingNoteId === linked.id;
                      const isDragOver = dragOverNoteId === linked.id && dragNoteId !== linked.id;
                      const canDrag = !editingThisNote && linkedNotes.length > 1;
                      return (
                        <div
                          key={linked.id}
                          draggable={canDrag}
                          onDragStart={e => { if (!canDrag) return; setDragNoteId(linked.id); e.dataTransfer.effectAllowed = 'move'; e.stopPropagation(); }}
                          onDragOver={e => { if (dragNoteId != null && dragNoteId !== linked.id) { e.preventDefault(); setDragOverNoteId(linked.id); } }}
                          onDragLeave={() => setDragOverNoteId(prev => (prev === linked.id ? null : prev))}
                          onDrop={e => { e.preventDefault(); if (dragNoteId != null) void reorderNotes(dragNoteId, linked.id); setDragNoteId(null); setDragOverNoteId(null); }}
                          onDragEnd={() => { setDragNoteId(null); setDragOverNoteId(null); }}
                          style={{
                            position: 'relative',
                            marginTop: 10, padding: '9px 11px', borderRadius: 5,
                            background: 'transparent',
                            border: isDragOver ? '1px solid #6366f1' : `1px solid color-mix(in srgb, ${h.color} 35%, transparent)`,
                            borderTop: isDragOver ? '2px solid #6366f1' : `1px solid color-mix(in srgb, ${h.color} 35%, transparent)`,
                            opacity: dragNoteId === linked.id ? 0.45 : 1,
                          }}
                        >
                          {editingThisNote ? renderNoteEditor() : (
                            <>
                              <div style={{ position: 'absolute', top: 6, right: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                                {renderActionMenu(`note-${linked.id}`, [
                                  { label: 'Edit',   onClick: () => startEditNote(linked) },
                                  { label: 'Unlink', onClick: () => void unlinkNote(linked.id) },
                                  { label: 'Delete', onClick: () => void deleteNote(linked.id), danger: true },
                                ], undefined, h.color)}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                                {canDrag && (
                                  <span title="Drag to reorder" style={{ display: 'inline-flex', alignItems: 'center', height: '1.55em', fontSize: 12, color: '#475569', cursor: 'grab', flexShrink: 0 }}>
                                    {gripIcon}
                                  </span>
                                )}
                                <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#c4cfe4', whiteSpace: 'pre-wrap', lineHeight: 1.55, paddingRight: 22 }}>
                                  {linked.body ? renderMarkdown(linked.body, `lnote-${linked.id}`) : <span style={{ color: '#475569' }}>(empty — open the ⋯ menu to edit)</span>}
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* STANDALONE NOTES (no linked highlight) */}
      {(standaloneNotes.length > 0 || (editingNoteId != null && noteDraft != null && !notesByHl.has(editingNoteId))) && (
        <section>
          <div style={{ ...sectionHeading, marginBottom: 14 }}>Notes (no linked highlight)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {standaloneNotes.map(n => {
              const editing = editingNoteId === n.id;
              const isDragOver = dragOverNoteId === n.id && dragNoteId !== n.id;
              return (
                <div
                  key={n.id}
                  className="anno-card"
                  draggable={!editing}
                  onDragStart={e => { setDragNoteId(n.id); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={e => { if (dragNoteId != null && dragNoteId !== n.id) { e.preventDefault(); setDragOverNoteId(n.id); } }}
                  onDragLeave={() => setDragOverNoteId(prev => (prev === n.id ? null : prev))}
                  onDrop={e => { e.preventDefault(); if (dragNoteId != null) void reorderNotes(dragNoteId, n.id); setDragNoteId(null); setDragOverNoteId(null); }}
                  onDragEnd={() => { setDragNoteId(null); setDragOverNoteId(null); }}
                  style={{
                    ...card, padding: '10px 12px', position: 'relative', background: 'transparent',
                    opacity: dragNoteId === n.id ? 0.45 : 1,
                    borderTop: isDragOver ? '2px solid #6366f1' : (card.border as string),
                  }}
                >
                  {editing && noteDraft ? renderNoteEditor() : (
                    <>
                      <div style={{ position: 'absolute', top: 7, right: 9, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {renderActionMenu(`note-s-${n.id}`, [
                          { label: 'Edit',              onClick: () => startEditNote(n) },
                          { label: 'Link to highlight', onClick: () => setLinkingNoteId(n.id) },
                          { label: 'Delete',            onClick: () => void deleteNote(n.id), danger: true },
                        ])}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                        <span
                          title="Drag to reorder"
                          style={{ display: 'inline-flex', alignItems: 'center', height: '1.55em', fontSize: 12, color: '#475569', cursor: 'grab', flexShrink: 0 }}
                        >
                          {gripIcon}
                        </span>
                        <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#c4cfe4', whiteSpace: 'pre-wrap', lineHeight: 1.55, paddingRight: 22 }}>
                          {n.body ? renderMarkdown(n.body, `snote-${n.id}`) : <span style={{ color: '#475569' }}>(empty)</span>}
                        </div>
                      </div>
                      {linkingNoteId === n.id && (
                        <div style={{
                          marginTop: 10, padding: 8, borderRadius: 5,
                          background: 'rgba(13,13,22,0.5)', border: '1px dashed rgba(99,102,241,0.55)',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                            <span style={{ fontSize: 10, color: '#a5b4fc', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                              Link to a highlight
                            </span>
                            <button onClick={() => setLinkingNoteId(null)} style={{ marginLeft: 'auto', ...ghostBtn }}>Cancel</button>
                          </div>
                          {highlights.length === 0 ? (
                            <div style={{ fontSize: 11, color: '#64748b' }}>No highlights yet — add one in the Source pane first.</div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
                              {highlights.map(h => (
                                <button
                                  key={h.id}
                                  className="rel-opt"
                                  onClick={() => void linkNoteToHighlight(n.id, h.id)}
                                  title={`Link this note to the p.${h.page} highlight`}
                                  style={{
                                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                                    background: 'rgba(99,102,241,0.10)', border: '1px solid rgba(99,102,241,0.45)',
                                    borderRadius: 6, padding: '8px 10px',
                                    fontSize: 11, color: '#cbd5e1', cursor: 'pointer',
                                  }}
                                >
                                  <span style={{ width: 4, height: 14, borderRadius: 1, background: h.color, flexShrink: 0 }} />
                                  <span style={{ color: '#a5b4fc', fontWeight: 700 }}>p.{h.page}</span>
                                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {snippet(h.selected_text, 80)}
                                  </span>
                                  <span style={{ flexShrink: 0, fontWeight: 700, color: '#a5b4fc', letterSpacing: '0.03em' }}>Link →</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* OTHER EVIDENCE — non-highlight spans, editable inline (moved from rail) */}
      <section>
        <div style={{ ...sectionHeading, marginBottom: 14 }}>Other Evidence</div>
        {otherEvidence.length === 0 ? (
          <div style={{ fontSize: 11, color: '#4b5563', padding: '12px 14px', ...card, borderStyle: 'dashed' }}>
            No non-highlight evidence yet — auto-derived spans (heading, chunk, equation, …) appear here once the concept is enriched, and you can add or edit them via the <span style={{ color: '#a5b4fc' }}>+</span> button in the source rail.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {otherEvidence.map(ev => {
              const editing = editingEvIdx === ev.index;
              return (
                <div key={`ev-${ev.index}`} className="anno-card" style={{ ...card, padding: '10px 12px' }}>
                  {editing && evDraft ? (
                    <>
                      <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                        <input value={evDraft.page} onChange={e => setEvDraft(d => d ? { ...d, page: e.target.value } : d)}
                          placeholder="pg" inputMode="numeric" style={{ ...inp, width: 60 }} />
                        <select value={evDraft.kind} onChange={e => setEvDraft(d => d ? { ...d, kind: e.target.value } : d)}
                          style={{ ...inp, cursor: 'pointer', width: 150 }}>
                          {ANNOTATIONS_EVIDENCE_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                        </select>
                        <input value={evDraft.label} onChange={e => setEvDraft(d => d ? { ...d, label: e.target.value } : d)}
                          placeholder="label" style={{ ...inp, flex: 1, minWidth: 120 }} />
                      </div>
                      <textarea value={evDraft.quote} onChange={e => setEvDraft(d => d ? { ...d, quote: e.target.value } : d)}
                        placeholder="quote (optional)" rows={2}
                        style={{ ...inp, width: '100%', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45 }} />
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        <button onClick={() => void saveEvidence()} style={primaryBtn}>Save</button>
                        <button onClick={cancelEditEvidence} style={ghostBtn}>Cancel</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap', minHeight: 22 }}>
                        <span style={{ fontSize: 11, color: '#a5b4fc', fontWeight: 700 }}>p.{ev.page}</span>
                        <span style={{
                          fontSize: 9, padding: '1px 6px', borderRadius: 3,
                          border: `1px solid ${EVIDENCE_KIND_COLOR[ev.kind] ?? '#374151'}`,
                          color: EVIDENCE_KIND_COLOR[ev.kind] ?? '#6b7280',
                          textTransform: 'uppercase', letterSpacing: '0.05em',
                        }}>{ev.kind}</span>
                        {ev.label && (<span style={{ fontSize: 10, color: '#94a3b8' }}>{ev.label}</span>)}
                        <div className="anno-actions" style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                          <button onClick={() => onJumpToAnnotation(ev.page)} style={ghostBtn}>Jump</button>
                        </div>
                        {renderActionMenu(`ev-${ev.index}`, [
                          { label: 'Edit',   onClick: () => startEditEvidence(ev) },
                          { label: 'Delete', onClick: () => void deleteEvidenceSpan(ev.index), danger: true },
                        ])}
                      </div>
                      {ev.quote && (
                        <div style={{
                          fontSize: 12, color: '#cbd5e1', fontStyle: 'italic', lineHeight: 1.5,
                          borderLeft: '2px solid rgba(67,56,202,0.45)', paddingLeft: 10,
                          wordBreak: 'break-word',
                        }}>
                          {snippet(ev.quote, 180)}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function OverviewTab({ concept, misconceptions, equations, onEquationsChange }: {
  concept: Concept;
  misconceptions: Misconception[];
  equations: Equation[];
  onEquationsChange: (equations: Equation[]) => void;
}) {
  const [local, setLocal] = useState({
    definition_text: concept.definition_text || '',
    why_exists:      concept.why_exists      || '',
    what_breaks:     concept.what_breaks     || '',
  });
  // Accepts legacy bare-string links and the current { name, reason } shape.
  const normalizeReappears = (v: Concept['where_reappears']): ConstellationLink[] => {
    const arr = Array.isArray(v) ? v : (typeof v === 'string' && v.trim() !== '' ? [v] : []);
    return (arr as Array<unknown>)
      .map(raw => {
        if (typeof raw === 'string') return { name: raw, reason: '' };
        const o = raw as { name?: string; reason?: string };
        return o && typeof o.name === 'string' ? { name: o.name, reason: o.reason ?? '' } : null;
      })
      .filter((l): l is ConstellationLink => l != null && l.name.trim() !== '');
  };
  const [constellations, setConstellations] = useState<ConstellationLink[]>(() => normalizeReappears(concept.where_reappears));
  const [enriching, setEnriching] = useState(false);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [enrichErr, setEnrichErr] = useState<string | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const [pasteApplied, setPasteApplied] = useState(false);
  const [addingEquation, setAddingEquation] = useState(false);
  const [equationDraft, setEquationDraft] = useState('');
  const [equationPageDraft, setEquationPageDraft] = useState('');
  const [equationVarsDraft, setEquationVarsDraft] = useState('');
  const [equationBusy, setEquationBusy] = useState(false);
  const [equationErr, setEquationErr] = useState<string | null>(null);
  const [eqOptions, setEqOptions] = useState<{ latex: string; page: number; variables: string[] }[]>([]);
  const [eqPickerOpen, setEqPickerOpen] = useState(false);
  const [editingEquationId, setEditingEquationId] = useState<number | null>(null);
  const [editEqLatex, setEditEqLatex] = useState('');
  const [editEqPage, setEditEqPage] = useState('');
  const [editEqVars, setEditEqVars] = useState('');

  // When the add-equation form opens, offer the source's detected equation
  // candidates to pick from (prefills latex/page/vars), instead of typing raw.
  useEffect(() => {
    if (!addingEquation || concept.source_id == null) { return; }
    let alive = true;
    window.api.candidates.bySource(concept.source_id).then(b => {
      if (!alive) return;
      const eqs = ((b as { equations?: Array<{ latex?: string; page?: number; variables?: unknown }> }).equations) ?? [];
      const seen = new Set<string>();
      const opts: { latex: string; page: number; variables: string[] }[] = [];
      for (const e of eqs) {
        const latex = (e.latex ?? '').trim();
        if (!latex || seen.has(latex)) continue;
        seen.add(latex);
        opts.push({
          latex,
          page: Number(e.page ?? 0),
          variables: Array.isArray(e.variables) ? (e.variables as string[]) : [],
        });
      }
      setEqOptions(opts);
    }).catch(() => { /* candidates may be wiped; the free-text path still works */ });
    return () => { alive = false; };
  }, [addingEquation, concept.source_id]);

  function startEditEquation(eq: Equation): void {
    setEquationErr(null);
    setEditingEquationId(eq.id);
    setEditEqLatex(eq.latex);
    setEditEqPage(String(eq.page));
    setEditEqVars(eq.variables.join(', '));
  }

  function cancelEditEquation(): void {
    setEditingEquationId(null);
  }

  async function saveEditEquation(eq: Equation): Promise<void> {
    const latex = editEqLatex.trim();
    if (!latex) { setEquationErr('Equation cannot be empty.'); return; }
    setEquationBusy(true);
    setEquationErr(null);
    try {
      const page = editEqPage.trim() ? Number(editEqPage) : undefined;
      if (page !== undefined && (!Number.isFinite(page) || page < 0)) {
        throw new Error('Page must be a positive number.');
      }
      const variables = editEqVars.split(',').map(v => v.trim()).filter(Boolean);
      const updated = await window.api.concepts.equationUpdate({
        equationId: eq.id,
        latex,
        page,
        variables: variables.length ? variables : undefined,
      }) as Equation;
      onEquationsChange(
        equations.map(item => (item.id === eq.id ? updated : item)).sort((a, b) => a.page - b.page || a.id - b.id),
      );
      window.dispatchEvent(new CustomEvent('starcall:equations-changed', { detail: { conceptId: concept.id } }));
      setEditingEquationId(null);
    } catch (e) {
      setEquationErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEquationBusy(false);
    }
  }
  const [pendingEquationDeletes, setPendingEquationDeletes] = useState<Equation[]>([]);
  const equationsRef = useRef(equations);
  const conceptIdRef = useRef(concept.id);
  const pendingEquationDeleteTimers = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    equationsRef.current = equations;
  }, [equations]);

  useEffect(() => {
    conceptIdRef.current = concept.id;
  }, [concept.id]);

  // Re-sync local state when the parent switches to a different concept.
  useEffect(() => {
    setLocal({
      definition_text: concept.definition_text || '',
      why_exists:      concept.why_exists      || '',
      what_breaks:     concept.what_breaks     || '',
    });
    setConstellations(normalizeReappears(concept.where_reappears));
    setEnrichErr(null);
    setCopiedPrompt(false);
    setAddingEquation(false);
    setEquationDraft('');
    setEquationPageDraft('');
    setEquationVarsDraft('');
    setEquationErr(null);
    setPendingEquationDeletes([]);
  }, [concept.id]);

  async function enrich() {
    setEnriching(true);
    setEnrichErr(null);
    try {
      const updated = await window.api.concepts.enrich(concept.id);
      setLocal({
        definition_text: updated.definition_text || '',
        why_exists:      updated.why_exists      || '',
        what_breaks:     updated.what_breaks     || '',
      });
      // Mutate the parent's `concept` reference so other panels see the new values.
      concept.definition_text = updated.definition_text;
      concept.why_exists      = updated.why_exists;
      concept.what_breaks     = updated.what_breaks;
      // Constellations are user-curated only — never overwrite from enrich.
    } catch (e) {
      setEnrichErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEnriching(false);
    }
  }

  async function addEquation(): Promise<void> {
    const latex = equationDraft.trim();
    if (!latex) {
      setEquationErr('Equation cannot be empty.');
      return;
    }
    setEquationBusy(true);
    setEquationErr(null);
    try {
      const variables = equationVarsDraft
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
      const page = equationPageDraft.trim() ? Number(equationPageDraft) : undefined;
      if (page !== undefined && (!Number.isFinite(page) || page < 0)) {
        throw new Error('Page must be a positive number.');
      }
      const created = await window.api.concepts.equationCreate({
        conceptId: concept.id,
        latex,
        page,
        variables: variables.length ? variables : undefined,
      }) as Equation;
      onEquationsChange([...equations, created].sort((a, b) => a.page - b.page || a.id - b.id));
      window.dispatchEvent(new CustomEvent('starcall:equations-changed', { detail: { conceptId: concept.id } }));
      setEquationDraft('');
      setEquationPageDraft('');
      setEquationVarsDraft('');
      setAddingEquation(false);
    } catch (e) {
      setEquationErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEquationBusy(false);
    }
  }

  function deleteEquation(eq: Equation): void {
    setEquationErr(null);
    if (pendingEquationDeleteTimers.current.has(eq.id)) return;
    onEquationsChange(equationsRef.current.filter(item => item.id !== eq.id));
    setPendingEquationDeletes(prev => [...prev.filter(item => item.id !== eq.id), eq]);
    const timerId = window.setTimeout(() => {
      pendingEquationDeleteTimers.current.delete(eq.id);
      setPendingEquationDeletes(prev => prev.filter(item => item.id !== eq.id));
      void window.api.concepts.equationDelete(eq.id).then(() => {
        window.dispatchEvent(new CustomEvent('starcall:equations-changed', { detail: { conceptId: concept.id } }));
      }).catch(e => {
        setEquationErr(e instanceof Error ? e.message : String(e));
        if (conceptIdRef.current === concept.id && !equationsRef.current.some(item => item.id === eq.id)) {
          onEquationsChange([...equationsRef.current, eq].sort((a, b) => a.page - b.page || a.id - b.id));
        }
      });
    }, 5_000);
    pendingEquationDeleteTimers.current.set(eq.id, timerId);
  }

  function undoDeleteEquation(eq: Equation): void {
    const timerId = pendingEquationDeleteTimers.current.get(eq.id);
    if (timerId != null) {
      window.clearTimeout(timerId);
      pendingEquationDeleteTimers.current.delete(eq.id);
    }
    setPendingEquationDeletes(prev => prev.filter(item => item.id !== eq.id));
    if (!equationsRef.current.some(item => item.id === eq.id)) {
      onEquationsChange([...equationsRef.current, eq].sort((a, b) => a.page - b.page || a.id - b.id));
    }
  }

  async function saveField(field: 'definition_text' | 'why_exists' | 'what_breaks', value: string) {
    setSavingField(field);
    try {
      await window.api.concepts.updateFields({ conceptId: concept.id, [field]: value });
      (concept as unknown as Record<string, string>)[field] = value;
    } finally {
      setSavingField(null);
    }
  }

  // Contract: contracts/concept_enrichment.md (CONTRACT_VERSION). Fills
  // definition_text/why_exists/what_breaks from source evidence; never writes
  // constellations; never overwrites user-authored content.
  function chatGptPrompt(): string {
    const lines: string[] = [];
    lines.push(`Explain the concept "${concept.name}" for someone studying it from the source below.`);
    lines.push('');
    lines.push('CRITICAL: many concept names are ambiguous across domains. Always pick the meaning the SOURCE points to:');
    lines.push('  • "RAG" in an AI book → Retrieval-Augmented Generation, NOT Red/Amber/Green status.');
    lines.push('  • "Mole" in a chemistry book → unit of substance, NOT animal or skin lesion.');
    lines.push('  • "Class" in a biology book → taxonomic rank, NOT object-oriented programming.');
    lines.push('Match THIS source\'s domain in every field.');
    lines.push('');
    if (concept.section_path && concept.section_path.length > 0) {
      lines.push(`Section context: ${concept.section_path.join(' › ')}`);
      lines.push('');
    }
    if (local.definition_text && local.definition_text !== concept.name) {
      lines.push(`Partial existing definition (verbatim from source): "${local.definition_text}"`);
      lines.push('');
    }
    lines.push('EXAMPLE (format reference — your output must reflect the ACTUAL domain of the supplied concept and source; this example happens to be from machine learning):');
    lines.push('Concept: "Backpropagation"');
    lines.push('Section context: Chapter 6 › 6.5 Back-Propagation and Other Differentiation Algorithms');
    lines.push('Output:');
    lines.push('{');
    lines.push('  "definition_text": "Backpropagation is the algorithm for computing the gradient of a scalar loss with respect to each weight in a neural network by applying the chain rule backward through the computation graph, reusing intermediate activations stored during the forward pass.",');
    lines.push('  "why_exists": "It lets gradient-based optimizers train deep networks in time proportional to the forward pass, rather than the exponential cost of naive per-weight derivatives.",');
    lines.push('  "what_breaks": "Without it, training reduces to expensive numerical differentiation; with stale or missing forward activations, gradients become wrong and learning silently diverges."');
    lines.push('}');
    lines.push('');
    lines.push('Now produce the JSON for the concept above, in this exact shape:');
    lines.push('{');
    lines.push('  "definition_text": "1–3 sentences. Precise meaning AS USED IN THIS SOURCE.",');
    lines.push('  "why_exists": "1–2 sentences. The problem this concept solves in its domain.",');
    lines.push('  "what_breaks": "1–2 sentences. What goes wrong when missing or misapplied."');
    lines.push('}');
    lines.push('');
    lines.push('Be concrete and precise. No marketing language. No hedging.');
    return lines.join('\n');
  }

  async function copyPrompt() {
    await navigator.clipboard.writeText(chatGptPrompt());
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  }

  // Tries hard to extract a JSON object from raw LLM output:
  //   - strips ```json … ``` fences
  //   - tolerates leading/trailing prose
  //   - validates the shape we asked for in chatGptPrompt()
  function parseChatGptJson(raw: string): { definition_text?: string; why_exists?: string; what_breaks?: string; where_reappears?: string[] } | null {
    if (!raw.trim()) return null;
    let body = raw.trim();
    // Strip ```json … ``` or ``` … ``` fences
    const fenced = body.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) body = fenced[1].trim();
    // Fall back to first { … last } slice if there's still surrounding prose
    if (!body.startsWith('{')) {
      const start = body.indexOf('{');
      const end   = body.lastIndexOf('}');
      if (start >= 0 && end > start) body = body.slice(start, end + 1);
    }
    try {
      const obj = JSON.parse(body) as Record<string, unknown>;
      const pick = (k: string): string | undefined => typeof obj[k] === 'string' ? (obj[k] as string).trim() : undefined;
      const reapp = Array.isArray(obj.where_reappears)
        ? (obj.where_reappears as unknown[]).map(s => String(s).trim()).filter(Boolean).slice(0, 5)
        : undefined;
      return {
        definition_text: pick('definition_text'),
        why_exists:      pick('why_exists'),
        what_breaks:     pick('what_breaks'),
        where_reappears: reapp,
      };
    } catch {
      return null;
    }
  }

  async function applyPaste(raw: string): Promise<void> {
    setPasteErr(null);
    const parsed = parseChatGptJson(raw);
    if (!parsed) {
      setPasteErr('Could not find valid JSON in the pasted text. Expected something like {"definition_text":"...", "why_exists":"...", "what_breaks":"...", "where_reappears":[...]}.');
      return;
    }
    // Constellations are user-curated only — paste flow ignores any
    // `where_reappears` field the LLM/ChatGPT may have included.
    const patch = {
      conceptId: concept.id,
      ...(parsed.definition_text !== undefined ? { definition_text: parsed.definition_text } : {}),
      ...(parsed.why_exists      !== undefined ? { why_exists:      parsed.why_exists      } : {}),
      ...(parsed.what_breaks     !== undefined ? { what_breaks:     parsed.what_breaks     } : {}),
    };
    await window.api.concepts.updateFields(patch);
    // Update local + parent state so UI reflects new values immediately
    setLocal(s => ({
      definition_text: parsed.definition_text ?? s.definition_text,
      why_exists:      parsed.why_exists      ?? s.why_exists,
      what_breaks:     parsed.what_breaks     ?? s.what_breaks,
    }));
    if (parsed.definition_text !== undefined) concept.definition_text = parsed.definition_text;
    if (parsed.why_exists      !== undefined) concept.why_exists      = parsed.why_exists;
    if (parsed.what_breaks     !== undefined) concept.what_breaks     = parsed.what_breaks;
    setPasteText('');
    setPasteOpen(false);
    setPasteApplied(true);
    setTimeout(() => setPasteApplied(false), 2500);
  }

  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 24 }}>
      {enrichErr && (
        <div style={{ background: '#1a0a0a', border: '1px solid #3f1515', borderRadius: 6, padding: '8px 12px', color: '#fca5a5', fontSize: 12 }}>
          {enrichErr}
        </div>
      )}

      <EditableSection
        title="Definition"
        value={local.definition_text}
        saving={savingField === 'definition_text'}
        onChange={v => setLocal(s => ({ ...s, definition_text: v }))}
        onSave={() => saveField('definition_text', local.definition_text)}
        placeholder="What this concept means, in 1–3 sentences."
      />
      <EditableSection
        title="Why It Exists"
        value={local.why_exists}
        saving={savingField === 'why_exists'}
        onChange={v => setLocal(s => ({ ...s, why_exists: v }))}
        onSave={() => saveField('why_exists', local.why_exists)}
        placeholder="The problem this concept solves."
      />
      <EditableSection
        title="What Breaks Without It"
        value={local.what_breaks}
        saving={savingField === 'what_breaks'}
        onChange={v => setLocal(s => ({ ...s, what_breaks: v }))}
        onSave={() => saveField('what_breaks', local.what_breaks)}
        placeholder="What goes wrong when missing or misapplied."
      />
      <Section title="Constellations">
        <WhereItReappearsEditor
          conceptId={concept.id}
          value={constellations}
          onChange={next => {
            setConstellations(next);
            // Keep the parent's concept reference in sync so other surfaces
            // see the new list immediately on the next render.
            concept.where_reappears = next as unknown as Concept['where_reappears'];
            void window.api.concepts.updateFields({
              conceptId: concept.id,
              where_reappears: next,
            }).then(() => {
              // The Map derives edges from constellations — tell it to refetch
              // so deleted links drop off without a reload.
              window.dispatchEvent(new Event('starcall:graphChanged'));
            });
          }}
        />
      </Section>
      <Section title={`Equations (${equations.length})`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => setAddingEquation(v => !v)}
              disabled={equationBusy}
              style={{
                background: addingEquation ? '#1e1b4b' : 'transparent',
                border: '1px dashed #374151',
                borderRadius: 4,
                padding: '5px 12px',
                color: addingEquation ? '#c7d2fe' : '#a5b4fc',
                fontSize: 11,
                fontWeight: 700,
                cursor: equationBusy ? 'wait' : 'pointer',
              }}
            >
              {addingEquation ? 'Cancel' : '+ Add equation'}
            </button>
            {equationErr && <span style={{ fontSize: 11, color: '#fca5a5' }}>{equationErr}</span>}
          </div>

          {pendingEquationDeletes.map(eq => (
            <div
              key={eq.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                background: 'rgba(17, 24, 39, 0.4)',
                border: '1px solid #312e81',
                borderRadius: 6,
                padding: '8px 10px',
                color: '#cbd5e1',
                fontSize: 12,
              }}
            >
              <span style={{ color: '#94a3b8' }}>Equation deleted.</span>
              <button
                onClick={() => undoDeleteEquation(eq)}
                style={{
                  marginLeft: 'auto',
                  background: '#1e1b4b',
                  border: '1px solid #6366f1',
                  borderRadius: 4,
                  color: '#c7d2fe',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '3px 9px',
                }}
              >
                Undo
              </button>
            </div>
          ))}

          {addingEquation && (() => {
            const attached = new Set(equations.map(e => e.latex.trim()));
            const available = eqOptions.filter(o => !attached.has(o.latex.trim()));
            return (
            <div style={{ background: 'rgba(13, 13, 22, 0.5)', border: '1px solid #312e81', borderRadius: 6, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {available.length > 0 && (
                <div style={{ position: 'relative' }}>
                  <button
                    type="button"
                    onClick={() => setEqPickerOpen(o => !o)}
                    onBlur={() => setTimeout(() => setEqPickerOpen(false), 150)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      background: 'transparent', border: '1px solid #263244', borderRadius: 4,
                      padding: '6px 9px', color: '#c7d2fe', fontSize: 11, cursor: 'pointer',
                    }}
                  >
                    <span>Pick from {available.length} detected equation{available.length === 1 ? '' : 's'}…</span>
                    <span style={{ color: '#6b7280' }}>▾</span>
                  </button>
                  {eqPickerOpen && (
                    <div role="listbox" style={{
                      position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2, zIndex: 20,
                      background: 'rgba(13,13,22,0.6)', backdropFilter: 'blur(12px)', border: '1px solid #312e81', borderRadius: 6,
                      maxHeight: 220, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                    }}>
                      {available.map((opt, i) => (
                        <button
                          key={i}
                          type="button"
                          className="rel-opt"
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => {
                            setEquationDraft(opt.latex);
                            if (opt.page) setEquationPageDraft(String(opt.page));
                            if (opt.variables.length) setEquationVarsDraft(opt.variables.join(', '));
                            setEqPickerOpen(false);
                          }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                            background: 'transparent', border: 'none', padding: '6px 9px', cursor: 'pointer',
                          }}
                        >
                          <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#fde68a', fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.latex}</span>
                          {opt.page > 0 && <span style={{ fontSize: 9, color: '#64748b', flexShrink: 0 }}>p.{opt.page}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <textarea
                value={equationDraft}
                onChange={e => setEquationDraft(e.target.value)}
                placeholder="Type equation or LaTeX-ish formula..."
                rows={3}
                style={{
                  width: '100%', boxSizing: 'border-box', resize: 'vertical',
                  background: 'rgba(17, 24, 39, 0.4)', border: '1px solid #1f2937', borderRadius: 4,
                  padding: '8px 10px', color: '#fde68a', fontSize: 13,
                  lineHeight: 1.55, fontFamily: 'inherit', outline: 'none',
                }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  value={equationPageDraft}
                  onChange={e => setEquationPageDraft(e.target.value)}
                  placeholder="page"
                  inputMode="numeric"
                  style={{
                    width: 80, background: 'rgba(17, 24, 39, 0.4)', border: '1px solid #1f2937',
                    borderRadius: 4, padding: '6px 8px', color: '#cbd5e1', fontSize: 12,
                  }}
                />
                <input
                  value={equationVarsDraft}
                  onChange={e => setEquationVarsDraft(e.target.value)}
                  placeholder="vars, comma separated (optional)"
                  style={{
                    flex: '1 1 220px', background: 'rgba(17, 24, 39, 0.4)', border: '1px solid #1f2937',
                    borderRadius: 4, padding: '6px 8px', color: '#cbd5e1', fontSize: 12,
                  }}
                />
                <button onClick={() => void addEquation()} disabled={equationBusy} style={btnSecondary(equationBusy)}>
                  {equationBusy ? 'Saving...' : 'Save equation'}
                </button>
              </div>
            </div>
            );
          })()}

          {equations.length === 0 && !addingEquation && (
            <div style={{ color: '#4b5563', fontSize: 12 }}>No equations attached yet.</div>
          )}

          {equations.length > 0 && equations.map(eq => (
              editingEquationId === eq.id ? (
                <div key={eq.id} style={{ background: '#0d0d16', border: '1px solid #312e81', borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input
                    value={editEqLatex}
                    onChange={e => setEditEqLatex(e.target.value)}
                    placeholder="LaTeX, e.g. 100 * 500M => 50B"
                    autoFocus
                    style={eqEditInput}
                  />
                  <LatexMath value={editEqLatex || '\\;'} size={14} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input value={editEqPage} onChange={e => setEditEqPage(e.target.value)} placeholder="page" style={{ ...eqEditInput, width: 70 }} />
                    <input value={editEqVars} onChange={e => setEditEqVars(e.target.value)} placeholder="vars (comma-separated)" style={{ ...eqEditInput, flex: 1 }} />
                  </div>
                  {equationErr && <div style={{ fontSize: 11, color: '#fca5a5' }}>{equationErr}</div>}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => void saveEditEquation(eq)} disabled={equationBusy} style={btnSecondary(equationBusy)}>
                      {equationBusy ? 'Saving…' : 'Save'}
                    </button>
                    <button onClick={cancelEditEquation} disabled={equationBusy} title="Cancel" aria-label="Cancel" style={{ ...btnTiny(equationBusy), width: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, lineHeight: 1 }}>×</button>
                  </div>
                </div>
              ) : (
              <div key={eq.id} style={{ position: 'relative', background: '#0d0d16', border: '1px solid #1f2937', borderRadius: 6, padding: '10px 70px 10px 12px' }}>
                <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => startEditEquation(eq)}
                    disabled={equationBusy}
                    title="Edit equation"
                    style={{
                      width: 36, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      background: 'transparent', border: '1px solid #1f2937', borderRadius: 4,
                      color: '#9ca3af', padding: 0, cursor: equationBusy ? 'wait' : 'pointer', fontSize: 11,
                    }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => void deleteEquation(eq)}
                    disabled={equationBusy}
                    title="Delete equation"
                    style={{
                      width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      background: 'transparent', border: '1px solid #3f1515', borderRadius: 4,
                      color: '#fca5a5', padding: 0, cursor: equationBusy ? 'wait' : 'pointer',
                      fontSize: 13, lineHeight: 1, opacity: equationBusy ? 0.5 : 1,
                    }}
                  >
                    ×
                  </button>
                </div>
                <div
                  onClick={() => startEditEquation(eq)}
                  title="Click to edit"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: eq.variables.length ? 6 : 0, flexWrap: 'wrap', cursor: 'pointer' }}
                >
                  <span style={{ fontSize: 10, color: '#4b5563' }}>p.{eq.page}</span>
                  <LatexMath value={eq.latex} size={14} />
                </div>
                {eq.variables.length > 0 && (
                  <div style={{ fontSize: 10, color: '#6b7280' }}>
                    vars: {eq.variables.slice(0, 8).join(', ')}
                  </div>
                )}
              </div>
              )
            ))}
        </div>
      </Section>
      {misconceptions.length > 0 && (
        <Section title={`Common Misconceptions (${misconceptions.length})`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {misconceptions.map(m => (
              <div key={m.id} style={{ background: '#1a0a0a', border: '1px solid #3f1515', borderRadius: 6, padding: '12px 14px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#fca5a5', marginBottom: 6 }}>{m.description}</div>
                <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 3 }}>
                  <span style={{ color: '#6b7280' }}>Why believed: </span>{m.why_think_it}
                </div>
                <div style={{ fontSize: 12, color: '#9ca3af' }}>
                  <span style={{ color: '#6b7280' }}>Why wrong: </span>{m.why_wrong}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Notes moved to the Annotations tab — paired with highlights. */}

      {/* ChatGPT prompt generator — paste to external LLM if you don't want to spend on enrich */}
      <div style={{
        marginTop: 12, padding: '14px 16px',
        background: 'rgba(4, 6, 26, 0.26)',
        border: '1px dashed rgba(99, 102, 241, 0.36)',
        borderRadius: 6,
        backdropFilter: 'blur(10px)',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, fontSize: 12, color: '#9ca3af', lineHeight: 1.5 }}>
            <div style={{ fontWeight: 600, color: '#c7d2fe', marginBottom: 2 }}>Ask ChatGPT (free)</div>
            Copy a structured prompt, paste it into ChatGPT, paste the JSON answer back here, auto-fills the fields.
          </div>
          <button onClick={copyPrompt} style={btnSecondary(false)}>
            {copiedPrompt ? '✓ Copied' : '1. Copy Prompt'}
          </button>
          <button onClick={() => setPasteOpen(o => !o)} style={btnSecondary(false)}>
            {pasteOpen ? 'Close paste' : '2. Paste Answer'}
          </button>
          <button onClick={enrich} disabled={enriching} title="One LLM call via your configured provider/model. Fills the three fields above." style={btnSecondary(enriching)}>
            {enriching ? 'Enriching…' : 'Fill w/ LLM'}
          </button>
        </div>
        {pasteApplied && (
          <div style={{ fontSize: 11, color: '#86efac' }}>✓ Applied. Fields updated and saved.</div>
        )}
        {pasteOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <textarea
              autoFocus
              value={pasteText}
              onChange={e => {
                const v = e.target.value;
                setPasteText(v);
                setPasteErr(null);
                // Auto-apply as soon as we see a parseable object — saves a click
                const parsed = parseChatGptJson(v);
                if (parsed && (parsed.definition_text || parsed.why_exists || parsed.what_breaks)) {
                  void applyPaste(v);
                }
              }}
              onPaste={e => {
                // Some browsers' clipboard text fires after onChange; this is belt-and-suspender
                const text = e.clipboardData.getData('text');
                if (text) {
                  setPasteText(text);
                  setPasteErr(null);
                  const parsed = parseChatGptJson(text);
                  if (parsed && (parsed.definition_text || parsed.why_exists || parsed.what_breaks)) {
                    void applyPaste(text);
                  }
                  e.preventDefault();
                }
              }}
              placeholder='Paste ChatGPT&apos;s full reply here. Code fences and surrounding prose are OK — the parser will find the JSON object.'
              rows={6}
              style={{
                width: '100%', boxSizing: 'border-box', resize: 'vertical',
                background: '#000', border: `1px solid ${pasteErr ? '#7f1d1d' : '#312e81'}`, borderRadius: 4,
                padding: '8px 10px', color: '#e2e8f0', fontSize: 11, lineHeight: 1.5,
                fontFamily: 'ui-monospace, Consolas, monospace', outline: 'none',
              }}
            />
            {pasteErr && (
              <div style={{ fontSize: 11, color: '#fca5a5' }}>{pasteErr}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EditableSection({ title, value, saving, onChange, onSave, placeholder }: {
  title: string;
  value: string;
  saving: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
  placeholder: string;
}) {
  const [dirty, setDirty] = useState(false);
  // Reset dirty when value resets externally (concept switch)
  useEffect(() => { setDirty(false); }, [value === '' && saving === false ? title : '__']);

  function handleChange(v: string): void {
    onChange(v);
    setDirty(true);
  }
  function handleSave(): void {
    onSave();
    setDirty(false);
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{title}</div>
        {dirty && (
          <button onClick={handleSave} disabled={saving} style={btnTiny(saving)}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
      <RichTextArea
        value={value}
        placeholder={placeholder}
        onChange={handleChange}
        rows={Math.max(2, Math.min(8, Math.ceil((value.length || placeholder.length) / 70)))}
        textStyle={{
          width: '100%', boxSizing: 'border-box', resize: 'vertical',
          background: 'rgba(13,13,22,0.35)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
          border: `1px solid ${dirty ? '#818cf8' : '#1f2937'}`,
          borderRadius: 4, padding: '8px 10px',
          color: value ? '#c4cfe4' : '#6b7280',
          fontSize: value ? 14 : 12, lineHeight: 1.65,
          fontFamily: 'inherit', outline: 'none',
        }}
      />
    </div>
  );
}

const eqEditInput: React.CSSProperties = {
  background: 'rgba(13,13,22,0.6)', border: '1px solid #312e81', borderRadius: 4,
  padding: '6px 10px', color: '#e2e8f0', fontSize: 12, outline: 'none',
  fontFamily: 'inherit', boxSizing: 'border-box',
};
function btnSecondary(busy: boolean): React.CSSProperties {
  return {
    background: 'transparent', border: '1px solid #4338ca', borderRadius: 4,
    padding: '5px 12px', fontSize: 11, fontWeight: 600,
    color: busy ? '#6b7280' : '#a5b4fc', cursor: busy ? 'wait' : 'pointer',
  };
}
function btnTiny(busy: boolean): React.CSSProperties {
  return {
    background: '#1e1b4b', border: '1px solid #4338ca', borderRadius: 3,
    padding: '1px 8px', fontSize: 10, fontWeight: 600,
    color: busy ? '#6b7280' : '#c7d2fe', cursor: busy ? 'wait' : 'pointer',
  };
}

function HistoryTab({ records, onDelete }: { records: HistoryRecord[]; onDelete: (id: number) => void }) {
  if (records.length === 0) {
    return <div style={{ color: '#374151', fontSize: 13 }}>No challenge attempts yet. Head to Challenge Me to start.</div>;
  }
  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {records.map(r => {
        const scoreColor = SCORE_COLOR[r.score] ?? '#6b7280';
        const date = new Date(r.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const difficulty = r.task_difficulty_snapshot ?? 3;
        const xp = r.xp_awarded ?? 0;
        const questionType = (r.task_kind_snapshot ?? 'challenge').replace(/_/g, ' ');
        return (
          <div key={r.id} style={{ background: 'rgba(17, 24, 39, 0.4)', border: '1px solid #1f2937', borderRadius: 8, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span
                style={{
                  width: 8, height: 8, borderRadius: 8, background: scoreColor, flex: '0 0 8px',
                }}
              />
              <span style={{ fontSize: 12, color: scoreColor, fontWeight: 700, textTransform: 'lowercase' }}>
                {SCORE_LABEL[r.score] ?? r.score}
              </span>
              <span style={{ fontSize: 11, color: '#6b7280' }}>·</span>
              <span style={{ fontSize: 11, color: '#6b7280' }}>{date}</span>
              <span style={{
                fontSize: 10, color: '#a5b4fc', background: '#1e1b4b',
                border: '1px solid #312e81', borderRadius: 10, padding: '2px 7px',
              }}>
                {questionType} · diff {difficulty}/5
              </span>
              <span style={{
                fontSize: 10, color: xp > 0 ? '#facc15' : '#64748b', background: xp > 0 ? '#2d1f00' : '#0b1220',
                border: `1px solid ${xp > 0 ? '#713f12' : '#1f2937'}`, borderRadius: 10, padding: '2px 7px',
                fontWeight: 700,
              }}>
                +{xp} XP
              </span>
              <button
                onClick={() => onDelete(r.id)}
                title="Delete this history entry"
                style={{
                  marginLeft: 'auto',
                  background: 'transparent', border: '1px solid #3f1515', borderRadius: 4,
                  padding: '2px 8px', fontSize: 14, color: '#fca5a5', cursor: 'pointer', lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
            {r.task_prompt_snapshot && (
              <div style={{ marginBottom: 8 }}>
                {r.task_kind_snapshot && (
                  <div style={{ fontSize: 9, color: '#4b5563', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>
                    {questionType} · difficulty {difficulty}/5
                  </div>
                )}
                <p style={{ margin: 0, fontSize: 12, color: '#cbd5e1', lineHeight: 1.55 }}>{r.task_prompt_snapshot}</p>
              </div>
            )}
            {r.user_response && (
              <div style={{ marginBottom: 8, background: '#0b1220', border: '1px solid #1f2937', borderRadius: 4, padding: '8px 10px' }}>
                <div style={{ fontSize: 9, color: '#4b5563', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Your Answer</div>
                <p style={{ margin: 0, fontSize: 12, color: '#9ca3af', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{r.user_response}</p>
              </div>
            )}
            <p style={{ margin: 0, fontSize: 12, color: '#9ca3af', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {r.grader_reasoning}
            </p>
            {r.gaps_detected.length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {r.gaps_detected.slice(0, 3).map((g, i) => (
                  <span key={i} style={{ fontSize: 10, background: '#2d1f00', color: '#f59e0b', padding: '1px 6px', borderRadius: 3 }}>{g}</span>
                ))}
                {r.gaps_detected.length > 3 && <span style={{ fontSize: 10, color: '#4b5563' }}>+{r.gaps_detected.length - 3} more</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ChallengeTab({ tasks, selectedTask, onSelectTask, response, onResponseChange, grading, grade, generatingTasks, taskGenError, onGenerateTasks, onRegenerateTasks, onSubmit, onReset }: {
  tasks: Task[]; selectedTask: Task | null; onSelectTask: (t: Task) => void;
  response: string; onResponseChange: (v: string) => void;
  grading: boolean; grade: Grade | null;
  generatingTasks: boolean; taskGenError: string | null;
  onGenerateTasks: () => void;
  onRegenerateTasks: () => void;
  onSubmit: () => void; onReset: () => void;
}) {
  if (tasks.length === 0) {
    return (
      <div style={{ maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ color: '#9ca3af', fontSize: 13, lineHeight: 1.6 }}>
          No evidence tasks for this concept yet. Generating them is one call to your configured LLM provider and only happens once per concept.
        </div>
        <button
          onClick={onGenerateTasks}
          disabled={generatingTasks}
          style={{
            background: generatingTasks ? '#1e1e2e' : '#4f46e5', border: 'none', borderRadius: 6,
            padding: '10px 20px', color: generatingTasks ? '#6b7280' : '#fff',
            fontSize: 13, fontWeight: 600, cursor: generatingTasks ? 'wait' : 'pointer',
            alignSelf: 'flex-start',
          }}
        >
          {generatingTasks ? 'Generating tasks…' : 'Generate Tasks'}
        </button>
        {taskGenError && (
          <div style={{ color: '#fca5a5', fontSize: 12, lineHeight: 1.5 }}>
            {taskGenError}
          </div>
        )}
      </div>
    );
  }
  if (grade) return <GradeCard grade={grade} task={selectedTask} userResponse={response} onReset={onReset} />;

  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {(() => {
          const KIND_ORDER = ['definition', 'connection', 'application', 'compression', 'misconception_resistance'];
          const ordered = [...tasks].sort((a, b) => {
            const ai = KIND_ORDER.indexOf(a.kind);
            const bi = KIND_ORDER.indexOf(b.kind);
            return (ai === -1 ? KIND_ORDER.length : ai) - (bi === -1 ? KIND_ORDER.length : bi);
          });
          return ordered.map(t => (
            <button key={t.id} onClick={() => onSelectTask(t)} style={{
              background: selectedTask?.id === t.id ? '#312e81' : '#111827',
              border: `1px solid ${selectedTask?.id === t.id ? '#6366f1' : '#1f2937'}`,
              borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
              color: selectedTask?.id === t.id ? '#a5b4fc' : '#6b7280',
            }}>
              {t.kind.replace(/_/g, ' ')}
            </button>
          ));
        })()}
        <button
          onClick={onRegenerateTasks}
          disabled={generatingTasks}
          title={generatingTasks ? 'Regenerating…' : 'Regenerate all 5 challenge tasks'}
          aria-label="Regenerate challenge tasks"
          style={{
            marginLeft: 'auto',
            width: 28, height: 28, flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent',
            border: '1px solid #1f2937',
            borderRadius: 6,
            color: generatingTasks ? '#4b5563' : '#9ca3af',
            cursor: generatingTasks ? 'wait' : 'pointer',
          }}
        >
          <svg className={generatingTasks ? 'spin' : undefined} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        </button>
      </div>
      {taskGenError && (
        <div style={{ color: '#fca5a5', fontSize: 12, lineHeight: 1.5 }}>{taskGenError}</div>
      )}
      {selectedTask && (
        <div style={{ background: 'rgba(17, 24, 39, 0.4)', border: '1px solid #1f2937', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 10, color: '#4b5563', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
            {selectedTask.kind.replace(/_/g, ' ')} · difficulty {selectedTask.difficulty}/5
          </div>
          <p style={{ margin: 0, fontSize: 14, color: '#e2e8f0', lineHeight: 1.65 }}>{selectedTask.prompt}</p>
        </div>
      )}
      <textarea
        value={response}
        onChange={e => onResponseChange(e.target.value)}
        placeholder="Write your response here…"
        rows={7}
        style={{
          background: 'rgba(17, 24, 39, 0.4)', border: '1px solid #1f2937', borderRadius: 6, padding: 12,
          color: '#e2e8f0', fontSize: 13, lineHeight: 1.65, resize: 'vertical', outline: 'none',
          fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
        }}
      />
      <button onClick={onSubmit} disabled={grading || !response.trim()} style={{
        background: grading ? '#1e1e2e' : '#4f46e5', border: 'none', borderRadius: 6,
        padding: '10px 24px', color: grading ? '#6b7280' : '#fff', fontSize: 13,
        fontWeight: 600, cursor: grading ? 'default' : 'pointer', alignSelf: 'flex-start',
      }}>
        {grading ? 'Grading…' : 'Submit Response'}
      </button>
    </div>
  );
}

// Stage-first header. Score becomes a small colored chip beside the stage
// label, with a 5-step progress bar underneath. Compression stage is the
// learning signal; raw grader bucket is supporting context.
function StageHeader({ stage, score }: { stage: number; score: EvidenceScore }) {
  const stageColor = STAGE_COLORS[stage];
  const scoreColor = SCORE_COLOR[score] ?? '#6b7280';
  const MAX_STAGE = STAGES.length - 1; // 0..5 → /5
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>Stage {stage}/{MAX_STAGE}</span>
        <span style={{ fontSize: 17, fontWeight: 700, color: stageColor }}>{STAGES[stage]}</span>
        <span
          title={`Grader: ${SCORE_LABEL[score] ?? score}`}
          style={{
            marginLeft: 'auto',
            fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
            color: scoreColor, background: scoreColor + '22',
            border: `1px solid ${scoreColor}55`,
            padding: '2px 8px', borderRadius: 10,
          }}
        >
          {SCORE_LABEL[score] ?? score}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {Array.from({ length: MAX_STAGE }, (_, i) => i + 1).map(i => (
          <div
            key={i}
            style={{
              flex: 1, height: 4, borderRadius: 2,
              background: i <= stage ? stageColor : '#1f2937',
            }}
          />
        ))}
      </div>
    </div>
  );
}

function GradeCard({ grade, task, userResponse, onReset }: { grade: Grade; task: Task | null; userResponse: string; onReset: () => void }) {
  const stage = grade.compression_stage;
  const xp = grade.xp_awarded ?? 0;
  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <StageHeader stage={stage} score={grade.score} />
      <div style={{
        alignSelf: 'flex-start',
        background: '#2d1f00',
        border: '1px solid #713f12',
        borderRadius: 8,
        padding: '8px 12px',
        color: '#facc15',
        fontSize: 13,
        fontWeight: 800,
      }}>
        +{xp} XP
      </div>
      {task && (
        <div style={{ background: 'rgba(17, 24, 39, 0.4)', border: '1px solid #1f2937', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 10, color: '#4b5563', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
            {task.kind.replace(/_/g, ' ')} · difficulty {task.difficulty}/5
          </div>
          <p style={{ margin: 0, fontSize: 14, color: '#e2e8f0', lineHeight: 1.65 }}>{task.prompt}</p>
        </div>
      )}
      {userResponse.trim().length > 0 && (
        <div style={{ background: '#0b1220', border: '1px solid #1f2937', borderRadius: 8, padding: '12px 14px' }}>
          <div style={{ fontSize: 10, color: '#4b5563', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Your Answer</div>
          <p style={{ margin: 0, fontSize: 13, color: '#cbd5e1', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{userResponse}</p>
        </div>
      )}
      <div style={{ background: 'rgba(17, 24, 39, 0.4)', border: '1px solid #1f2937', borderRadius: 6, padding: '12px 14px' }}>
        <div style={{ fontSize: 10, color: '#4b5563', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Grader Feedback</div>
        <p style={{ margin: 0, fontSize: 13, color: '#9ca3af', lineHeight: 1.6 }}>{grade.grader_reasoning}</p>
      </div>
      {grade.gaps_detected.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600, marginBottom: 6 }}>Gaps Detected</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {grade.gaps_detected.map((g, i) => <li key={i} style={{ fontSize: 12, color: '#9ca3af', marginBottom: 3 }}>{g}</li>)}
          </ul>
        </div>
      )}
      {grade.misconceptions_detected.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: '#ef4444', fontWeight: 600, marginBottom: 6 }}>Misconceptions Flagged</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {grade.misconceptions_detected.map((m, i) => <li key={i} style={{ fontSize: 12, color: '#9ca3af', marginBottom: 3 }}>{m}</li>)}
          </ul>
        </div>
      )}
      <button onClick={onReset} style={{
        background: '#1e1e2e', border: '1px solid #374151', borderRadius: 6,
        padding: '8px 16px', color: '#818cf8', fontSize: 13, cursor: 'pointer', alignSelf: 'flex-start',
      }}>
        Try Another Challenge
      </button>
    </div>
  );
}

const IMPORTANCE_ORDER = ['foundational', 'core', 'supporting', 'peripheral', 'reference_only'];

// Auto-derived evidence-kind chip (HEADING/CHUNK/…). Read-only label, but
// dismissible via a hover-revealed × (a per-concept view preference).
function KindChip({ kind, onDismiss }: { kind: string; onDismiss: () => void }) {
  const color = EVIDENCE_KIND_COLOR[kind] ?? '#6b7280';
  return (
    <span className="tag-chip" style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 10, padding: '2px 7px', borderRadius: 3,
      border: `1px solid ${EVIDENCE_KIND_COLOR[kind] ?? '#374151'}`,
      color, textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0,
    }}>
      {kind.replace(/_/g, ' ')}
      <button
        className="tag-x"
        onClick={onDismiss}
        title={`Hide the ${kind} chip on this concept`}
        style={{ background: 'transparent', border: 'none', color, cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 }}
      >×</button>
    </span>
  );
}

// Tag colors are a global, name-keyed preference (the same tag looks the same
// on every concept). Purely cosmetic, so stored in localStorage.
const TAG_COLORS_KEY = 'starcall.tagColors';
const DEFAULT_TAG_COLOR = '#818cf8';
function loadTagColors(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(TAG_COLORS_KEY) || '{}') as Record<string, string>; }
  catch { return {}; }
}

// User-authored free-text tags. Renders as removable chips (hover → ×) plus a
// "+ tag" affordance. Persists via updateFields and keeps the shared concept
// ref in sync, mirroring ImportancePill.
function TagBar({ concept }: { concept: Concept }) {
  const [tags, setTags] = useState<string[]>(concept.tags ?? []);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [allTags, setAllTags] = useState<string[]>([]);
  const [tagColors, setTagColors] = useState<Record<string, string>>(loadTagColors);
  const [newColor, setNewColor] = useState(DEFAULT_TAG_COLOR);
  const colorOf = (t: string) => tagColors[t.toLowerCase()] ?? DEFAULT_TAG_COLOR;
  function rememberColor(name: string, color: string) {
    const next = { ...loadTagColors(), [name.toLowerCase()]: color };
    localStorage.setItem(TAG_COLORS_KEY, JSON.stringify(next));
    setTagColors(next);
  }
  useEffect(() => { setTags(concept.tags ?? []); }, [concept.id, concept.tags]);
  // Existing tags across all concepts, refreshed when the picker opens.
  useEffect(() => {
    if (!adding) return;
    let cancelled = false;
    window.api.concepts.allTags().then(t => { if (!cancelled) setAllTags(t); }).catch(() => {});
    setTagColors(loadTagColors());
    return () => { cancelled = true; };
  }, [adding]);

  function persist(next: string[]) {
    setTags(next);
    concept.tags = next; // keep the shared ref current until the next refetch
    void window.api.concepts.updateFields({ conceptId: concept.id, tags: next });
  }
  function addTag(t: string, color?: string) {
    const v = t.trim();
    if (!v) return;
    // Only set a color for a brand-new tag; existing tags keep their color.
    if (color && !(v.toLowerCase() in loadTagColors())) rememberColor(v, color);
    if (!tags.some(x => x.toLowerCase() === v.toLowerCase())) persist([...tags, v]);
    setDraft('');
    setNewColor(DEFAULT_TAG_COLOR);
    setAdding(false);
  }
  function removeTag(t: string) {
    persist(tags.filter(x => x !== t));
  }

  const applied = new Set(tags.map(t => t.toLowerCase()));
  const suggestions = allTags.filter(t =>
    !applied.has(t.toLowerCase()) && t.toLowerCase().includes(draft.trim().toLowerCase()),
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0, position: 'relative' }}>
      {tags.map(t => {
        const c = colorOf(t);
        return (
        <span key={t} className="tag-chip" style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontSize: 10, padding: '2px 6px', borderRadius: 3,
          border: `1px solid ${c}`, color: '#e2e8f0', background: `${c}33`,
          letterSpacing: '0.03em', flexShrink: 0,
        }}>
          {t}
          <button
            className="tag-x"
            onClick={() => removeTag(t)}
            title={`Remove tag "${t}"`}
            style={{ background: 'transparent', border: 'none', color: c, cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 }}
          >×</button>
        </span>
        );
      })}
      <button
        onClick={() => setAdding(v => !v)}
        title="Add a tag"
        style={{
          fontSize: 10, padding: '2px 6px', borderRadius: 3,
          border: '1px dashed #374151', background: 'transparent',
          color: '#a5b4fc', cursor: 'pointer', flexShrink: 0,
        }}
      >+ tag</button>
      {adding && (
        <div
          onMouseDown={e => e.preventDefault()}
          style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 40, marginTop: 4, minWidth: 180, maxWidth: 260,
            background: 'rgba(13,13,22,0.92)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid #312e81', borderRadius: 6, boxShadow: '0 16px 50px rgba(0,0,0,0.55)', padding: 4,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
            <input
              type="color"
              value={newColor}
              onChange={e => setNewColor(e.target.value)}
              title="Color for a new tag"
              style={{ width: 26, height: 26, padding: 0, border: '1px solid #263244', borderRadius: 4, background: 'transparent', cursor: 'pointer', flexShrink: 0 }}
            />
            <input
              autoFocus
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); addTag(draft, newColor); }
                else if (e.key === 'Escape') { e.preventDefault(); setAdding(false); setDraft(''); }
              }}
              placeholder="Pick or type a new tag…"
              style={{
                flex: 1, minWidth: 0, boxSizing: 'border-box', fontSize: 11, padding: '5px 7px', borderRadius: 4,
                background: 'rgba(17,24,39,0.5)', border: '1px solid #263244', color: '#e2e8f0', outline: 'none',
              }}
            />
          </div>
          <div style={{ maxHeight: 180, overflowY: 'auto' }}>
            {suggestions.map(t => (
              <button
                key={t}
                className="rel-opt"
                onClick={() => addTag(t)}
                style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderRadius: 4, cursor: 'pointer', padding: '5px 8px', color: '#c7d2fe', fontSize: 11 }}
              >
                <span style={{ width: 9, height: 9, borderRadius: 2, background: colorOf(t), flexShrink: 0 }} />
                {t}
              </button>
            ))}
            {draft.trim() && !allTags.some(t => t.toLowerCase() === draft.trim().toLowerCase()) && (
              <button
                className="rel-opt"
                onClick={() => addTag(draft, newColor)}
                style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderRadius: 4, cursor: 'pointer', padding: '5px 8px', color: '#a5b4fc', fontSize: 11 }}
              >
                <span style={{ width: 9, height: 9, borderRadius: 2, background: newColor, flexShrink: 0 }} />
                + create “{draft.trim()}”
              </button>
            )}
            {suggestions.length === 0 && !draft.trim() && (
              <div style={{ padding: '5px 8px', fontSize: 10, color: '#6b7280' }}>No other tags yet — type to create one.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Click-to-edit importance tag: click the pill → pick a new importance → saves.
function ImportancePill({ concept, compact = false }: { concept: Concept; compact?: boolean }) {
  const [value, setValue] = useState(concept.importance);
  const [open, setOpen] = useState(false);
  useEffect(() => { setValue(concept.importance); }, [concept.id, concept.importance]);
  async function pick(imp: string) {
    setValue(imp);
    setOpen(false);
    concept.importance = imp; // keep the shared ref in sync until the next refetch
    await window.api.concepts.updateFields({ conceptId: concept.id, importance: imp });
    window.dispatchEvent(new Event('starcall:review-queue-stale'));
  }
  const color = IMP_COLOR[value] ?? '#6b7280';
  return (
    <span style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        title="Change importance"
        style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: `${color}22`, color, border: '1px solid transparent', cursor: 'pointer', lineHeight: 1.4 }}
      >
        {value} <span style={{ opacity: 0.6, marginLeft: compact ? 1 : 2 }}>▾</span>
      </button>
      {open && (
        <div role="listbox" style={{ position: 'absolute', top: '100%', left: 0, marginTop: 2, zIndex: 30, background: 'rgba(13,13,22,0.6)', backdropFilter: 'blur(12px)', border: '1px solid #312e81', borderRadius: 6, minWidth: 150, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
          {IMPORTANCE_ORDER.map(imp => (
            <button
              key={imp}
              type="button"
              className="rel-opt"
              onMouseDown={e => e.preventDefault()}
              onClick={() => void pick(imp)}
              style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: '6px 10px', fontSize: 11, color: imp === value ? (IMP_COLOR[imp] ?? '#e2e8f0') : '#cbd5e1', cursor: 'pointer' }}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: IMP_COLOR[imp] ?? '#6b7280', flexShrink: 0 }} />
              {imp}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// Click-to-edit concept title. Click the heading to swap to an input,
// Enter or blur to save, Esc to cancel. Mutates the parent's concept ref
// so other surfaces (sidebar entries, source preview) see the new name
// without a full refetch — the next list refresh will re-sync everything.
function EditableTitle({ concept, compact = false }: { concept: Concept; compact?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(concept.name);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(concept.name);
    setEditing(false);
  }, [concept.id, concept.name]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  async function commit(): Promise<void> {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === concept.name) {
      setDraft(concept.name);
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const updated = await window.api.concepts.rename({ conceptId: concept.id, name: trimmed });
      if (updated) {
        concept.name = updated.name;
        setDraft(updated.name);
        window.dispatchEvent(new Event('starcall:review-queue-stale'));
      }
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  function cancel(): void {
    setDraft(concept.name);
    setEditing(false);
  }

  const heading: React.CSSProperties = {
    margin: 0, fontSize: 18, fontWeight: 700,
    ...(compact ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : {}),
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        disabled={saving}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); void commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        style={{
          ...heading,
          minWidth: 0, flex: '1 1 auto',
          background: '#111827', border: '1px solid #312e81', borderRadius: 4,
          color: '#e2e8f0', padding: '2px 8px', outline: 'none',
          fontFamily: 'inherit',
        }}
      />
    );
  }

  return (
    <h1
      onClick={() => setEditing(true)}
      title="Click to rename"
      style={{ ...heading, cursor: 'text' }}
    >
      {concept.name}
    </h1>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}
