-- Migration 0028: Prerequisite suggestions (derived, safe-to-wipe).
--
-- Computed candidate prerequisite/dependency edges between PROMOTED concepts.
-- These are SUGGESTIONS ONLY: nothing becomes a real edge until the user
-- accepts one, at which point a row is written to `concept_edges` (the
-- user-curated edge store). This keeps the project invariant intact — "edges
-- are user-curated; an LLM/parser never silently writes them" — while still
-- surfacing the computed prerequisite structure the candidate-first pipeline
-- already knows about (deterministic `requires`/`enables` relation_candidates).
--
-- Derived/idempotent: cleared on re-extract (clearDerivedDataForSource). The
-- accepted concept_edges survive because they live on the preserved promoted
-- concepts, not here.
--
--   from_id  = the PREREQUISITE concept (matches concept_edges convention used
--              by listRequirementsFor: from_id is required by to_id).
--   to_id    = the DEPENDENT concept that needs/builds on from_id.
--   edge_type= 'requires' | 'enables' (the two dependency-bearing kinds).
--   basis    = 'deterministic' (relation_candidates) | 'llm' (lazy suggester).
--   status   = 'pending' (awaiting review) | 'accepted' (edge written) |
--              'dismissed'. Accepted/dismissed rows are KEPT so the same pair
--              isn't re-proposed on every recompute.
CREATE TABLE prerequisite_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   INTEGER NOT NULL REFERENCES sources(id)  ON DELETE CASCADE,
  from_id     INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  to_id       INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  edge_type   TEXT    NOT NULL DEFAULT 'requires'
              CHECK (edge_type IN ('requires','enables')),
  basis       TEXT    NOT NULL DEFAULT 'deterministic'
              CHECK (basis IN ('deterministic','llm')),
  confidence  REAL    NOT NULL DEFAULT 0,
  reason      TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','accepted','dismissed')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  -- No self-edges: a concept can never be its own prerequisite.
  CHECK (from_id <> to_id),
  UNIQUE (from_id, to_id, edge_type)
);
CREATE INDEX idx_prereq_suggestions_source ON prerequisite_suggestions(source_id, status);
