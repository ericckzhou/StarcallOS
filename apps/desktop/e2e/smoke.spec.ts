import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';

// Smoke test: the built Electron app launches and renders its main window.
// This is the thinnest end-to-end check — it exercises the real main process,
// preload bridge, and renderer mount, but asserts nothing about features.

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  // The repo runs Electron from a terminal that sometimes carries
  // ELECTRON_RUN_AS_NODE=1 (used elsewhere to invoke Electron as plain Node).
  // With that set, `electron.launch` would start Node and never open a window,
  // so we strip it for the GUI launch.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== 'ELECTRON_RUN_AS_NODE' && v !== undefined) env[k] = v;
  }

  const appRoot = path.resolve(__dirname, '..');
  app = await electron.launch({
    args: ['.'], // reads package.json "main" → out/main/index.js
    cwd: appRoot,
    env,
  });

  // If the main process exits during startup, firstWindow() yields an
  // already-closing page and the test later fails with a cryptic
  // "Target page has been closed". The usual cause is a stale electron.exe
  // holding the per-user SQLite WAL lock (%APPDATA%/StarcallOS). Race the
  // window against an early exit so that failure is explicit and actionable.
  page = await Promise.race([
    app.firstWindow(),
    app.waitForEvent('close').then((): never => {
      throw new Error(
        'Electron exited during startup before opening a window. ' +
          'A stale instance is likely holding the per-user DB lock — ' +
          'kill leftover electron.exe processes and retry.',
      );
    }),
  ]);
});

test.afterAll(async () => {
  await app?.close();
});

test('main window renders the React root', async () => {
  await page.waitForLoadState('domcontentloaded');
  expect(await page.title()).toBe('StarcallOS');
  await expect(page.locator('#root')).toBeVisible();
});
