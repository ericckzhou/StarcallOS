-- Migration 0026: Star Hub edges — user-curated relationships BETWEEN hubs,
-- distinct from concept-to-concept constellation links. Each edge is optionally
-- labeled and directional (a→b one-way, or mutual). Cascades away when either
-- endpoint hub is deleted. Never written by any LLM pass or by re-extraction.

CREATE TABLE IF NOT EXISTS star_hub_edges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  a_hub_id   INTEGER NOT NULL REFERENCES star_hubs(id) ON DELETE CASCADE,
  b_hub_id   INTEGER NOT NULL REFERENCES star_hubs(id) ON DELETE CASCADE,
  label      TEXT    NOT NULL DEFAULT '',
  directed   INTEGER NOT NULL DEFAULT 1,   -- 1 = a→b one-way, 0 = mutual a↔b
  created_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One edge per ordered (a, b) pair; a→b and b→a stay distinct rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_star_hub_edges_pair ON star_hub_edges(a_hub_id, b_hub_id);
CREATE INDEX IF NOT EXISTS idx_star_hub_edges_a ON star_hub_edges(a_hub_id);
CREATE INDEX IF NOT EXISTS idx_star_hub_edges_b ON star_hub_edges(b_hub_id);
