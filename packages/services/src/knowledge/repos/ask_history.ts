// Per-concept Ask history (migration 0037). Each entry is one independent,
// already-validated AskResult; history is never fed back into a prompt.

import type { DatabaseSync } from '../../core/infra/sqlite';
import type { AskResult } from '../ask';

export interface AskHistoryEntry {
  id: number;
  concept_id: number;
  created_at: string;
  result: AskResult;
}

// Keep the newest N per concept so a heavily-used concept can't grow unbounded.
export const ASK_HISTORY_LIMIT = 50;

export function saveAskHistory(db: DatabaseSync, conceptId: number, result: AskResult): AskHistoryEntry {
  db.exec('BEGIN');
  try {
    const r = db.prepare(
      `INSERT INTO ask_history (concept_id, question, status, model, result_json) VALUES (?, ?, ?, ?, ?)`,
    ).run(conceptId, result.question, result.status, result.model, JSON.stringify(result));
    db.prepare(
      `DELETE FROM ask_history WHERE concept_id = ? AND id NOT IN (
         SELECT id FROM ask_history WHERE concept_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
    ).run(conceptId, conceptId, ASK_HISTORY_LIMIT);
    db.exec('COMMIT');
    const row = db.prepare(`SELECT created_at FROM ask_history WHERE id = ?`).get(Number(r.lastInsertRowid)) as { created_at: string };
    return { id: Number(r.lastInsertRowid), concept_id: conceptId, created_at: row.created_at, result };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function listAskHistory(db: DatabaseSync, conceptId: number, limit = ASK_HISTORY_LIMIT): AskHistoryEntry[] {
  const rows = db.prepare(
    `SELECT id, concept_id, created_at, result_json FROM ask_history
      WHERE concept_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(conceptId, limit) as Array<{ id: number; concept_id: number; created_at: string; result_json: string }>;
  const out: AskHistoryEntry[] = [];
  for (const r of rows) {
    try {
      out.push({ id: Number(r.id), concept_id: Number(r.concept_id), created_at: r.created_at, result: JSON.parse(r.result_json) as AskResult });
    } catch {
      // A corrupt row is skipped rather than breaking the whole list.
    }
  }
  return out;
}

export function deleteAskHistory(db: DatabaseSync, id: number): void {
  db.prepare(`DELETE FROM ask_history WHERE id = ?`).run(id);
}
