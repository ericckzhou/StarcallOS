/* eslint-disable @typescript-eslint/no-require-imports */
import type { DatabaseSync as _DatabaseSync } from 'node:sqlite';
type M = { DatabaseSync: typeof _DatabaseSync };
// require() is kept as-is by Vite; node:sqlite resolved at runtime by Node
export const DatabaseSync = (require('node:sqlite') as M).DatabaseSync;
export type { _DatabaseSync as DatabaseSync };
