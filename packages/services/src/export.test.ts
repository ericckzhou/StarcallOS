import { describe, it, expect } from 'vitest';
import { toMarkdown, toAnki, renderConceptExport, type ConceptExportData } from './export';
import type { Concept, ConceptNote } from './core/domain/types';
import type { StoredEquationCandidate } from './knowledge/repos/candidates';

function makeConcept(overrides: Partial<Concept> = {}): Concept {
  return {
    id: 1,
    source_id: 7,
    name: 'Gradient Descent',
    slug: 'gradient-descent',
    importance: 'core',
    definition_text: 'An iterative optimization algorithm.',
    why_exists: 'To minimize a loss function.',
    what_breaks: 'Models never converge.',
    where_reappears: [],
    tags: [],
    chunk_ids: [],
    section_path: [],
    exam_value: 0.5,
    misconception_risk: 0.3,
    centrality_score: 0.4,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeData(overrides: Partial<ConceptExportData> = {}): ConceptExportData {
  return {
    concept: makeConcept(),
    sourceTitle: 'Deep Learning',
    notes: [],
    equations: [],
    srs: null,
    ...overrides,
  };
}

const equation: StoredEquationCandidate = {
  id: 1,
  source_id: 7,
  created_at: '2026-01-01T00:00:00Z',
  latex: 'w := w - \\eta \\nabla L',
  variables: ['w', 'eta'],
  page: 3,
  reading_order: 0,
  section_path: [],
  attached_term: 'gradient descent',
};

const note: ConceptNote = {
  id: 1,
  concept_id: 1,
  position: 0,
  heading: 'Intuition',
  body: 'Roll downhill.',
  linked_annotation_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('toMarkdown', () => {
  it('renders the title, metadata, and the three core sections', () => {
    const md = toMarkdown(makeData());
    expect(md).toContain('# Gradient Descent');
    expect(md).toContain('**Importance:** core');
    expect(md).toContain('**Source:** Deep Learning');
    expect(md).toContain('## Definition\n\nAn iterative optimization algorithm.');
    expect(md).toContain('## Why it exists');
    expect(md).toContain('## What breaks without it');
  });

  it('omits empty sections (no Equations/Notes/Constellations headings)', () => {
    const md = toMarkdown(makeData());
    expect(md).not.toContain('## Equations');
    expect(md).not.toContain('## Notes');
    expect(md).not.toContain('## Constellations');
  });

  it('omits a section whose body is blank', () => {
    const md = toMarkdown(makeData({ concept: makeConcept({ what_breaks: '   ' }) }));
    expect(md).not.toContain('## What breaks without it');
  });

  it('renders constellations from both {name, reason} objects and bare strings', () => {
    const concept = makeConcept({
      where_reappears: [
        { name: 'Backpropagation', reason: 'supplies the gradients' },
        'Momentum',
      ] as unknown as string[],
    });
    const md = toMarkdown(makeData({ concept }));
    expect(md).toContain('## Constellations');
    expect(md).toContain('- Backpropagation — supplies the gradients');
    expect(md).toContain('- Momentum');
  });

  it('renders equations in $$ display math and includes notes', () => {
    const md = toMarkdown(makeData({ equations: [equation], notes: [note] }));
    expect(md).toContain('## Equations');
    expect(md).toContain('$$\nw := w - \\eta \\nabla L\n$$');
    expect(md).toContain('## Notes');
    expect(md).toContain('### Intuition');
    expect(md).toContain('Roll downhill.');
  });

  it('lists tags when present', () => {
    const md = toMarkdown(makeData({ concept: makeConcept({ tags: ['optimization', 'training'] }) }));
    expect(md).toContain('**Tags:** optimization, training');
  });
});

describe('toAnki', () => {
  it('emits the import header and a single tab-separated Front/Back/Tags row', () => {
    const out = toAnki(makeData());
    // Don't trimEnd before splitting: an empty trailing Tags field ends the row
    // with a literal tab, which trimEnd() would strip (collapsing a column).
    const lines = out.split('\n');
    expect(lines[0]).toBe('#separator:tab');
    expect(lines[1]).toBe('#html:true');
    expect(lines[2]).toBe('#columns:Front\tBack\tTags');
    const row = lines[3].split('\t');
    expect(row).toHaveLength(3);
    expect(row[0]).toBe('Gradient Descent');
    expect(row[1]).toContain('<b>Definition:</b> An iterative optimization algorithm.');
  });

  it('escapes tabs (→ space) and newlines (→ <br>) so a field never breaks the row', () => {
    const concept = makeConcept({ what_breaks: 'Line one\nLine two\twith tab' });
    const out = toAnki(makeData({ concept }));
    const row = out.split('\n')[3].split('\t');
    expect(row).toHaveLength(3); // the embedded tab did not create a 4th column
    expect(row[1]).toContain('Line one<br>Line two with tab');
  });

  it('HTML-escapes angle brackets and ampersands in field text', () => {
    const concept = makeConcept({ definition_text: 'if x < y && y > 0' });
    const out = toAnki(makeData({ concept }));
    expect(out).toContain('if x &lt; y &amp;&amp; y &gt; 0');
  });

  it('wraps equation LaTeX in MathJax \\[ \\] delimiters, left raw', () => {
    const out = toAnki(makeData({ equations: [equation] }));
    expect(out).toContain('\\[w := w - \\eta \\nabla L\\]');
  });

  it('joins tags with spaces and underscores multi-word tags', () => {
    const concept = makeConcept({ tags: ['optimization', 'first order'] });
    const row = toAnki(makeData({ concept })).split('\n')[3].split('\t');
    expect(row[2]).toBe('optimization first_order');
  });
});

describe('renderConceptExport', () => {
  it('selects the Markdown formatter and .md extension', () => {
    const r = renderConceptExport(makeData(), 'markdown');
    expect(r.extension).toBe('md');
    expect(r.content).toContain('# Gradient Descent');
  });

  it('selects the Anki formatter and .txt extension', () => {
    const r = renderConceptExport(makeData(), 'anki');
    expect(r.extension).toBe('txt');
    expect(r.content).toContain('#separator:tab');
  });
});
