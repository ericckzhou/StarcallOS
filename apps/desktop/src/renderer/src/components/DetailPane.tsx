import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Concept } from './ConceptPane';
import LatexMath from './LatexMath';
import PdfViewer from './PdfViewer';
import UserNotesSection from './UserNotesSection';
import WhereItReappearsEditor from './WhereItReappearsEditor';
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
};
const SOURCE_PREVIEW_KEY = 'starcall.layout.sourcePreviewOpen';
const SOURCE_PREVIEW_NOTES_WIDTH_KEY = 'starcall.layout.sourcePreviewNotesWidth';

interface Props { concept: Concept | null; onDeleted?: (conceptId: number) => void; profile?: Profile; }

export default function DetailPane({ concept, onDeleted, profile }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [mastery, setMastery] = useState<Mastery | null>(null);
  const [misconceptions, setMisconceptions] = useState<Misconception[]>([]);
  const [equations, setEquations] = useState<Equation[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [tab, setTab] = useState<'overview' | 'paper' | 'challenge' | 'history'>('overview');
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
    return [...set];
  })();
  const TAB_LABELS = {
    overview: 'Overview',
    paper: 'Paper',
    challenge: 'Challenges',
    history: `History${history.length ? ` (${history.length})` : ''}`,
  };
  const activeTabContent = (
    <>
      {tab === 'overview' && <OverviewTab concept={concept} misconceptions={misconceptions} equations={equations} onEquationsChange={setEquations} />}
      {tab === 'paper' && <PaperTab conceptId={concept.id} />}
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
      {(['overview', 'paper', 'challenge', 'history'] as const).map(t => (
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
              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: `${IMP_COLOR[concept.importance] ?? '#374151'}22`, color: IMP_COLOR[concept.importance] ?? '#6b7280', flexShrink: 0 }}>
                {concept.importance}
              </span>
              {headerKinds.map(k => (
                <span key={k} style={{
                  fontSize: 10, padding: '2px 7px', borderRadius: 3,
                  border: `1px solid ${EVIDENCE_KIND_COLOR[k] ?? '#374151'}`,
                  color: EVIDENCE_KIND_COLOR[k] ?? '#6b7280',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                  flexShrink: 0,
                }}>{k.replace(/_/g, ' ')}</span>
              ))}
              <span style={{ marginLeft: 'auto', fontSize: 11, padding: '3px 10px', borderRadius: 12, background: `${STAGE_COLORS[stage]}22`, color: STAGE_COLORS[stage], fontWeight: 600, flexShrink: 0 }}>
                {STAGES[stage]}
              </span>
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
          <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: `${IMP_COLOR[concept.importance] ?? '#374151'}22`, color: IMP_COLOR[concept.importance] ?? '#6b7280' }}>
            {concept.importance}
          </span>
          {headerKinds.map(k => (
            <span key={k} style={{
              fontSize: 10, padding: '2px 7px', borderRadius: 3,
              border: `1px solid ${EVIDENCE_KIND_COLOR[k] ?? '#374151'}`,
              color: EVIDENCE_KIND_COLOR[k] ?? '#6b7280',
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>{k.replace(/_/g, ' ')}</span>
          ))}
          <span style={{ marginLeft: 'auto', fontSize: 11, padding: '3px 10px', borderRadius: 12, background: `${STAGE_COLORS[stage]}22`, color: STAGE_COLORS[stage], fontWeight: 600 }}>
            {STAGES[stage]}
          </span>
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
      <textarea
        value={loaded ? text : ''}
        onChange={e => onChange(e.target.value)}
        onBlur={() => { void flush(); }}
        readOnly={!loaded}
        placeholder={loaded ? 'Think on paper. Synthesize, connect, draft — autosaves.' : 'Loading…'}
        spellCheck
        style={{
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
  const normalizeReappears = (v: Concept['where_reappears']): string[] =>
    Array.isArray(v) ? v : (typeof v === 'string' && v.trim() !== '' ? [v] : []);
  const [constellations, setConstellations] = useState<string[]>(() => normalizeReappears(concept.where_reappears));
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
  const [editingEquationId, setEditingEquationId] = useState<number | null>(null);
  const [editEqLatex, setEditEqLatex] = useState('');
  const [editEqPage, setEditEqPage] = useState('');
  const [editEqVars, setEditEqVars] = useState('');

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
                background: '#111827',
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

          {addingEquation && (
            <div style={{ background: '#0d0d16', border: '1px solid #312e81', borderRadius: 6, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <textarea
                value={equationDraft}
                onChange={e => setEquationDraft(e.target.value)}
                placeholder="Type equation or LaTeX-ish formula..."
                rows={3}
                style={{
                  width: '100%', boxSizing: 'border-box', resize: 'vertical',
                  background: '#111827', border: '1px solid #1f2937', borderRadius: 4,
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
                    width: 80, background: '#111827', border: '1px solid #1f2937',
                    borderRadius: 4, padding: '6px 8px', color: '#cbd5e1', fontSize: 12,
                  }}
                />
                <input
                  value={equationVarsDraft}
                  onChange={e => setEquationVarsDraft(e.target.value)}
                  placeholder="vars, comma separated (optional)"
                  style={{
                    flex: '1 1 220px', background: '#111827', border: '1px solid #1f2937',
                    borderRadius: 4, padding: '6px 8px', color: '#cbd5e1', fontSize: 12,
                  }}
                />
                <button onClick={() => void addEquation()} disabled={equationBusy} style={btnSecondary(equationBusy)}>
                  {equationBusy ? 'Saving...' : 'Save equation'}
                </button>
              </div>
            </div>
          )}

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
                    <button onClick={cancelEditEquation} disabled={equationBusy} style={btnTiny(equationBusy)}>Cancel</button>
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
      <Section title="Constellations">
        <WhereItReappearsEditor
          conceptId={concept.id}
          value={constellations}
          onChange={next => {
            setConstellations(next);
            // Keep the parent's concept reference in sync so other surfaces
            // see the new list immediately on the next render.
            concept.where_reappears = next;
            void window.api.concepts.updateFields({
              conceptId: concept.id,
              where_reappears: next,
            });
          }}
        />
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

      <UserNotesSection conceptId={concept.id} />

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
      <textarea
        value={value}
        placeholder={placeholder}
        onChange={e => handleChange(e.target.value)}
        rows={Math.max(2, Math.min(8, Math.ceil((value.length || placeholder.length) / 70)))}
        style={{
          width: '100%', boxSizing: 'border-box', resize: 'vertical',
          background: value ? '#111827' : '#0d0d16',
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
          <div key={r.id} style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 8, padding: '14px 16px' }}>
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
          title="Replace all 5 tasks with newly generated ones"
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            border: '1px solid #1f2937',
            borderRadius: 4, padding: '4px 10px', fontSize: 11,
            color: generatingTasks ? '#4b5563' : '#9ca3af',
            cursor: generatingTasks ? 'wait' : 'pointer',
          }}
        >
          {generatingTasks ? 'Regenerating…' : 'Regenerate'}
        </button>
      </div>
      {taskGenError && (
        <div style={{ color: '#fca5a5', fontSize: 12, lineHeight: 1.5 }}>{taskGenError}</div>
      )}
      {selectedTask && (
        <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 8, padding: '14px 16px' }}>
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
          background: '#111827', border: '1px solid #1f2937', borderRadius: 6, padding: 12,
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
        <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 8, padding: '14px 16px' }}>
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
      <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 6, padding: '12px 14px' }}>
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
