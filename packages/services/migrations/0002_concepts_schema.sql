-- Extend events with indexed entity columns (nullable for backward compatibility)
ALTER TABLE events ADD COLUMN entity_type TEXT;
ALTER TABLE events ADD COLUMN entity_id   INTEGER;

-- Core concepts table
CREATE TABLE IF NOT EXISTS concepts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  slug           TEXT    NOT NULL UNIQUE,
  summary        TEXT,
  why_it_matters TEXT    NOT NULL CHECK (length(trim(why_it_matters)) > 0),
  status         TEXT    NOT NULL DEFAULT 'unseen'
                         CHECK (status IN ('unseen','learning','weak','understood','needs_review')),
  difficulty     TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
