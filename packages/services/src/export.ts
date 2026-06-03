// Pure concept export formatters (Markdown + Anki). No DOM/Electron/fs — the
// main process assembles ConceptExportData from the repos and owns the file
// write; this module only turns that data into a string. Keeping it pure makes
// both formats unit-testable without a database.

import type { Concept, ConceptNote } from './core/domain/types';
import type { StoredEquationCandidate } from './knowledge/repos/candidates';
import type { ConceptSrs } from './knowledge/srs';

export type ExportFormat = 'markdown' | 'anki';

export interface ConceptExportData {
  concept: Concept;
  sourceTitle: string;
  notes: ConceptNote[];
  equations: StoredEquationCandidate[];
  srs: ConceptSrs | null;
}

export interface RenderedExport {
  content: string;
  extension: 'md' | 'txt';
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

// where_reappears entries are user-curated constellation links. New rows are
// { name, reason }; legacy rows may be bare strings.
function constellationLabel(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object' && 'name' in entry) {
    const link = entry as { name: string; reason?: string };
    return link.reason ? `${link.name} — ${link.reason}` : link.name;
  }
  return String(entry);
}

function constellationLabels(concept: Concept): string[] {
  return (concept.where_reappears as unknown[])
    .map(constellationLabel)
    .map(s => s.trim())
    .filter(Boolean);
}

// ─── Markdown ────────────────────────────────────────────────────────────────

export function toMarkdown(data: ConceptExportData): string {
  const { concept, sourceTitle, notes, equations } = data;
  const lines: string[] = [];

  lines.push(`# ${concept.name}`, '');

  const meta: string[] = [`**Importance:** ${concept.importance}`];
  if (concept.tags.length > 0) meta.push(`**Tags:** ${concept.tags.join(', ')}`);
  meta.push(`**Source:** ${sourceTitle}`);
  lines.push(meta.join('  \n'), '');

  const section = (heading: string, body: string | undefined | null): void => {
    const text = (body ?? '').trim();
    if (!text) return;
    lines.push(`## ${heading}`, '', text, '');
  };

  section('Definition', concept.definition_text);
  section('Why it exists', concept.why_exists);
  section('What breaks without it', concept.what_breaks);

  const constellations = constellationLabels(concept);
  if (constellations.length > 0) {
    lines.push('## Constellations', '');
    for (const c of constellations) lines.push(`- ${c}`);
    lines.push('');
  }

  if (equations.length > 0) {
    lines.push('## Equations', '');
    for (const eq of equations) {
      if (eq.attached_term) lines.push(`*${eq.attached_term}*`, '');
      lines.push('$$', eq.latex, '$$', '');
    }
  }

  if (notes.length > 0) {
    lines.push('## Notes', '');
    for (const note of notes) {
      if (note.heading.trim()) lines.push(`### ${note.heading.trim()}`, '');
      const body = note.body.trim();
      if (body) lines.push(body, '');
    }
  }

  // Collapse the trailing blank line into a single terminating newline.
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

// ─── Anki (tab-separated import file) ────────────────────────────────────────

// Anki's text importer reads one note per line, fields separated by tabs. We
// emit a single Front/Back card per concept. html:true lets us use <br> and
// MathJax delimiters (\( \) / \[ \]) in the Back field.

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// A single field value: strip tabs (the column separator), escape HTML, and
// turn newlines into <br> so multi-line content survives the one-line-per-note
// format.
function ankiField(s: string): string {
  return htmlEscape(s.replace(/\t/g, ' '))
    .replace(/\r?\n/g, '<br>')
    .trim();
}

export function toAnki(data: ConceptExportData): string {
  const { concept, equations } = data;

  const back: string[] = [];
  const block = (label: string, body: string | undefined | null): void => {
    const text = (body ?? '').trim();
    if (!text) return;
    back.push(`<b>${label}:</b> ${ankiField(text)}`);
  };

  block('Definition', concept.definition_text);
  block('Why it exists', concept.why_exists);
  block('What breaks', concept.what_breaks);

  const constellations = constellationLabels(concept);
  if (constellations.length > 0) {
    back.push(`<b>Constellations:</b> ${constellations.map(ankiField).join('; ')}`);
  }

  for (const eq of equations) {
    // LaTeX is left raw inside MathJax display delimiters (not HTML-escaped).
    const caption = eq.attached_term ? `${ankiField(eq.attached_term)}: ` : '';
    back.push(`${caption}\\[${eq.latex.replace(/\t/g, ' ').replace(/\r?\n/g, ' ')}\\]`);
  }

  const front = ankiField(concept.name);
  const backField = back.join('<br><br>');
  const tags = concept.tags.map(t => t.replace(/\s+/g, '_')).join(' ');

  const header = ['#separator:tab', '#html:true', '#columns:Front\tBack\tTags'];
  const row = [front, backField, ankiField(tags)].join('\t');
  return `${header.join('\n')}\n${row}\n`;
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export function renderConceptExport(data: ConceptExportData, format: ExportFormat): RenderedExport {
  return format === 'anki'
    ? { content: toAnki(data), extension: 'txt' }
    : { content: toMarkdown(data), extension: 'md' };
}
