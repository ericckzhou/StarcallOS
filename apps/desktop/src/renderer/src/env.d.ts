// Ambient declaration for the renderer's window.api bridge.
// The entire contract lives in @starcall/shared/src/index.ts (IpcApi).
// Update there; this file is a one-line projection.

import type { IpcApi } from '@starcall/shared';

declare global {
  interface Window {
    api: IpcApi;
  }
}

export {};
