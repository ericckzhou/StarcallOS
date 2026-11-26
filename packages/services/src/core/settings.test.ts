import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SettingsPatchSchema } from './ipc-schemas';
import { loadSettings, saveSettings, migrateSecretsAtRest, sanitizeSettingsInput, resolveProviderConfig, mergeSettingsPatch, MODEL_CHOICES, loadSettingsAsync, saveSettingsAsync, type LLMSettings, type SecretCodec, type AsyncSecretCodec } from './settings';

// Reversible stand-in for Electron safeStorage (which is unavailable in tests).
const fakeCodec: SecretCodec = {
  available: true,
  encrypt: (plain) => Buffer.from(`v1:${plain}`, 'utf-8').toString('base64'),
  decrypt: (b64) => {
    const t = Buffer.from(b64, 'base64').toString('utf-8');
    if (!t.startsWith('v1:')) throw new Error('bad ciphertext');
    return t.slice(3);
  },
};

function base(overrides: Partial<LLMSettings> = {}): LLMSettings {
  return {
    provider: 'groq', groqApiKey: '', anthropicApiKey: '',
    modelOverrides: {}, extractionMode: 'deterministic', ...overrides,
  };
}

describe('settings secret storage', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starcall-settings-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('encrypts API keys on disk and round-trips them with the codec', () => {
    saveSettings(dir, base({ groqApiKey: 'gsk_secret', anthropicApiKey: 'sk-ant-secret' }), fakeCodec);

    const onDiskRaw = fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8');
    // The plaintext key must never appear in the file.
    expect(onDiskRaw).not.toContain('gsk_secret');
    expect(onDiskRaw).not.toContain('sk-ant-secret');
    const parsed = JSON.parse(onDiskRaw);
    expect(parsed.groqApiKey).toMatchObject({ enc: expect.any(String) });

    const loaded = loadSettings(dir, fakeCodec);
    expect(loaded.groqApiKey).toBe('gsk_secret');
    expect(loaded.anthropicApiKey).toBe('sk-ant-secret');
  });

  it('cannot recover an encrypted key without the codec', () => {
    saveSettings(dir, base({ groqApiKey: 'gsk_secret' }), fakeCodec);
    const loaded = loadSettings(dir); // no codec — simulates a different OS user / no keyring
    expect(loaded.groqApiKey).toBe('');
  });

  it('reads legacy plaintext keys and migrates them to encrypted on next save', () => {
    // Simulate a pre-encryption settings.json with a raw string key.
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ provider: 'groq', groqApiKey: 'legacy_plain', anthropicApiKey: '' }, null, 2),
    );

    const loaded = loadSettings(dir, fakeCodec);
    expect(loaded.groqApiKey).toBe('legacy_plain'); // still readable

    saveSettings(dir, loaded, fakeCodec); // migrate
    const onDiskRaw = fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8');
    expect(onDiskRaw).not.toContain('legacy_plain');
    expect(JSON.parse(onDiskRaw).groqApiKey).toMatchObject({ enc: expect.any(String) });
  });

  it('migrateSecretsAtRest encrypts a legacy plaintext key and is idempotent', () => {
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ provider: 'groq', groqApiKey: 'legacy_plain', anthropicApiKey: '' }, null, 2),
    );

    expect(migrateSecretsAtRest(dir, fakeCodec)).toBe(true);
    const after = fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8');
    expect(after).not.toContain('legacy_plain');
    expect(JSON.parse(after).groqApiKey).toMatchObject({ enc: expect.any(String) });
    expect(loadSettings(dir, fakeCodec).groqApiKey).toBe('legacy_plain');

    // Second run is a no-op (already enveloped).
    expect(migrateSecretsAtRest(dir, fakeCodec)).toBe(false);
  });

  it('falls back to plaintext when the codec is unavailable (no keyring)', () => {
    const unavailable: SecretCodec = { ...fakeCodec, available: false };
    saveSettings(dir, base({ groqApiKey: 'gsk_plain' }), unavailable);
    // Stored as plaintext so the key is not lost; still loadable without a codec.
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).groqApiKey).toBe('gsk_plain');
    expect(loadSettings(dir).groqApiKey).toBe('gsk_plain');
  });
});

