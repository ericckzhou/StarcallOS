-- Migration 0019: Star Hubs — named, color-coded groups of concepts layered on
-- top of the flat constellation links. Hubs are cross-source (membership is by
-- global concept_id). parent_hub_id supports future nesting (no UI yet).
-- User-curated; never written by any LLM pass or by re-extraction.

CREATE TABLE IF NOT EXISTS star_hubs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT '',
  color         TEXT    NOT NULL DEFAULT '#818cf8',
  type          TEXT    NOT NULL DEFAULT 'theme',
  importance    TEXT    NOT NULL DEFAULT 'core',
  parent_hub_id INTEGER REFERENCES star_hubs(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS star_hub_members (
  hub_id      INTEGER NOT NULL REFERENCES star_hubs(id) ON DELETE CASCADE,
  concept_id  INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  role        TEXT    NOT NULL DEFAULT 'core',
  order_index INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hub_id, concept_id)
);

CREATE INDEX IF NOT EXISTS idx_star_hub_members_hub     ON star_hub_members(hub_id);
CREATE INDEX IF NOT EXISTS idx_star_hub_members_concept ON star_hub_members(concept_id);
