import type { AskResult } from '@starcall/shared';

// Status labels for Ask answers. Pure so the legacy-history rule is testable.

export type AskStatus = AskResult['status'];
export interface StatusMeta { label: string; color: string; hint: string }

export const STATUS_META: Record<AskStatus, StatusMeta> = {
  // "Citations verified", not "Grounded": the checks prove each quote exists
  // in its passage and each sentence cites one, not that the passage entails
  // the sentence (services ASK_VERIFICATION.entailment = 'not_checked').
  grounded:       { label: 'Citations verified',   color: '#22c55e', hint: 'Every sentence cites a passage, and every quote was found verbatim in its passage. Whether each passage actually supports its sentence is not checked; read the quotes.' },
  partial:        { label: 'Partly verified',      color: '#f59e0b', hint: 'Some quotes were verified, but some sentences are not tied to a verified citation, share few words with the passage they cite, or had citations removed because their quotes could not be verified.' },
  qualified:      { label: 'Sources partly answer this', color: '#eab308', hint: 'The passages do not fully answer the question; the answer says what they do cover, and every citation was verified.' },
  unsupported:    { label: 'Unsupported',          color: '#ef4444', hint: 'The model answered, but none of its citations could be verified. Treat the answer as unreliable.' },
  insufficient:   { label: 'Not in sources',       color: '#94a3b8', hint: 'The model reports that the retrieved passages do not answer this.' },
  no_passages:    { label: 'No matching passages', color: '#94a3b8', hint: 'Retrieval found nothing in the selected sources; no model call was made.' },
  retrieval_only: { label: 'Passages only',        color: '#818cf8', hint: 'The local model is unavailable, so only the retrieved passages are shown.' },
};

// Answers saved to history before per-sentence claim coverage carry no
// `verification` field: their status was computed under the older rule, where
// "grounded" meant only that every listed quote was found; uncited sentences
// were not checked. Never let those inherit the "Citations verified" meaning.
export const LEGACY_GROUNDED: StatusMeta = {
  label: 'Quotes verified (older check)',
  color: '#94a3b8',
  hint: 'Saved before sentence-level checks existed: every listed quote was found verbatim, but sentences were not checked for citations. Ask again to apply the current checks.',
};

export const isLegacy = (r: Pick<AskResult, 'verification' | 'answer'>) => !r.verification && !!r.answer;

export function statusMeta(r: Pick<AskResult, 'verification' | 'answer' | 'status'>): StatusMeta {
  return isLegacy(r) && r.status === 'grounded' ? LEGACY_GROUNDED : STATUS_META[r.status];
}