describe('settings secret storage (async codec)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starcall-settings-async-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  // Same ciphertext format as fakeCodec, so the sync and async paths interoperate
  // (as Electron's decryptStringAsync reads encryptString output).
  const asyncCodec = (reencrypt = false, available = true): AsyncSecretCodec => ({
    available,
    encrypt: async (plain) => fakeCodec.encrypt(plain),
    decrypt: async (b64) => ({ plain: fakeCodec.decrypt(b64), reencrypt }),
  });
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'));

  it('round-trips encrypted keys and leaves no temp file', async () => {
    await saveSettingsAsync(dir, base({ groqApiKey: 'gsk_a', anthropicApiKey: 'sk-ant-b' }), asyncCodec());
    expect(onDisk().groqApiKey).toHaveProperty('enc');
    expect(fs.existsSync(path.join(dir, 'settings.json.tmp'))).toBe(false);
    const r = await loadSettingsAsync(dir, asyncCodec());
    expect(r.settings.groqApiKey).toBe('gsk_a');
    expect(r.settings.anthropicApiKey).toBe('sk-ant-b');
    expect(r.needsResave).toBe(false);
  });

  it('reads keys written by the sync codec', async () => {
    saveSettings(dir, base({ groqApiKey: 'gsk_old' }), fakeCodec);
    expect((await loadSettingsAsync(dir, asyncCodec())).settings.groqApiKey).toBe('gsk_old');
  });

  it('flags legacy plaintext keys and keys the OS wants re-encrypted', async () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(base({ groqApiKey: 'gsk_plain' })));
    const plain = await loadSettingsAsync(dir, asyncCodec());
    expect(plain).toMatchObject({ needsResave: true, settings: { groqApiKey: 'gsk_plain' } });
    await saveSettingsAsync(dir, plain.settings, asyncCodec());
    expect(onDisk().groqApiKey).toHaveProperty('enc');
    expect((await loadSettingsAsync(dir, asyncCodec())).needsResave).toBe(false);
    expect((await loadSettingsAsync(dir, asyncCodec(true))).needsResave).toBe(true);
  });

  it('keeps plaintext when no keyring, without asking for a re-save', async () => {
    await saveSettingsAsync(dir, base({ groqApiKey: 'gsk_plain' }), asyncCodec(false, false));
    expect(onDisk().groqApiKey).toBe('gsk_plain');
    expect(await loadSettingsAsync(dir, asyncCodec(false, false))).toMatchObject({ needsResave: false, settings: { groqApiKey: 'gsk_plain' } });
  });

  it('returns an empty key (not a crash) when decryption fails', async () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ...base(), groqApiKey: { enc: 'garbage' } }));
    expect((await loadSettingsAsync(dir, asyncCodec())).settings.groqApiKey).toBe('');
  });
});

describe('sanitizeSettingsInput', () => {
  const current = base({ provider: 'anthropic', extractionMode: 'candidate_gated' });

  it('clamps an unknown provider to the current value (prevents MODEL_CHOICES crash)', () => {
    const out = sanitizeSettingsInput({ provider: 'openai' as never }, current);
    expect(out.provider).toBe('anthropic');
  });

  it('clamps an unknown extractionMode to the current value', () => {
    const out = sanitizeSettingsInput({ extractionMode: 'turbo' as never }, current);
    expect(out.extractionMode).toBe('candidate_gated');
  });

  it('passes valid enum values through unchanged', () => {
    const out = sanitizeSettingsInput({ provider: 'groq', extractionMode: 'full' }, current);
    expect(out.provider).toBe('groq');
    expect(out.extractionMode).toBe('full');
  });

  it('drops unknown pass keys and blank override values, trims the rest', () => {
    const out = sanitizeSettingsInput({
      modelOverrides: { grader: '  claude-x  ', lazy_tasks: '   ', ask: 'qwen', bogus: 'm' } as never,
    }, current);
    expect(out.modelOverrides).toEqual({ grader: 'claude-x' });
  });

  it('an override for the current provider wins over the class default; others are ignored', () => {
    const anthropic = MODEL_CHOICES.anthropic;
    const pick = [...anthropic.heavy, ...anthropic.light].find(m => m !== anthropic.heavy[0])!;
    const s = base({ provider: 'anthropic', anthropicApiKey: 'k', heavyModel: anthropic.heavy[0], modelOverrides: { grader: pick, lazy_tasks: MODEL_CHOICES.groq.heavy[0] } });
    expect(resolveProviderConfig(s, 'grader').model).toBe(pick);
    expect(resolveProviderConfig(s, 'lazy_tasks').model).toBe(anthropic.heavy[0]);
  });

  it('leaves absent fields absent so the caller merge is unaffected', () => {
    const out = sanitizeSettingsInput({ groqApiKey: 'gsk_x' }, current);
    expect('modelOverrides' in out).toBe(false);
    expect('provider' in out).toBe(false);
    expect('extractionMode' in out).toBe(false);
    expect(out.groqApiKey).toBe('gsk_x');
  });

  it('does not touch model fields (resolveProviderConfig handles bad models at read)', () => {
    const out = sanitizeSettingsInput({ heavyModel: 'not-a-real-model' }, current);
    expect(out.heavyModel).toBe('not-a-real-model');
  });
});

