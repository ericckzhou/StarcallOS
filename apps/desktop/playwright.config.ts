import { defineConfig } from '@playwright/test';

// E2E harness for the Electron app. We do not use Playwright browser projects:
// each spec launches the built Electron main process via `_electron.launch`
// (see e2e/smoke.spec.ts). The app must be built first (`pnpm build`) so that
// out/main/index.js exists.
export default defineConfig({
  testDir: './e2e',
  // Electron launches are heavier than a browser context; give them room and
  // run serially to avoid multiple app instances contending for the per-user DB.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
