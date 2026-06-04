import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// API keys are NEVER inlined at build time. A prior version used a `define`
// block that string-substituted the local `.env` GROQ_API_KEY into the compiled
// main bundle — which would bake a developer's key into the shipped portable
// `.exe` (extractable with `strings`). Keys now come from OS-encrypted settings
// (safeStorage) at runtime, with an optional dev-only `process.env` fallback the
// main process reads at startup (see loadDevDotenv in src/main/index.ts).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
});
