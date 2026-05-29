-- Migration 0020: Constellations (concepts.where_reappears) are user-curated
-- only, but on-demand enrichment was writing LLM-generated links into them.
-- That writer has been removed; this one-time cleanup clears the LLM-generated
-- links so the list starts empty and the user curates it themselves going
-- forward. New manual links added after this migration are untouched.

UPDATE concepts SET where_reappears = '[]';
