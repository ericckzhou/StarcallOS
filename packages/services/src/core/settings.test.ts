import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadSettings, saveSettings, migrateSecretsAtRest, sanitizeSettingsInput, type LLMSettings, type SecretCodec } from './settings';

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

  it('leaves absent fields absent so the caller merge is unaffected', () => {
    const out = sanitizeSettingsInput({ groqApiKey: 'gsk_x' }, current);
    expect('provider' in out).toBe(false);
    expect('extractionMode' in out).toBe(false);
    expect(out.groqApiKey).toBe('gsk_x');
  });

  it('does not touch model fields (resolveProviderConfig handles bad models at read)', () => {
    const out = sanitizeSettingsInput({ heavyModel: 'not-a-real-model' }, current);
    expect(out.heavyModel).toBe('not-a-real-model');
  });
});
