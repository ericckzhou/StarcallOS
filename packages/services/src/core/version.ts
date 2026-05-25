// Hand-bumped version stamps for parser components. Bump the relevant constant
// whenever you change behavior that produces different output for the same
// input. Every candidate row + parse_runs row records these so historical
// extractions can be traced to the exact code that produced them.

export const PARSER_VERSION  = '0.4.0';  // candidates.ts: weighted concept_score, conservative stemmer, acronym-alias normalize, fragment/generic/name guards via core/lexicon.ts
export const GRAMMAR_VERSION = '0.2.1';  // equations.ts: currency-aware inline math filter
export const LAYOUT_VERSION  = '0.3.1';  // layout.ts: + mergeBrokenHeadings (concatenate split heading lines: trailing dash joins with no space, otherwise space) + stripIndexRegion (drops everything from last 25% of doc starting at an "Index" heading)

export interface ParserVersions {
  parser_version: string;
  grammar_version: string;
  layout_version: string;
}

export function currentVersions(): ParserVersions {
  return {
    parser_version:  PARSER_VERSION,
    grammar_version: GRAMMAR_VERSION,
    layout_version:  LAYOUT_VERSION,
  };
}
