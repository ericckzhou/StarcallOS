-- Migration 0024: stamp the LLM contract version on every parse run.
-- Parser/grammar/layout behavior is already versioned and audited per run;
-- this extends the same auditability to LLM behavior. The contract version
-- corresponds to the `contracts/*.md` specs that define each pass's purpose,
-- output schema, invariants, and forbidden behavior. Existing rows predate the
-- formalization, so they default to '0' (unversioned).

ALTER TABLE parse_runs ADD COLUMN contract_version TEXT NOT NULL DEFAULT '0';
