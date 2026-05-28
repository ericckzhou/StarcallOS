// Hand-bumped version stamps for parser components. Bump the relevant constant
// whenever you change behavior that produces different output for the same
// input. Every candidate row + parse_runs row records these so historical
// extractions can be traced to the exact code that produced them.

export const PARSER_VERSION  = '0.6.2';  // candidates.ts: strip "Page N" from terms so per-page running headers collapse to one candidate
export const GRAMMAR_VERSION = '0.2.2';  // grammar.ts: definition terms may include multi-word Title Case phrases
export const LAYOUT_VERSION  = '0.5.1';  // layout.ts: cleanHeaderTitle strips "Page N" tokens from running-header titles

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
