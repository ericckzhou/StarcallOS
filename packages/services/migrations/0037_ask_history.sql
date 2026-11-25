-- Migration 0037: per-concept Ask history (RAG PR 3).
--
-- "Ask about this" from a concept saves each question and its full verified
-- result so it can be revisited. Every row is an independent, single-turn,
-- citation-validated answer: there is deliberately no conversation thread,
-- because feeding earlier answers back into the prompt would let the model cite
-- itself instead of the source. User-owned (not derived): never wiped by
-- re-extract; removed with the concept.
CREATE TABLE IF NOT EXISTS ask_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_id  INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  question    TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  model       TEXT,
  result_json TEXT    NOT NULL,   -- the AskResult as returned (passages, citations, spans)
  created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ask_history_concept_created
  ON ask_history(concept_id, created_at DESC, id DESC);
