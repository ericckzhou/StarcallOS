import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

function readDotenv(): Record<string, string> {
  try {
    return Object.fromEntries(
      fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8')
        .split('\n')
        .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
    );
  } catch { return {}; }
}

const env = readDotenv();

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      'import.meta.env.GROQ_API_KEY': JSON.stringify(env['GROQ_API_KEY'] ?? ''),
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
});
