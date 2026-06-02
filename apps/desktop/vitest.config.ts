import { defineConfig } from 'vitest/config';

// Vitest runs only the unit tests under src/. The Playwright E2E specs in
// e2e/ are driven by `pnpm test:e2e` (playwright.config.ts); if Vitest picked
// them up it would try to execute Playwright's test.beforeAll under its own
// runner and fail with "did not expect test.beforeAll() to be called here".
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
