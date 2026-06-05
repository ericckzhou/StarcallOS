// Prerequisite / dependency traversal over the user-curated concept_edges DAG.
//
// The thesis "prerequisite edges are constellation lines" made traversable:
//   - learnFirst(C): the transitive prerequisites of C, topologically ordered
//     so a concept always appears before anything that depends on it
//     (deepest-first). "Learn these before C."
//   - unlocks(C): the concepts that (transitively) depend on C. "Mastering C
//     opens these up."
//   - readiness(C): the DIRECT prerequisites whose mastery is still too low —
//     the PLAN.md "dependency failure" signal ("learn X first").
//
// Only the two dependency-bearing edge kinds participate: `requires` and
// `enables`. By convention (see listRequirementsFor) `from_id` is the
// PREREQUISITE and `to_id` is the DEPENDENT. So:
//   prerequisites(C) = { p : edge p -> C }   (incoming edges)
//   dependents(C)    = { d : edge C -> d }   (outgoing edges)
//
// All traversals are cycle-safe (visited set) and bounded, so a malformed or
// cyclic user graph degrades gracefully instead of looping.

import type { DatabaseSync } from '../core/infra/sqlite';
import type { EdgeType } from '../core/domain/types';

export const PREREQUISITE_EDGE_TYPES = ['requires', 'enables'] as const;
export type PrerequisiteEdgeType = (typeof PREREQUISITE_EDGE_TYPES)[number];

// A concept whose mastery stage is at or below this is treated as "not yet
// known" for the dependency-failure signal (0 unseen, 1 memorized, 2 explain).
export const PREREQUISITE_READY_STAGE = 2;

// Safety cap on the number of nodes any single traversal will visit, so an
// enormous or pathological graph can't stall the UI.
const MAX_TRAVERSAL_NODES = 400;

export interface PrerequisiteNode {
  id: number;
  name: string;
  slug: string;
  source_id: number;
  importance: string;
  mastery_stage: number;
}

export interface ConceptPrerequisites {
  // Direct (one-hop) prerequisites of the concept.
  direct: PrerequisiteNode[];
  // Transitive prerequisites, topologically ordered (learn earliest-first).
  learnFirst: PrerequisiteNode[];
  // Transitive dependents — what mastering this concept unlocks.
  unlocks: PrerequisiteNode[];
  // Direct prerequisites the learner has not yet reached PREREQUISITE_READY_STAGE
  // on. Non-empty => "learn these first".
  blocked: PrerequisiteNode[];
  // True if a cycle was encountered in the prerequisite closure (the data is
  // not a clean DAG). learnFirst still returns every node, with the cyclic
  // remainder appended deterministically.
  hasCycle: boolean;
}

interface AdjacencyMaps {
  // prereqsOf[x] = concepts that x depends on (incoming edges p -> x).
  prereqsOf: Map<number, number[]>;
  // dependentsOf[x] = concepts that depend on x (outgoing edges x -> d).
  dependentsOf: Map<number, number[]>;
}

