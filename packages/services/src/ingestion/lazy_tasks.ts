// On-demand task generation for a single concept.
// Used when a promoted candidate has no evidence_tasks yet and the user
// opens its Challenge Me tab. Pay-per-use: ~500 tok per concept.

import { chatJSON, type ProviderConfig } from '../core/llm';
import type { DatabaseSync } from '../core/infra/sqlite';
import { getConceptById } from '../knowledge/repos/concepts';
import { getSourceById } from '../knowledge/repos/sources';
import { listTasksByConcept, createTask, deleteTasksForConcept } from '../knowledge/repos/evidence';
import type { EvidenceTask, EvidenceKind } from '../core/domain/types';

const TASK_SYSTEM = `You are an expert tutor in evidence-based learning across all
academic and professional domains (STEM, humanities, social sciences, law,
medicine, business, trades, etc.). The learner is studying THIS specific source,
so every question must be grounded in the source's own domain, vocabulary, and
examples — never in your default associations for an ambiguous concept name.
Given one concept's name, importance, and definition, generate EXACTLY 5 evidence tasks —
one per kind, in this exact order: definition, connection, application, misconception_resistance, compression.

Each kind has a strict contract. The "kind" label must match the question type — never mix.

KIND CONTRACTS

definition
  Goal: learner states what the concept IS — its category, its essential property, and what distinguishes it.
  Must start with one of: "Define …", "What is …", "In your own words, what does … mean?", "Explain what … is and what makes it different from …".
  Must NOT ask how to use it, where it's used, when to apply it, or its relationship to other things.

connection
  Goal: learner relates this concept to ONE other named concept or pre-requisite.
  Must reference at least one other concept by name (from the definition or a closely related idea).
  Phrasing like: "How does X depend on Y?", "Why does X require Y?", "Contrast X with Y.", "What changes about X if Y is absent?".

application
  Goal: learner uses the concept on a concrete scenario.
  Must present a specific situation, dataset, system, or input and ask the learner to apply the concept to it.
  Phrasing like: "Given …, how would you use X to …?", "A team is doing …. Should they use X? Why or why not?".

misconception_resistance
  Goal: learner spots and corrects a wrong assumption a beginner often makes about this concept.
  Must state a plausible-but-wrong claim or scenario and ask the learner to identify what's wrong and fix it.
  Phrasing like: "A student says '…'. What's wrong with this and how would you correct it?".

compression
  Goal: learner expresses the core idea in 1–2 sentences WITHOUT using the concept name itself.
  Must explicitly forbid the concept name (and obvious synonyms) in the answer.
  Phrasing like: "Explain X in 1–2 sentences without using the words '<name>' or '<synonym>'."

DIFFICULTY (1–5)
foundational → 3–5, core → 2–4, supporting → 1–3, peripheral → 1–2.

EXAMPLE — for FORMAT and KIND DISCIPLINE only. This example happens to be from
machine learning; your output must reflect the ACTUAL domain of the concept and
source the user provides (could be law, history, chemistry, finance, etc.).
(concept: "Backpropagation", importance: core)
{
  "tasks": [
    { "kind": "definition", "prompt": "Define backpropagation. What is it computing, and what distinguishes it from forward propagation?", "difficulty": 3 },
    { "kind": "connection", "prompt": "How does backpropagation depend on the chain rule from calculus? What would break if intermediate activations were not stored during the forward pass?", "difficulty": 4 },
    { "kind": "application", "prompt": "You train a 3-layer MLP on MNIST and the loss plateaus after one epoch. Using what backpropagation actually computes, name two concrete diagnostics you would run on the gradients to localize the problem.", "difficulty": 4 },
    { "kind": "misconception_resistance", "prompt": "A student says: 'Backpropagation is how the network learns — it adjusts the weights to reduce loss.' What's imprecise or wrong about this statement, and how would you correct it?", "difficulty": 3 },
    { "kind": "compression", "prompt": "Explain in 1–2 sentences what backpropagation does, without using the words 'backpropagation', 'backprop', or 'gradient descent'.", "difficulty": 4 }
  ]
}

OUTPUT
Respond ONLY with JSON: { "tasks": [ { "kind": "...", "prompt": "...", "difficulty": N }, ... ] }
The 5 tasks must appear in the order: definition, connection, application, misconception_resistance, compression.
Tasks must require genuine understanding, not recall.`;

