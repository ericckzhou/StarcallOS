// Hand-bumped version stamps for parser components. Bump the relevant constant
// whenever you change behavior that produces different output for the same
// input. Every candidate row + parse_runs row records these so historical
// extractions can be traced to the exact code that produced them.

export const PARSER_VERSION  = '0.6.2';  // candidates.ts: strip "Page N" from terms so per-page running headers collapse to one candidate
export const GRAMMAR_VERSION = '0.2.2';  // grammar.ts: definition terms may include multi-word Title Case phrases
export const LAYOUT_VERSION  = '0.5.1';  // layout.ts: cleanHeaderTitle strips "Page N" tokens from running-header titles

// Behavioral contract for the LLM passes (the `contracts/*.md` specs). Bump when
// a pass's purpose, output schema, hard invariants, or forbidden behavior change
// — i.e. anything that makes the same input legitimately produce a different
// shape/decision. This makes LLM behavior as inspectable/versioned as parser
// behavior: parse_runs stamps it so any extraction can be traced to the contract
// the model was held to. The string is shared by every pass; if passes diverge
// enough to need independent versions, split this into a per-pass map.
export const CONTRACT_VERSION = '1.0.0';  // contracts/*.md: initial formalization of enrich, grader, lazy_tasks, topic_filter, concept_enrichment

export interface ParserVersions {
  parser_version: string;
  grammar_version: string;
  layout_version: string;
  contract_version: string;
}

export function currentVersions(): ParserVersions {
  return {
    parser_version:  PARSER_VERSION,
    grammar_version: GRAMMAR_VERSION,
    layout_version:  LAYOUT_VERSION,
    contract_version: CONTRACT_VERSION,
  };
}
