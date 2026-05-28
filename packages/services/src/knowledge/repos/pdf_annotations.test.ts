import { describe, expect, it } from 'vitest';
import { openDb } from '../../core/infra/db';
import { createSource } from './sources';
import {
  createPdfAnnotation,
  listPdfAnnotationsBySource,
  restorePdfAnnotation,
  softDeletePdfAnnotation,
  updatePdfAnnotation,
} from './pdf_annotations';

describe('pdf_annotations repo', () => {
  it('creates and lists active annotations by source', () => {
    const db = openDb(':memory:');
    const sourceA = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const sourceB = createSource(db, { filename: 'b.pdf', file_path: 'b.pdf' });
    const created = createPdfAnnotation(db, {
      sourceId: sourceA.id,
      type: 'highlight',
      createdFrom: 'manual_selection',
      page: 3,
      selectedText: 'Gradient descent',
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
      pageWidth: 612,
      pageHeight: 792,
      rotation: 0,
    });
    createPdfAnnotation(db, {
      sourceId: sourceB.id,
      type: 'note',
      createdFrom: 'manual_note',
      page: 1,
      noteBody: 'Other source',
      rects: [{ x: 0.5, y: 0.5, width: 0.02, height: 0.02 }],
    });

    expect(listPdfAnnotationsBySource(db, sourceA.id)).toEqual([created]);
    expect(listPdfAnnotationsBySource(db, sourceB.id)).toHaveLength(1);
    db.close();
  });

  it('updates editable fields without overwriting selected text', () => {
    const db = openDb(':memory:');
    const source = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const created = createPdfAnnotation(db, {
      sourceId: source.id,
      type: 'highlight',
      createdFrom: 'manual_selection',
      page: 1,
      selectedText: 'Original quote',
      rects: [{ x: 0, y: 0, width: 0.2, height: 0.1 }],
    });
    const updated = updatePdfAnnotation(db, created.id, {
      label: 'Important',
      noteBody: 'Remember this',
      color: '#fde68a',
    });

    expect(updated).toMatchObject({
      id: created.id,
      selected_text: 'Original quote',
      label: 'Important',
      note_body: 'Remember this',
      color: '#fde68a',
    });
    db.close();
  });

  it('updates note coordinates without changing note text', () => {
    const db = openDb(':memory:');
    const source = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const created = createPdfAnnotation(db, {
      sourceId: source.id,
      type: 'note',
      createdFrom: 'manual_note',
      page: 1,
      noteBody: 'Drag me',
      rects: [{ x: 0.1, y: 0.2, width: 0.02, height: 0.02 }],
    });
    const updated = updatePdfAnnotation(db, created.id, {
      rects: [{ x: 0.7, y: 0.6, width: 0.02, height: 0.02 }],
      pageWidth: 700,
      pageHeight: 900,
      rotation: 0,
    });

    expect(updated?.note_body).toBe('Drag me');
    expect(updated?.rects).toEqual([{ x: 0.7, y: 0.6, width: 0.02, height: 0.02 }]);
    expect(updated?.page_width).toBe(700);
    expect(updated?.page_height).toBe(900);
    db.close();
  });

  it('allows notes to sit outside the pdf page bounds', () => {
    const db = openDb(':memory:');
    const source = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const created = createPdfAnnotation(db, {
      sourceId: source.id,
      type: 'note',
      createdFrom: 'manual_note',
      page: 1,
      noteBody: 'In the gutter',
      rects: [{ x: -0.18, y: 0.4, width: 0.02, height: 0.02 }],
    });

    expect(created.rects).toEqual([{ x: -0.18, y: 0.4, width: 0.02, height: 0.02 }]);
    const updated = updatePdfAnnotation(db, created.id, {
      rects: [{ x: 1.24, y: -0.08, width: 0.02, height: 0.02 }],
    });
    expect(updated?.rects).toEqual([{ x: 1.24, y: -0.08, width: 0.02, height: 0.02 }]);
    db.close();
  });

  it('soft deletes and restores annotations', () => {
    const db = openDb(':memory:');
    const source = createSource(db, { filename: 'a.pdf', file_path: 'a.pdf' });
    const created = createPdfAnnotation(db, {
      sourceId: source.id,
      type: 'note',
      createdFrom: 'manual_note',
      page: 2,
      noteBody: 'Sticky',
      rects: [{ x: 0.4, y: 0.4, width: 0.02, height: 0.02 }],
    });

    const deleted = softDeletePdfAnnotation(db, created.id);
    expect(deleted?.deleted_at).toBeTruthy();
    expect(listPdfAnnotationsBySource(db, source.id)).toEqual([]);
    expect(listPdfAnnotationsBySource(db, source.id, true)).toHaveLength(1);

    const restored = restorePdfAnnotation(db, created.id);
    expect(restored?.deleted_at).toBeNull();
    expect(listPdfAnnotationsBySource(db, source.id)).toHaveLength(1);
    db.close();
  });
});
