// Persisted user settings — provider choice + API keys + per-pass model overrides.
// Stored as JSON in Electron's userData dir. The desktop main process owns the
// file; renderer reads/writes via IPC and never sees raw secrets in flight.

import fs from 'fs';
import path from 'path';
import { DEFAULT_LOCAL_BASE_URL, DEFAULT_MODELS, normalizeLocalBaseUrl, type ProviderConfig, type ProviderId } from './llm';

export type PassName =
  | 'enrich'
  | 'structure'
  | 'chunker'
  | 'concepts'
  | 'graph'
  | 'misconceptions'
  | 'tasks'
  | 'lazy_tasks'
  | 'prereq_suggest'
  | 'grader'
  | 'ask';

// Each pass falls into a "weight class". heavy = quality matters (enrich,
// concepts, misconceptions, grader). light = mechanical/cheap (structure,
// graph). The setting picks one model per class per provider.
const HEAVY_PASSES: PassName[] = [
  'enrich', 'chunker', 'concepts', 'misconceptions', 'tasks', 'lazy_tasks', 'prereq_suggest', 'grader', 'ask',
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
  // Re-grade borderline answers (up to 3 grader calls) and aggregate.
  // undefined → provider default (see effectiveSelfConsistency).
  gradeSelfConsistency?: boolean;
  // provider === 'local': OpenAI-compatible server + model id (free text).
  localBaseUrl?: string;
  localModel?: string;
  // Opt-in local embeddings (OpenAI-compatible /embeddings at localBaseUrl,
  // independent of the chat provider). Off by default.
  embeddingsEnabled?: boolean;
  embeddingModel?: string;
  // Review scheduler. undefined → 'sm2'.
  srsScheduler?: 'sm2' | 'fsrs';
  // PDF parser. undefined → 'builtin'. 'docling' sends PDFs to the user's own
  // docling-serve at doclingBaseUrl and falls back to builtin on any failure.
  pdfParser?: 'builtin' | 'docling';
  doclingBaseUrl?: string;
}

// Default ON for Anthropic (cheap per call, no tight TPM), OFF for Groq (extra
// samples would eat low free-tier TPM budgets). An explicit user choice wins.
export function effectiveSelfConsistency(s: LLMSettings): boolean {
  return s.gradeSelfConsistency ?? s.provider === 'anthropic';
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

// API keys are never written to disk in plaintext when a codec is available.
// `packages/services` is Electron-free, so the desktop main process injects a
// codec backed by Electron `safeStorage` (OS-level: DPAPI / Keychain / libsecret).
// The in-memory `LLMSettings` shape stays plaintext strings; encryption happens
// only at the disk boundary.
export interface SecretCodec {
  available: boolean;
  encrypt(plain: string): string;  // returns base64 ciphertext
  decrypt(cipher: string): string; // takes base64 ciphertext
}

// On-disk a secret is either a legacy plaintext string or an encrypted envelope.
interface EncEnvelope { enc: string }
function isEnvelope(v: unknown): v is EncEnvelope {
  return typeof v === 'object' && v != null && typeof (v as EncEnvelope).enc === 'string';
}

function decodeKey(stored: unknown, codec?: SecretCodec): string {
  if (typeof stored === 'string') return stored;          // legacy plaintext (migrated on next save)
  if (isEnvelope(stored)) {
    if (!codec) return '';                                 // can't decrypt without the OS codec
    try { return codec.decrypt(stored.enc); } catch { return ''; }
  }
  return '';
}

function encodeKey(plain: string, codec?: SecretCodec): string | EncEnvelope {
  if (!plain) return '';                                   // don't encrypt an empty key
  if (codec?.available) {
    try { return { enc: codec.encrypt(plain) }; } catch { /* fall through to plaintext */ }
  }
  return plain;                                            // codec unavailable (e.g. no keyring)
}

export function loadSettings(userDataDir: string, codec?: SecretCodec): LLMSettings {
  const p = settingsPath(userDataDir);
  if (!fs.existsSync(p)) return defaults();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    return {
      ...defaults(),
      ...(raw as Partial<LLMSettings>),
      // Decrypt key fields last so they win over the raw envelope objects.
      groqApiKey:      decodeKey(raw.groqApiKey, codec),
      anthropicApiKey: decodeKey(raw.anthropicApiKey, codec),
    };
  } catch {
    return defaults();
  }
}

