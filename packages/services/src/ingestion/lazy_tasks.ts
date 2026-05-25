// On-demand task generation for a single concept.
// Used when a promoted candidate has no evidence_tasks yet and the user
// opens its Challenge Me tab. Pay-per-use: ~500 tok per concept.

import { chatJSON, type ProviderConfig } from '../core/llm';
import type { DatabaseSync } from '../core/infra/sqlite';
import { getConceptById } from '../knowledge/repos/concepts';
import { listTasksByConcept, createTask } from '../knowledge/repos/evidence';
import type { EvidenceTask, EvidenceKind } from '../core/domain/types';

const TASK_SYSTEM = `You are an expert in evidence-based learning.
Given one concept's name, importance, and definition, generate exactly 5 evidence tasks —
one per kind: definition, connection, application, misconception_resistance, compression.

Tasks must require genuine understanding, not recall.
Calibrate difficulty (1–5): foundational=3-5, core=2-4, supporting=1-3, peripheral=1-2.

compression: express the core idea in 1–2 sentences without using the concept name.
misconception_resistance: present a scenario with a hidden wrong assumption and ask the learner to identify and correct it.

Respond ONLY with JSON: { "tasks": [...] }
Each task: { "kind": "...", "prompt": "...", "difficulty": N }`;

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

  const userContent =
    `Concept: ${concept.name}\n` +
    `Importance: ${concept.importance}\n` +
    `Definition: ${concept.definition_text || '(no definition recorded — generate tasks anchored to the concept name only)'}`;

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

  const saved: EvidenceTask[] = [];
  for (const t of tasks) {
    if (!t.kind || !t.prompt) continue;
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