interface RawTask {
  kind: EvidenceKind;
  prompt: string;
  difficulty: number;
}

export async function ensureTasksForConcept(
  config: ProviderConfig,
  db: DatabaseSync,
  conceptId: number,
): Promise<EvidenceTask[]> {
  const existing = listTasksByConcept(db, conceptId);
  if (existing.length > 0) return existing;

  const concept = getConceptById(db, conceptId);
  if (!concept) throw new Error(`concept ${conceptId} not found`);

  const source = getSourceById(db, concept.source_id);
  const lines: string[] = [
    `Concept: ${concept.name}`,
    `Importance: ${concept.importance}`,
    `Definition: ${concept.definition_text || '(no definition recorded — anchor tasks to the concept name and source context only)'}`,
  ];
  if (source?.title) lines.unshift(`Source title: ${source.title}`);
  else if (source?.filename) lines.unshift(`Source filename: ${source.filename}`);
  if (source?.author) lines.splice(1, 0, `Author: ${source.author}`);
  if (concept.section_path.length > 0) {
    lines.push(`Section: ${concept.section_path.join(' › ')}`);
  }

  try {
    const row = db
      .prepare('SELECT evidence_json FROM concepts WHERE id = ?')
      .get(conceptId) as { evidence_json?: string } | undefined;
    if (row?.evidence_json) {
      const spans = JSON.parse(row.evidence_json) as Array<{ quote?: string; page?: number }>;
      const seen = new Set<string>();
      const quotes: string[] = [];
      for (const s of spans) {
        const q = (s.quote ?? '').trim();
        if (!q) continue;
        const key = q.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const truncated = q.length > 240 ? q.slice(0, 240) + '…' : q;
        quotes.push(s.page != null ? `(p.${s.page}) ${truncated}` : truncated);
        if (quotes.length >= 3) break;
      }
      if (quotes.length > 0) {
        lines.push('Evidence quotes from this source:');
        for (const q of quotes) lines.push(`  • ${q}`);
      }
    }
  } catch {
    // fall through — context still useful without evidence
  }

  const userContent = lines.join('\n');

  const { content } = await chatJSON(
    config,
    {
      messages: [
        { role: 'system', content: TASK_SYSTEM },
        { role: 'user', content: userContent },
      ],
      responseFormat: 'json',
      temperature: 0.3,
    },
    'lazy_tasks',
  );

  const parsed = JSON.parse(content || '{"tasks":[]}') as { tasks?: RawTask[] };
  const tasks = parsed.tasks ?? [];

  const validKinds: EvidenceKind[] = [
    'definition',
    'connection',
    'application',
    'misconception_resistance',
    'compression',
  ];

  const saved: EvidenceTask[] = [];
  for (const t of tasks) {
    if (!t.kind || !t.prompt) continue;
    if (!validKinds.includes(t.kind)) continue;
    saved.push(
      createTask(db, {
        concept_id: conceptId,
        kind: t.kind,
        prompt: t.prompt,
        difficulty: Math.max(1, Math.min(5, Math.round(t.difficulty || 3))) as 1 | 2 | 3 | 4 | 5,
      }),
    );
  }
  return saved;
}

export async function regenerateTasksForConcept(
  config: ProviderConfig,
  db: DatabaseSync,
  conceptId: number,
): Promise<EvidenceTask[]> {
  deleteTasksForConcept(db, conceptId);
  return ensureTasksForConcept(config, db, conceptId);
}