export function saveSettings(userDataDir: string, s: LLMSettings, codec?: SecretCodec): void {
  const p = settingsPath(userDataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const onDisk = {
    ...s,
    groqApiKey:      encodeKey(s.groqApiKey, codec),
    anthropicApiKey: encodeKey(s.anthropicApiKey, codec),
  };
  fs.writeFileSync(p, JSON.stringify(onDisk, null, 2), 'utf-8');
}

// One-time at-rest migration: if any key is still stored as legacy plaintext,
// re-save it encrypted. Idempotent — a no-op once keys are enveloped or the
// codec is unavailable. Call once at startup so an upgraded install doesn't
// leave a plaintext key on disk until the user next opens Settings. Returns
// true if it rewrote the file.
export function migrateSecretsAtRest(userDataDir: string, codec: SecretCodec): boolean {
  if (!codec.available) return false;
  const p = settingsPath(userDataDir);
  if (!fs.existsSync(p)) return false;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>; } catch { return false; }
  const isPlaintextKey = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
  if (!isPlaintextKey(raw.groqApiKey) && !isPlaintextKey(raw.anthropicApiKey)) return false;
  saveSettings(userDataDir, loadSettings(userDataDir, codec), codec);
  return true;
}

// Async variant of SecretCodec, matching Electron's async safeStorage API
// (`encryptStringAsync` / `decryptStringAsync`; the sync calls are deprecated).
// `decrypt` reports `reencrypt` when the OS rotated the key or offers a
// stronger one, so the caller can re-save the file.
export interface AsyncSecretCodec {
  available: boolean;
  encrypt(plain: string): Promise<string>;                                  // base64 ciphertext
  decrypt(cipher: string): Promise<{ plain: string; reencrypt: boolean }>;  // takes base64 ciphertext
}

async function decodeKeyAsync(stored: unknown, codec?: AsyncSecretCodec): Promise<{ plain: string; resave: boolean }> {
  if (typeof stored === 'string') {
    // Legacy plaintext: re-save encrypted once a codec can do it.
    return { plain: stored, resave: stored.length > 0 && !!codec?.available };
  }
  if (isEnvelope(stored)) {
    if (!codec) return { plain: '', resave: false };
    try {
      const r = await codec.decrypt(stored.enc);
      return { plain: r.plain, resave: r.reencrypt && !!codec.available };
    } catch {
      return { plain: '', resave: false };
    }
  }
  return { plain: '', resave: false };
}

async function encodeKeyAsync(plain: string, codec?: AsyncSecretCodec): Promise<string | EncEnvelope> {
  if (!plain) return '';
  if (codec?.available) {
    try { return { enc: await codec.encrypt(plain) }; } catch { /* fall through to plaintext */ }
  }
  return plain;
}

// Loads settings, decrypting keys with the async codec. `needsResave` is true
// when a key is still plaintext on disk (and a codec is available) or the OS
// asked for re-encryption; the caller should then `saveSettingsAsync` once.
export async function loadSettingsAsync(
  userDataDir: string, codec?: AsyncSecretCodec,
): Promise<{ settings: LLMSettings; needsResave: boolean }> {
  const p = settingsPath(userDataDir);
  if (!fs.existsSync(p)) return { settings: defaults(), needsResave: false };
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>; } catch { return { settings: defaults(), needsResave: false }; }
  const [groq, anthropic] = await Promise.all([decodeKeyAsync(raw.groqApiKey, codec), decodeKeyAsync(raw.anthropicApiKey, codec)]);
  return {
    settings: { ...defaults(), ...(raw as Partial<LLMSettings>), groqApiKey: groq.plain, anthropicApiKey: anthropic.plain },
    needsResave: groq.resave || anthropic.resave,
  };
}

