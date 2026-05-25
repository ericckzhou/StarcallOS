import React, { useEffect, useRef, useState } from 'react';
import type { Concept } from './ConceptPane';
import LatexMath from './LatexMath';
import PdfViewer from './PdfViewer';
import UserNotesSection from './UserNotesSection';

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
const SOURCE_PREVIEW_KEY = 'starcall.layout.sourcePreviewOpen';
const SOURCE_PREVIEW_NOTES_WIDTH_KEY = 'starcall.layout.sourcePreviewNotesWidth';

interface Props { concept: Concept | null; onDeleted?: (conceptId: number) => void; }

export default function DetailPane({ concept, onDeleted }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [mastery, setMastery] = useState<Mastery | null>(null);
  const [misconceptions, setMisconceptions] = useState<Misconception[]>([]);
  const [equations, setEquations] = useState<Equation[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [tab, setTab] = useState<'overview' | 'challenge' | 'history'>('overview');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [response, setResponse] = useState('');
  const [grading, setGrading] = useState(false);
  const [grade, setGrade] = useState<Grade | null>(null);
  const [generatingTasks, setGeneratingTasks] = useState(false);
  const [taskGenError, setTaskGenError] = useState<string | null>(null);
  const [sourcePreviewOpen, setSourcePreviewOpen] = useState(() => localStorage.getItem(SOURCE_PREVIEW_KEY) === 'true');
  const [sourcePreviewNotesWidth, setSourcePreviewNotesWidth] = useState(() => Number(localStorage.getItem(SOURCE_PREVIEW_NOTES_WIDTH_KEY)) || 760);
  const sourcePreviewSplitRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!concept) return;
    setTasks([]); setMastery(null); setMisconceptions([]); setEquations([]);
    setHistory([]); setGrade(null); setSelectedTask(null); setResponse('');
    setTaskGenError(null); setGeneratingTasks(false);
    Promise.all([
      window.api.concepts.tasks(concept.id),
      window.api.concepts.mastery(concept.id),
      window.api.concepts.misconceptions(concept.id),
      window.api.evidence.history(concept.id),
      window.api.concepts.equations(concept.id),
    ]).then(([t, m, mis, h, eq]) => {
      const tl = t as Task[];
      setTasks(tl);
      setMastery(m as Mastery | null);
      setMisconceptions(mis as Misconception[]);
      setHistory((h as HistoryRecord[]).slice().reverse());
      setEquations(eq as Equation[]);
      if (tl.length > 0) setSelectedTask(tl[0]);
    });
  }, [concept?.id]);

  useEffect(() => {
    localStorage.setItem(SOURCE_PREVIEW_KEY, String(sourcePreviewOpen));
  }, [sourcePreviewOpen]);

  useEffect(() => {
    localStorage.setItem(SOURCE_PREVIEW_NOTES_WIDTH_KEY, String(sourcePreviewNotesWidth));
  }, [sourcePreviewNotesWidth]);

  function beginSourcePreviewResize(e: React.MouseEvent<HTMLDivElement>): void {
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
    const ok = window.confirm('Delete this history entry? This cannot be undone. Mastery stage is not recomputed.');
    if (!ok) return;
    try {
      await window.api.evidence.delete(recordId);
      setHistory(prev => prev.filter(h => h.id !== recordId));
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
      window.dispatchEvent(new Event('starcall:review-queue-stale'));
    } finally {
      setGrading(false);
    }
  }

  if (!concept) {
    return (
      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151', fontSize: 14 }}>
        Select a concept to explore.
      </main>
    );
  }

  const stage = mastery?.compression_stage ?? 0;
  const TAB_LABELS = {
    overview: 'Overview',
    challenge: 'Challenge Me',
    history: `History${history.length ? ` (${history.length})` : ''}`,
  };
  const activeTabContent = (
    <>
      {tab === 'overview' && <OverviewTab concept={concept} misconceptions={misconceptions} equations={equations} />}
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

  return (
    <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <header style={{ padding: '14px 24px 0', borderBottom: '1px solid #1f2937', background: '#0d0d16' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{concept.name}</h1>
          <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: `${IMP_COLOR[concept.importance] ?? '#374151'}22`, color: IMP_COLOR[concept.importance] ?? '#6b7280' }}>
            {concept.importance}
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 11, padding: '3px 10px', borderRadius: 12, background: `${STAGE_COLORS[stage]}22`, color: STAGE_COLORS[stage], fontWeight: 600 }}>
            {STAGES[stage]}
          </span>
          <button
            onClick={() => setSourcePreviewOpen(v => !v)}
            title="Show or hide source beside the overview"
            style={{
              background: sourcePreviewOpen ? '#1e1b4b' : 'transparent',
              border: `1px solid ${sourcePreviewOpen ? '#4338ca' : '#1f2937'}`,
              borderRadius: 4, padding: '3px 10px',
              color: sourcePreviewOpen ? '#c7d2fe' : '#6b7280',
              fontSize: 11, cursor: 'pointer',
            }}
          >
            Source Preview
          </button>
          <button
            onClick={async () => {
              if (!concept) return;
              const ok = window.confirm(
                `Delete concept "${concept.name}"?\n\nThis also deletes its tasks, mastery, evidence records, and edges. Cannot be undone.`,
              );
              if (!ok) return;
              await window.api.concepts.delete(concept.id);
              onDeleted?.(concept.id);
            }}
            title="Delete this concept and all of its dependent rows (mastery, tasks, records, edges, misconceptions)"
            style={{
              background: 'transparent', border: '1px solid #7f1d1d', borderRadius: 4,
              padding: '3px 10px', color: '#fca5a5', fontSize: 11, cursor: 'pointer',
            }}
          >
            Delete
          </button>
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          {(['overview', 'challenge', 'history'] as const).map(t => (
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
      </header>

      <div style={{
        flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        ...(sourcePreviewOpen ? {} : { overflowY: 'auto', padding: 24 }),
      }}>
        {sourcePreviewOpen ? (
          <div ref={sourcePreviewSplitRef} style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
            <div style={{ flex: `0 0 ${sourcePreviewNotesWidth}px`, minWidth: 360, maxWidth: '70%', overflowY: 'auto', padding: 24 }}>
              {activeTabContent}
            </div>
            <div
              onMouseDown={beginSourcePreviewResize}
              title="Drag to resize content and source"
              style={{
                width: 8, flexShrink: 0, cursor: 'col-resize',
                borderLeft: '1px solid #1f2937', borderRight: '1px solid #111827',
                background: '#0d0d16',
              }}
            />
            <div style={{ flex: 1, minWidth: 520, display: 'flex', overflow: 'hidden' }}>
              <PdfViewer key={`preview:${concept.id}`} conceptId={concept.id} conceptName={concept.name} />
            </div>
          </div>
        ) : (
          activeTabContent
        )}
      </div>
    </main>
  );
}

function OverviewTab({ concept, misconceptions, equations }: { concept: Concept; misconceptions: Misconception[]; equations: Equation[] }) {
  const [local, setLocal] = useState({
    definition_text: concept.definition_text || '',
    why_exists:      concept.why_exists      || '',
    what_breaks:     concept.what_breaks     || '',
  });
  const [enriching, setEnriching] = useState(false);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [enrichErr, setEnrichErr] = useState<string | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const [pasteApplied, setPasteApplied] = useState(false);

  // Re-sync local state when the parent switches to a different concept.
  useEffect(() => {
    setLocal({
      definition_text: concept.definition_text || '',
      why_exists:      concept.why_exists      || '',
      what_breaks:     concept.what_breaks     || '',
    });
    setEnrichErr(null);
    setCopiedPrompt(false);
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
      concept.where_reappears = updated.where_reappears;
    } catch (e) {
      setEnrichErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEnriching(false);
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
    lines.push('  "what_breaks": "Without it, training reduces to expensive numerical differentiation; with stale or missing forward activations, gradients become wrong and learning silently diverges.",');
    lines.push('  "where_reappears": ["Gradient Descent", "Chain Rule", "Computation Graph", "Vanishing Gradient", "Automatic Differentiation"]');
    lines.push('}');
    lines.push('');
    lines.push('Now produce the JSON for the concept above, in this exact shape:');
    lines.push('{');
    lines.push('  "definition_text": "1–3 sentences. Precise meaning AS USED IN THIS SOURCE.",');
    lines.push('  "why_exists": "1–2 sentences. The problem this concept solves in its domain.",');
    lines.push('  "what_breaks": "1–2 sentences. What goes wrong when missing or misapplied.",');
    lines.push('  "where_reappears": ["other concepts from the SAME domain", "...", "max 5"]');
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
    const patch = {
      conceptId: concept.id,
      ...(parsed.definition_text !== undefined ? { definition_text: parsed.definition_text } : {}),
      ...(parsed.why_exists      !== undefined ? { why_exists:      parsed.why_exists      } : {}),
      ...(parsed.what_breaks     !== undefined ? { what_breaks:     parsed.what_breaks     } : {}),
      ...(parsed.where_reappears !== undefined ? { where_reappears: parsed.where_reappears } : {}),
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
    if (parsed.where_reappears !== undefined) concept.where_reappears = parsed.where_reappears;
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
      {equations.length > 0 && (
        <Section title={`Equations (${equations.length})`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {equations.map(eq => (
              <div key={eq.id} style={{ background: '#0d0d16', border: '1px solid #1f2937', borderRadius: 6, padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: eq.variables.length ? 6 : 0, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, color: '#4b5563' }}>p.{eq.page}</span>
                  <LatexMath value={eq.latex} size={14} />
                </div>
                {eq.variables.length > 0 && (
                  <div style={{ fontSize: 10, color: '#6b7280' }}>
                    vars: {eq.variables.slice(0, 8).join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
      {concept.where_reappears && (
        Array.isArray(concept.where_reappears) && concept.where_reappears.length > 0 ? (
          <Section title="Where It Reappears">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {concept.where_reappears.map((w, i) => (
                <span key={i} style={{
                  fontSize: 12, padding: '3px 10px', borderRadius: 12,
                  background: '#1e1b4b', border: '1px solid #312e81', color: '#c7d2fe',
                }}>
                  {w}
                </span>
              ))}
            </div>
          </Section>
        ) : typeof concept.where_reappears === 'string' && concept.where_reappears.trim() !== '' ? (
          <Section title="Where It Reappears"><p style={body}>{concept.where_reappears}</p></Section>
        ) : null
      )}
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
        background: '#0d0d16', border: '1px dashed #1f2937', borderRadius: 6,
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
            {enriching ? 'Enriching…' : 'Or Enrich w/ LLM'}
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
              <button
                onClick={() => onDelete(r.id)}
                title="Delete this history entry"
                style={{
                  marginLeft: 'auto',
                  background: 'transparent', border: '1px solid #3f1515', borderRadius: 4,
                  padding: '4px 10px', fontSize: 11, color: '#fca5a5', cursor: 'pointer',
                }}
              >
                Delete
              </button>
            </div>
            {r.task_prompt_snapshot && (
              <div style={{ marginBottom: 8 }}>
                {r.task_kind_snapshot && (
                  <div style={{ fontSize: 9, color: '#4b5563', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>
                    {r.task_kind_snapshot.replace(/_/g, ' ')}
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
        {tasks.map(t => (
          <button key={t.id} onClick={() => onSelectTask(t)} style={{
            background: selectedTask?.id === t.id ? '#312e81' : '#111827',
            border: `1px solid ${selectedTask?.id === t.id ? '#6366f1' : '#1f2937'}`,
            borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
            color: selectedTask?.id === t.id ? '#a5b4fc' : '#6b7280',
          }}>
            {t.kind.replace(/_/g, ' ')}
          </button>
        ))}
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
  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <StageHeader stage={stage} score={grade.score} />
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

const body:      React.CSSProperties = { margin: 0, fontSize: 14, color: '#c4cfe4', lineHeight: 1.75 };
const bodyMuted: React.CSSProperties = { margin: 0, fontSize: 13, color: '#6b7280', lineHeight: 1.65, fontStyle: 'italic' };
