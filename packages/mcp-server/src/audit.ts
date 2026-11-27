// Metadata-only audit log (JSON lines). Records which tool ran, how long it
// took and how many items it returned — never query text or returned content.
// stdout is reserved for the MCP protocol and the DB handle is read-only, so
// this goes to its own file. Logging failures never break a tool call.

import fs from 'node:fs';
import path from 'node:path';

export interface AuditEntry {
  tool: string;
  ok: boolean;
  ms: number;
  results?: number;
  error?: string;
}

export interface AuditLog {
  record(e: AuditEntry): void;
}

const MAX_BYTES = 1_000_000;

export function createFileAuditLog(logPath: string): AuditLog {
  return {
    record(e) {
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        // Keep the file bounded: start over once it passes ~1 MB.
        if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_BYTES) {
          fs.renameSync(logPath, `${logPath}.1`);
        }
        fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');
      } catch {
        /* never fail a call because the log is unwritable */
      }
    },
  };
}