export async function saveSettingsAsync(userDataDir: string, s: LLMSettings, codec?: AsyncSecretCodec): Promise<void> {
  const [groqApiKey, anthropicApiKey] = await Promise.all([encodeKeyAsync(s.groqApiKey, codec), encodeKeyAsync(s.anthropicApiKey, codec)]);
  const p = settingsPath(userDataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Write-then-rename so a crash mid-write never leaves a truncated file.
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...s, groqApiKey, anthropicApiKey }, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

const EXTRACTION_MODES: ExtractionMode[] = ['deterministic', 'candidate_gated', 'full'];

function isProviderId(v: unknown): v is ProviderId {
  return v === 'groq' || v === 'anthropic' || v === 'local';
}

// Defensive clamp for renderer-supplied settings before they are persisted.
// The renderer is bundled trusted code, but a UI bug — or a stale value already
// on disk — writing an unknown `provider` would corrupt settings.json and then
// crash EVERY later LLM call at `MODEL_CHOICES[provider]` (undefined.heavy).
// Unknown enum values fall back to the current saved value. Models are left
// alone on purpose: `resolveProviderConfig` already ignores out-of-roster models
// at read time, so they cannot crash anything. Returns a corrected copy of the
// input partial; absent fields stay absent so the caller's merge is unchanged.
export function sanitizeSettingsInput(
  input: Partial<LLMSettings>,
  current: LLMSettings,
): Partial<LLMSettings> {
  const out: Partial<LLMSettings> = { ...input };
  if (input.provider !== undefined) {
    out.provider = isProviderId(input.provider) ? input.provider : current.provider;
  }
  if (input.localBaseUrl !== undefined) {
    // Empty string clears back to the default; an invalid URL keeps the saved one.
    out.localBaseUrl = input.localBaseUrl.trim() === ''
      ? ''
      : (normalizeLocalBaseUrl(input.localBaseUrl) ?? current.localBaseUrl ?? '');
  }
  if (input.localModel !== undefined) {
    out.localModel = input.localModel.trim().slice(0, 200);
  }
  if (input.pdfParser !== undefined) {
    out.pdfParser = input.pdfParser === 'docling' ? 'docling' : 'builtin';
  }
  if (input.doclingBaseUrl !== undefined) {
    out.doclingBaseUrl = input.doclingBaseUrl.trim() === ''
      ? ''
      : (normalizeLocalBaseUrl(input.doclingBaseUrl) ?? current.doclingBaseUrl ?? '');
  }
  if (input.srsScheduler !== undefined) {
    out.srsScheduler = input.srsScheduler === 'fsrs' ? 'fsrs' : 'sm2';
  }
  if (input.embeddingModel !== undefined) {
    out.embeddingModel = input.embeddingModel.trim().slice(0, 200);
  }
  if (input.extractionMode !== undefined) {
    out.extractionMode = EXTRACTION_MODES.includes(input.extractionMode)
      ? input.extractionMode
      : (current.extractionMode ?? 'deterministic');
  }
  return out;
}

// Merge a validated + sanitized patch onto the saved settings. Every field the
// patch carries wins; absent fields keep their saved value. (An earlier inline
// merge in main listed fields one by one and silently dropped any new setting.)
export function mergeSettingsPatch(current: LLMSettings, input: Partial<LLMSettings>): LLMSettings {
  const defined = Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  ) as Partial<LLMSettings>;
  return {
    ...current,
    ...defined,
    modelOverrides: defined.modelOverrides ?? current.modelOverrides ?? {},
    extractionMode: defined.extractionMode ?? current.extractionMode ?? 'deterministic',
  };
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

// Ask (local RAG answers) is LOCAL-ONLY by design: retrieved source passages
// are sent only to the user's OpenAI-compatible server, never to a cloud
// provider, regardless of the main provider setting. Null when no local model
// is set and the main provider is not local (nothing to call).
export function resolveAskConfig(s: LLMSettings): ProviderConfig | null {
  const model = s.localModel?.trim();
  if (!model && s.provider !== 'local') return null;
  return {
    provider: 'local',
    apiKey: '',
    model: model || DEFAULT_MODELS.local.heavy,
    baseUrl: normalizeLocalBaseUrl(s.localBaseUrl) ?? DEFAULT_LOCAL_BASE_URL,
  };
}

export function resolveProviderConfig(s: LLMSettings, pass: PassName): ProviderConfig {
  if (s.provider === 'local') {
    // One model for every pass: local setups rarely run two models at once.
    return {
      provider: 'local',
      apiKey: '',
      model: s.localModel?.trim() || DEFAULT_MODELS.local.heavy,
      baseUrl: normalizeLocalBaseUrl(s.localBaseUrl) ?? DEFAULT_LOCAL_BASE_URL,
    };
  }
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
  // Local models are free text (Settings → Local model); no curated roster.
  local: { heavy: [], light: [] },
};