function loadPrerequisiteEdges(db: DatabaseSync): AdjacencyMaps {
  const placeholders = PREREQUISITE_EDGE_TYPES.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT from_id, to_id FROM concept_edges WHERE edge_type IN (${placeholders})`,
    )
    .all(...PREREQUISITE_EDGE_TYPES) as Array<{ from_id: number | bigint; to_id: number | bigint }>;

  const prereqsOf = new Map<number, number[]>();
  const dependentsOf = new Map<number, number[]>();
  for (const r of rows) {
    const from = Number(r.from_id); // prerequisite
    const to = Number(r.to_id); // dependent
    if (from === to) continue; // defensive: ignore any stray self-edge
    (prereqsOf.get(to) ?? prereqsOf.set(to, []).get(to)!).push(from);
    (dependentsOf.get(from) ?? dependentsOf.set(from, []).get(from)!).push(to);
  }
  return { prereqsOf, dependentsOf };
}

// Collect the closure reachable from `start` by repeatedly following `next`.
// Excludes `start` itself. Cycle-safe and node-bounded.
function collectClosure(
  start: number,
  next: Map<number, number[]>,
): Set<number> {
  const out = new Set<number>();
  const stack = [...(next.get(start) ?? [])];
  while (stack.length > 0 && out.size < MAX_TRAVERSAL_NODES) {
    const node = stack.pop()!;
    if (node === start || out.has(node)) continue;
    out.add(node);
    for (const n of next.get(node) ?? []) {
      if (n !== start && !out.has(n)) stack.push(n);
    }
  }
  return out;
}

// Topologically order `nodes` using the prerequisite relation restricted to the
// set: a node's prerequisites appear before it. Kahn's algorithm; on a cycle,
// the remaining (cyclic) nodes are appended in ascending-id order and `cyclic`
// is set. Returns ids in learn-first order.
function topoSortPrereqs(
  nodes: Set<number>,
  prereqsOf: Map<number, number[]>,
): { order: number[]; cyclic: boolean } {
  // Build the induced subgraph + indegree (indegree = number of prerequisites
  // still inside the set).
  const inSet = (n: number) => nodes.has(n);
  const indegree = new Map<number, number>();
  const dependents = new Map<number, number[]>(); // prereq -> dependents (within set)
  for (const n of nodes) {
    indegree.set(n, 0);
    if (!dependents.has(n)) dependents.set(n, []);
  }
  for (const n of nodes) {
    for (const p of prereqsOf.get(n) ?? []) {
      if (!inSet(p)) continue;
      indegree.set(n, (indegree.get(n) ?? 0) + 1);
      (dependents.get(p) ?? dependents.set(p, []).get(p)!).push(n);
    }
  }
  // Seed queue with zero-indegree nodes, deterministic by id.
  const ready = [...nodes].filter(n => (indegree.get(n) ?? 0) === 0).sort((a, b) => a - b);
  const order: number[] = [];
  while (ready.length > 0) {
    const n = ready.shift()!;
    order.push(n);
    const newlyReady: number[] = [];
    for (const d of dependents.get(n) ?? []) {
      const deg = (indegree.get(d) ?? 0) - 1;
      indegree.set(d, deg);
      if (deg === 0) newlyReady.push(d);
    }
    newlyReady.sort((a, b) => a - b);
    for (const d of newlyReady) ready.push(d);
  }
  if (order.length < nodes.size) {
    // Cycle: append the unresolved remainder deterministically.
    const placed = new Set(order);
    const remainder = [...nodes].filter(n => !placed.has(n)).sort((a, b) => a - b);
    return { order: [...order, ...remainder], cyclic: true };
  }
  return { order, cyclic: false };
}

function hydrate(db: DatabaseSync, ids: number[]): Map<number, PrerequisiteNode> {
  const out = new Map<number, PrerequisiteNode>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.slug, c.source_id, c.importance,
              COALESCE(m.compression_stage, 0) AS mastery_stage
         FROM concepts c
         LEFT JOIN mastery m ON m.concept_id = c.id
        WHERE c.id IN (${placeholders})`,
    )
    .all(...ids) as Array<{
      id: number | bigint; name: string; slug: string; source_id: number | bigint;
      importance: string; mastery_stage: number;
    }>;
  for (const r of rows) {
    out.set(Number(r.id), {
      id: Number(r.id),
      name: r.name,
      slug: r.slug,
      source_id: Number(r.source_id),
      importance: r.importance,
      mastery_stage: Number(r.mastery_stage ?? 0),
    });
  }
  return out;
}

export function getConceptPrerequisites(db: DatabaseSync, conceptId: number): ConceptPrerequisites {
  const { prereqsOf, dependentsOf } = loadPrerequisiteEdges(db);

  const directIds = (prereqsOf.get(conceptId) ?? []).filter(id => id !== conceptId);
  const prereqClosure = collectClosure(conceptId, prereqsOf);
  const dependentClosure = collectClosure(conceptId, dependentsOf);

  const { order: learnFirstOrder, cyclic } = topoSortPrereqs(prereqClosure, prereqsOf);

  // Hydrate every id we'll return in one query.
  const allIds = new Set<number>([...directIds, ...prereqClosure, ...dependentClosure]);
  const nodeById = hydrate(db, [...allIds]);
  const pick = (ids: number[]): PrerequisiteNode[] =>
    ids.map(id => nodeById.get(id)).filter((n): n is PrerequisiteNode => n != null);

  const direct = pick([...new Set(directIds)].sort((a, b) => a - b));
  const learnFirst = pick(learnFirstOrder);
  // Dependents ordered for display by mastery-readiness then id (stable).
  const unlocks = pick([...dependentClosure].sort((a, b) => a - b));
  const blocked = direct.filter(n => n.mastery_stage < PREREQUISITE_READY_STAGE);

  return { direct, learnFirst, unlocks, blocked, hasCycle: cyclic };
}
