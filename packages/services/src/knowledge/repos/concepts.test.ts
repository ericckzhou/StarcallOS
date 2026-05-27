import { describe, expect, it } from 'vitest';
import { openDb } from '../../core/infra/db';
import { createSource } from './sources';
import { createConcept, searchConceptsByPrefix, searchConceptsByPrefixForConcept, searchConceptsByPrefixGlobal } from './concepts';

function seed(db: ReturnType<typeof openDb>) {
  const source = createSource(db, { filename: 'b.txt', file_path: 'b.txt' });
  const names: Array<[string, string, number]> = [
    ['Retriever',             'core',          0.9],
    ['Retrieval-Augmented Generation', 'core', 0.8],
    ['Retention',             'supporting',    0.5],
    ['Generator',             'core',          0.7],
    ['Foundation Model',      'foundational',  0.95],
  ];
  for (const [name, importance, centrality] of names) {
    createConcept(db, {
      source_id: source.id,
      name,
      slug: name.toLowerCase().replace(/\W+/g, '-'),
      importance: importance as 'core' | 'foundational' | 'supporting' | 'peripheral' | 'reference_only',
      definition_text: '',
      why_exists: '',
      what_breaks: '',
      where_reappears: [],
      chunk_ids: [],
      section_path: [],
      exam_value: 0,
      misconception_risk: 0,
      centrality_score: centrality,
    });
  }
  return source.id;
}

describe('searchConceptsByPrefix', () => {
  it('returns case-insensitive prefix matches on the same source', () => {
    const db = openDb(':memory:');
    const sourceId = seed(db);
    const hits = searchConceptsByPrefix(db, sourceId, 're');
    expect(hits.map(h => h.name).sort()).toEqual(
      ['Retention', 'Retrieval-Augmented Generation', 'Retriever'].sort(),
    );
    db.close();
  });

  it('orders results by centrality_score desc then name asc', () => {
    const db = openDb(':memory:');
    const sourceId = seed(db);
    const hits = searchConceptsByPrefix(db, sourceId, 'ret');
    expect(hits.map(h => h.name)).toEqual([
      'Retriever',                       // 0.9
      'Retrieval-Augmented Generation',  // 0.8
      'Retention',                       // 0.5
    ]);
    db.close();
  });

  it('returns nothing for an empty prefix', () => {
    const db = openDb(':memory:');
    const sourceId = seed(db);
    expect(searchConceptsByPrefix(db, sourceId, '   ')).toEqual([]);
    db.close();
  });

  it('honors the limit', () => {
    const db = openDb(':memory:');
    const sourceId = seed(db);
    expect(searchConceptsByPrefix(db, sourceId, 'r', 2)).toHaveLength(2);
    db.close();
  });

  it('escapes wildcard metacharacters in the prefix', () => {
    const db = openDb(':memory:');
    const sourceId = seed(db);
    // % must not act as a wildcard
    expect(searchConceptsByPrefix(db, sourceId, '%')).toEqual([]);
    db.close();
  });

  it('does not leak concepts from other sources', () => {
    const db = openDb(':memory:');
    const sourceA = seed(db);
    const sourceB = createSource(db, { filename: 'other.txt', file_path: 'other.txt' });
    createConcept(db, {
      source_id: sourceB.id,
      name: 'Retina',
      slug: 'retina',
      importance: 'core',
      definition_text: '',
      why_exists: '',
      what_breaks: '',
      where_reappears: [],
      chunk_ids: [],
      section_path: [],
      exam_value: 0,
      misconception_risk: 0,
      centrality_score: 0.99,
    });
    const hits = searchConceptsByPrefix(db, sourceA, 'ret');
    expect(hits.find(h => h.name === 'Retina')).toBeUndefined();
    db.close();
  });

  it('excludes the self concept when excludeConceptId is passed', () => {
    const db = openDb(':memory:');
    const sourceId = seed(db);
    const all = searchConceptsByPrefix(db, sourceId, 'ret');
    const self = all.find(h => h.name === 'Retriever')!;
    const filtered = searchConceptsByPrefix(db, sourceId, 'ret', 8, self.id);
    expect(filtered.find(h => h.id === self.id)).toBeUndefined();
    expect(filtered.length).toBe(all.length - 1);
    db.close();
  });
});

describe('searchConceptsByPrefixForConcept', () => {
  it('searches across sources and excludes self', () => {
    const db = openDb(':memory:');
    const sourceId = seed(db);
    const sourceB = createSource(db, { filename: 'other.txt', file_path: 'other.txt' });
    createConcept(db, {
      source_id: sourceB.id,
      name: 'Retina',
      slug: 'retina',
      importance: 'core',
      definition_text: '',
      why_exists: '',
      what_breaks: '',
      where_reappears: [],
      chunk_ids: [],
      section_path: [],
      exam_value: 0,
      misconception_risk: 0,
      centrality_score: 0.99,
    });
    const self = searchConceptsByPrefix(db, sourceId, 'retriever')[0];
    const hits = searchConceptsByPrefixForConcept(db, self.id, 'ret');
    expect(hits.find(h => h.id === self.id)).toBeUndefined();
    expect(hits.find(h => h.name === 'Retina')?.source_filename).toBe('other.txt');
    expect(hits.length).toBeGreaterThan(0);
    db.close();
  });

  it('returns empty for an unknown concept id', () => {
    const db = openDb(':memory:');
    seed(db);
    expect(searchConceptsByPrefixForConcept(db, 99999, 'ret')).toEqual([]);
    db.close();
  });
});

describe('searchConceptsByPrefixGlobal', () => {
  it('returns cross-source hits with source filenames', () => {
    const db = openDb(':memory:');
    seed(db);
    const sourceB = createSource(db, { filename: 'bible.pdf', file_path: 'bible.pdf' });
    createConcept(db, {
      source_id: sourceB.id,
      name: 'Genesis',
      slug: 'genesis',
      importance: 'supporting',
      definition_text: '',
      why_exists: '',
      what_breaks: '',
      where_reappears: [],
      chunk_ids: [],
      section_path: [],
      exam_value: 0,
      misconception_risk: 0,
      centrality_score: 0.4,
    });
    expect(searchConceptsByPrefixGlobal(db, 'gen').find(h => h.name === 'Genesis')).toMatchObject({
      name: 'Genesis',
      source_filename: 'bible.pdf',
    });
    db.close();
  });
});
