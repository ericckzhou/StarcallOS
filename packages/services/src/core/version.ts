// Hand-bumped version stamps for parser components. Bump the relevant constant
// whenever you change behavior that produces different output for the same
// input. Every candidate row + parse_runs row records these so historical
// extractions can be traced to the exact code that produced them.

export const PARSER_VERSION  = '0.5.0';  // candidates.ts: final_score parts, labels, context snippets, typography-backed scoring
export const GRAMMAR_VERSION = '0.2.2';  // grammar.ts: definition terms may include multi-word Title Case phrases
export const LAYOUT_VERSION  = '0.4.0';  // layout.ts: x-gap spacing reconstruction + richer typography/block signals for candidate scoring

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
