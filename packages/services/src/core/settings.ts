// Persisted user settings — provider choice + API keys + per-pass model overrides.
// Stored as JSON in Electron's userData dir. The desktop main process owns the
// file; renderer reads/writes via IPC and never sees raw secrets in flight.

import fs from 'fs';
import path from 'path';
import { DEFAULT_MODELS, type ProviderConfig, type ProviderId } from './llm';

export type PassName =
  | 'enrich'
  | 'structure'
  | 'chunker'
  | 'concepts'
  | 'graph'
  | 'misconceptions'
  | 'tasks'
  | 'lazy_tasks'
  | 'grader';

// Each pass falls into a "weight class". heavy = quality matters (enrich,
// concepts, misconceptions, grader). light = mechanical/cheap (structure,
// graph). The setting picks one model per class per provider.
const HEAVY_PASSES: PassName[] = [
  'enrich', 'chunker', 'concepts', 'misconceptions', 'tasks', 'lazy_tasks', 'grader',
];

export type ExtractionMode = 'deterministic' | 'candidate_gated' | 'full';

export interface LLMSettings {
  provider: ProviderId;
  groqApiKey: string;
  anthropicApiKey: string;
  // Optional per-pass overrides; falls back to {heavy,light}Model, then DEFAULT_MODELS.
  modelOverrides?: Partial<Record<PassName, string>>;
  // Provider-scoped class defaults. Picked from a curated list in Settings UI.
  // null/undefined → DEFAULT_MODELS[provider].{heavy,light}
  heavyModel?: string;
  lightModel?: string;
  // deterministic     = no LLM at process time. Candidates are the product.
  // candidate_gated   = enrich only blocks near top-N candidate pages.
  // full              = send every block through the enricher (legacy).
  extractionMode?: ExtractionMode;
}

function defaults(): LLMSettings {
  return {
    provider: 'groq',
    groqApiKey: '',
    anthropicApiKey: '',
    modelOverrides: {},
    extractionMode: 'deterministic',
  };
}

function settingsPath(userDataDir: string): string {
  return path.join(userDataDir, 'settings.json');
}

export function loadSettings(userDataDir: string): LLMSettings {
  const p = settingsPath(userDataDir);
  if (!fs.existsSync(p)) return defaults();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<LLMSettings>;
    return { ...defaults(), ...raw };
  } catch {
    return defaults();
  }
}

export function saveSettings(userDataDir: string, s: LLMSettings): void {
  const p = settingsPath(userDataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf-8');
}

export function applyEnvFallbacks(s: LLMSettings, env: { groq?: string; anthropic?: string }): LLMSettings {
  return {
    ...s,
    groqApiKey:      s.groqApiKey      || env.groq      || '',
    anthropicApiKey: s.anthropicApiKey || env.anthropic || '',
  };
}

// Returns true if `model` is one of the curated choices for `provider`.
// Used to reject cross-provider leakage when user saves an Anthropic model
// then flips provider to Groq (or vice versa).
function isModelForProvider(model: string | undefined, provider: ProviderId): boolean {
  if (!model) return false;
  const choices = MODEL_CHOICES[provider];
  return choices.heavy.includes(model) || choices.light.includes(model);
}

export function resolveProviderConfig(s: LLMSettings, pass: PassName): ProviderConfig {
  const apiKey = s.provider === 'groq' ? s.groqApiKey : s.anthropicApiKey;
  if (!apiKey) {
    throw new Error(
      `No API key configured for provider "${s.provider}". Set it in Settings.`,
    );
  }
  const override = s.modelOverrides?.[pass];
  const klass = HEAVY_PASSES.includes(pass) ? 'heavy' : 'light';

  // Honor saved heavy/light only if they belong to the current provider;
  // otherwise fall through to the provider's default so a Groq run never
  // tries to call an Anthropic model name.
  const savedHeavy = isModelForProvider(s.heavyModel, s.provider) ? s.heavyModel! : undefined;
  const savedLight = isModelForProvider(s.lightModel, s.provider) ? s.lightModel! : undefined;
  const classDefault = klass === 'heavy'
    ? (savedHeavy ?? DEFAULT_MODELS[s.provider].heavy)
    : (savedLight ?? DEFAULT_MODELS[s.provider].light);

  // Per-pass override only honored if it belongs to current provider.
  const overrideValid = isModelForProvider(override, s.provider) ? override : undefined;
  const model = overrideValid ?? classDefault;
  return { provider: s.provider, apiKey, model };
}

// Curated dropdown options for the Settings UI.
// Curated picks. Bump this list when a provider deprecates a model so the
// UI never offers (and the backend never selects) a 400-causing target.
export const MODEL_CHOICES: Record<ProviderId, { heavy: string[]; light: string[] }> = {
  groq: {
    heavy: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',           // also acceptable for heavy on low-budget runs
    ],
    light: [
      'llama-3.1-8b-instant',
    ],
  },
  anthropic: {
    heavy: [
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-opus-4-7',
    ],
    light: [
      'claude-haiku-4-5-20251001',
    ],
  },
};