describe('local provider settings', () => {
  it('resolves one local model for every pass without an API key', () => {
    const s = { provider: 'local' as const, groqApiKey: '', anthropicApiKey: '', localBaseUrl: 'http://10.0.0.5:8080/v1/', localModel: 'qwen2.5:14b' };
    expect(resolveProviderConfig(s, 'grader')).toEqual({ provider: 'local', apiKey: '', model: 'qwen2.5:14b', baseUrl: 'http://10.0.0.5:8080/v1' });
    expect(resolveProviderConfig({ ...s, localBaseUrl: undefined, localModel: '' }, 'structure')).toMatchObject({ model: 'llama3.1:8b', baseUrl: 'http://127.0.0.1:11434/v1' });
  });

  it('sanitizes the base URL, keeping the saved one when invalid', () => {
    const current = { provider: 'local' as const, groqApiKey: '', anthropicApiKey: '', localBaseUrl: 'http://127.0.0.1:11434/v1' };
    expect(sanitizeSettingsInput({ localBaseUrl: 'javascript:alert(1)' }, current).localBaseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(sanitizeSettingsInput({ localBaseUrl: 'http://box:1234/v1/' }, current).localBaseUrl).toBe('http://box:1234/v1');
    expect(sanitizeSettingsInput({ provider: 'local' }, { ...current, provider: 'groq' }).provider).toBe('local');
  });
});

describe('mergeSettingsPatch', () => {
  const current: LLMSettings = {
    provider: 'groq', groqApiKey: 'gk', anthropicApiKey: 'ak', modelOverrides: {}, extractionMode: 'deterministic',
    heavyModel: 'h', embeddingsEnabled: false, srsScheduler: 'sm2',
  };
  it('persists every patched field, including ones added after the original merge', () => {
    const next = mergeSettingsPatch(current, {
      gradeSelfConsistency: true, localBaseUrl: 'http://box:1/v1', localModel: 'm',
      embeddingsEnabled: true, embeddingModel: 'e', srsScheduler: 'fsrs',
    });
    expect(next).toMatchObject({
      gradeSelfConsistency: true, localBaseUrl: 'http://box:1/v1', localModel: 'm',
      embeddingsEnabled: true, embeddingModel: 'e', srsScheduler: 'fsrs',
    });
  });
  it('keeps saved values (incl. API keys) for absent or undefined fields', () => {
    const next = mergeSettingsPatch(current, { provider: 'anthropic', groqApiKey: undefined });
    expect(next).toMatchObject({ provider: 'anthropic', groqApiKey: 'gk', anthropicApiKey: 'ak', heavyModel: 'h', srsScheduler: 'sm2' });
  });
  it('lets an explicit empty key clear a stored key', () => {
    expect(mergeSettingsPatch(current, { groqApiKey: '' }).groqApiKey).toBe('');
  });
});

describe('settings save pipeline (SettingsPatchSchema -> sanitize -> merge)', () => {
  it('persists every patchable key', () => {
    const patch = {
      provider: 'local', groqApiKey: 'g2', anthropicApiKey: 'a2', modelOverrides: { grader: 'x' },
      extractionMode: 'full', heavyModel: 'h2', lightModel: 'l2', gradeSelfConsistency: true,
      localBaseUrl: 'http://box:1/v1', localModel: 'm', embeddingsEnabled: true, embeddingModel: 'e',
      srsScheduler: 'fsrs', pdfParser: 'docling', doclingBaseUrl: 'http://box:5001',
    } as const;
    // Every key the schema accepts must be exercised here, so a newly added
    // setting that the schema strips (or the merge drops) fails this test.
    expect(Object.keys(patch).sort()).toEqual(Object.keys(SettingsPatchSchema.shape).sort());
    const current: LLMSettings = { provider: 'groq', groqApiKey: '', anthropicApiKey: '' };
    const next = mergeSettingsPatch(current, sanitizeSettingsInput(SettingsPatchSchema.parse(patch), current));
    for (const [k, v] of Object.entries(patch)) expect(next[k as keyof LLMSettings]).toEqual(v);
  });

  it('clamps an unknown PDF parser to builtin and keeps the saved Docling URL on bad input', () => {
    const current: LLMSettings = { provider: 'groq', groqApiKey: '', anthropicApiKey: '', doclingBaseUrl: 'http://127.0.0.1:5001' };
    expect(sanitizeSettingsInput({ pdfParser: 'bogus' as never }, current).pdfParser).toBe('builtin');
    expect(sanitizeSettingsInput({ doclingBaseUrl: 'ftp://x' }, current).doclingBaseUrl).toBe('http://127.0.0.1:5001');
    expect(sanitizeSettingsInput({ doclingBaseUrl: '  ' }, current).doclingBaseUrl).toBe('');
    expect(sanitizeSettingsInput({ doclingBaseUrl: 'http://box:5001/' }, current).doclingBaseUrl).toBe('http://box:5001');
  });

  it('clamps an unknown scheduler to sm2 and trims the embedding model', () => {
    const current: LLMSettings = { provider: 'groq', groqApiKey: '', anthropicApiKey: '' };
    const out = sanitizeSettingsInput({ srsScheduler: 'bogus' as never, embeddingModel: '  nomic  ' }, current);
    expect(out).toMatchObject({ srsScheduler: 'sm2', embeddingModel: 'nomic' });
  });
});
