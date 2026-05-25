import React, { useEffect, useState } from 'react';

type ProviderId = 'groq' | 'anthropic';
type ExtractionMode = 'deterministic' | 'candidate_gated' | 'full';

interface Snapshot {
  provider: ProviderId;
  groqApiKeyConfigured: boolean;
  anthropicApiKeyConfigured: boolean;
  modelOverrides: Record<string, string>;
  extractionMode: ExtractionMode;
  heavyModel: string;
  lightModel: string;
  modelChoices: Record<ProviderId, { heavy: string[]; light: string[] }>;
}

const PROVIDER_INFO: Record<ProviderId, { label: string; tagline: string }> = {
  groq: {
    label: 'Groq',
    tagline: 'Free tier — 100K TPD / 12K TPM. Fast llama models. Good for prototyping.',
  },
  anthropic: {
    label: 'Anthropic',
    tagline: 'Paid. Tier 1: 50 RPM / 40K ITPM. No daily cap. Better quality on extraction.',
  },
};

const MODE_INFO: Record<ExtractionMode, { label: string; desc: string; accent: string }> = {
  deterministic: {
    label: 'Deterministic',
    accent: '#22c55e',
    desc: 'No LLM at process time. Candidates ARE the concepts. Promote what you want; tasks generate lazily on first review. Fast, cheap, daily-use default.',
  },
  candidate_gated: {
    label: 'Candidate-gated (compare)',
    accent: '#818cf8',
    desc: 'Runs candidate parser AND LLM enrichment on top-N candidate evidence pages. Use for comparing deterministic concepts against LLM-extracted concepts.',
  },
  full: {
    label: 'Full (legacy)',
    accent: '#f59e0b',
    desc: 'Sends every block through the enricher. Expensive on long docs. Use as a benchmark only.',
  },
};

export default function SettingsPane() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [groqKey, setGroqKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [provider, setProvider] = useState<ProviderId>('groq');
  const [extractionMode, setExtractionMode] = useState<ExtractionMode>('deterministic');
  const [heavyModel, setHeavyModel] = useState('');
  const [lightModel, setLightModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    window.api.settings.get().then(s => {
      setSnap(s);
      setProvider(s.provider);
      setExtractionMode(s.extractionMode);
      setHeavyModel(s.heavyModel);
      setLightModel(s.lightModel);
    });
  }, []);

  // Auto-save non-secret settings the moment they change. Keys still need the
  // explicit "Save API Keys" button below (blank input means "keep current",
  // so we don't want auto-save wiping a stored key on first focus).
  async function autoSave(patch: { provider?: ProviderId; extractionMode?: ExtractionMode; heavyModel?: string; lightModel?: string }): Promise<void> {
    try {
      await window.api.settings.set(patch);
      const fresh = await window.api.settings.get();
      setSnap(fresh);
    } catch (e) {
      setMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function pickProvider(p: ProviderId): void {
    setProvider(p);
    autoSave({ provider: p });
  }
  function pickMode(m: ExtractionMode): void {
    setExtractionMode(m);
    autoSave({ extractionMode: m });
  }
  function pickHeavy(m: string): void {
    setHeavyModel(m);
    autoSave({ heavyModel: m });
  }

  async function saveKeys(): Promise<void> {
    if (!groqKey && !anthropicKey) {
      setMsg('No new keys entered.');
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      await window.api.settings.set({
        ...(groqKey      ? { groqApiKey:      groqKey      } : {}),
        ...(anthropicKey ? { anthropicApiKey: anthropicKey } : {}),
      });
      const fresh = await window.api.settings.get();
      setSnap(fresh);
      setGroqKey('');
      setAnthropicKey('');
      setMsg('Keys saved.');
    } catch (e) {
      setMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  if (!snap) {
    return <div style={{ padding: 40, color: '#374151', fontSize: 13 }}>Loading settings…</div>;
  }

  // Combined model list — every model the current provider offers, no
  // heavy/light split. User picks one; that's what gets used for the heavy
  // passes (enrichment, concepts, grader, tasks). Light passes (structure,
  // graph) still auto-fall to the provider's cheap default behind the scenes.
  const providerChoices = snap.modelChoices[provider];
  const allChoices = [...providerChoices.heavy, ...providerChoices.light];
  const modelValue = (heavyModel && allChoices.includes(heavyModel)) ? heavyModel : allChoices[0];
  const modelSaved = !!snap.heavyModel && allChoices.includes(snap.heavyModel);
  const lightFallback = providerChoices.light[0];

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 32 }}>
      <div style={{ maxWidth: 720 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, marginBottom: 4, color: '#e2e8f0' }}>
          Extraction Mode
        </h1>
        <p style={{ fontSize: 12, color: '#6b7280', marginTop: 0, marginBottom: 16 }}>
          How a source is processed. Deterministic is the daily-use default.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 32 }}>
          {(['deterministic', 'candidate_gated', 'full'] as const).map(m => {
            const info = MODE_INFO[m];
            const selected = extractionMode === m;
            return (
              <label key={m} style={{
                display: 'block', cursor: 'pointer',
                background: selected ? '#1a1a2e' : '#0d0d16',
                border: `1px solid ${selected ? info.accent : '#1f2937'}`,
                borderRadius: 6, padding: '12px 14px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <input
                    type="radio" name="extractionMode" checked={selected}
                    onChange={() => pickMode(m)}
                    style={{ accentColor: info.accent }}
                  />
                  <span style={{ fontSize: 14, fontWeight: 600, color: selected ? info.accent : '#e2e8f0' }}>
                    {info.label}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginLeft: 22, lineHeight: 1.5 }}>{info.desc}</div>
              </label>
            );
          })}
        </div>

        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, marginBottom: 4, color: '#e2e8f0' }}>
          LLM Provider
        </h1>
        <p style={{ fontSize: 12, color: '#6b7280', marginTop: 0, marginBottom: 16 }}>
          Only matters for lazy task generation and grading in <em>deterministic</em> mode. All passes use it in the other modes.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
          {(['groq', 'anthropic'] as const).map(p => {
            const info = PROVIDER_INFO[p];
            const configured = p === 'groq' ? snap.groqApiKeyConfigured : snap.anthropicApiKeyConfigured;
            const selected = provider === p;
            return (
              <label key={p} style={{
                display: 'block', cursor: 'pointer',
                background: selected ? '#1a1a2e' : '#0d0d16',
                border: `1px solid ${selected ? '#818cf8' : '#1f2937'}`,
                borderRadius: 6, padding: '12px 14px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <input
                    type="radio" name="provider" checked={selected}
                    onChange={() => pickProvider(p)}
                    style={{ accentColor: '#818cf8' }}
                  />
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>{info.label}</span>
                  <span style={{
                    marginLeft: 'auto', fontSize: 10, padding: '2px 8px', borderRadius: 10,
                    background: configured ? '#14532d' : '#3f1515',
                    color:      configured ? '#bbf7d0' : '#fca5a5',
                  }}>
                    {configured ? 'key set' : 'no key'}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginLeft: 22, lineHeight: 1.5 }}>{info.tagline}</div>
              </label>
            );
          })}
        </div>

        <div style={{
          background: '#0d0d16', border: '1px solid #1f2937', borderRadius: 6,
          padding: 14, marginBottom: 28,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10 }}>
            Model — {provider}
          </div>
          <ModelSelect choices={allChoices} value={modelValue} onChange={pickHeavy} />
          <SavedBadge saved={modelSaved} fallback={allChoices[0]} />
          <div style={{ fontSize: 10, color: '#4b5563', marginTop: 10, lineHeight: 1.5 }}>
            Used for every LLM pass: enrichment, concepts, misconceptions, tasks, grader.
            <br />
            Cheap/structural passes (graph, structure) auto-use <code style={{ color: '#9ca3af' }}>{lightFallback}</code>.
          </div>
        </div>

        <h2 style={{ fontSize: 13, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.1em', margin: 0, marginBottom: 12 }}>
          API Keys
        </h2>
        <p style={{ fontSize: 11, color: '#6b7280', marginTop: 0, marginBottom: 16 }}>
          Stored locally in <code style={{ color: '#9ca3af' }}>settings.json</code> under your Electron user data directory. Never sent to the renderer process. Leave blank to keep the current value.
        </p>

        <KeyField
          label="Groq API key"
          placeholder={snap.groqApiKeyConfigured ? '•••••••• (stored)' : 'gsk_...'}
          value={groqKey}
          onChange={setGroqKey}
        />
        <KeyField
          label="Anthropic API key"
          placeholder={snap.anthropicApiKeyConfigured ? '•••••••• (stored)' : 'sk-ant-...'}
          value={anthropicKey}
          onChange={setAnthropicKey}
        />

        <button
          onClick={saveKeys}
          disabled={saving || (!groqKey && !anthropicKey)}
          title={(!groqKey && !anthropicKey) ? 'Enter a new key above first. Other settings save automatically.' : ''}
          style={{
            marginTop: 18,
            background: saving ? '#1e1e2e' : (groqKey || anthropicKey) ? '#4f46e5' : '#1e1e2e',
            border: 'none', borderRadius: 6,
            padding: '10px 24px',
            color: saving ? '#6b7280' : (groqKey || anthropicKey) ? '#fff' : '#6b7280',
            fontSize: 13, fontWeight: 600,
            cursor: saving ? 'wait' : (groqKey || anthropicKey) ? 'pointer' : 'not-allowed',
          }}
        >
          {saving ? 'Saving…' : 'Save API Keys'}
        </button>
        <div style={{ marginTop: 6, fontSize: 10, color: '#4b5563' }}>
          Provider, mode, and model selections save automatically.
        </div>
        {msg && (
          <div style={{ marginTop: 14, fontSize: 12, color: msg.startsWith('Save failed') ? '#fca5a5' : '#86efac' }}>
            {msg}
          </div>
        )}
      </div>
    </div>
  );
}

function SavedBadge({ saved, fallback }: { saved: boolean; fallback: string }) {
  return (
    <div style={{ fontSize: 10, marginTop: 4, color: saved ? '#86efac' : '#6b7280' }}>
      {saved
        ? '● saved override'
        : `○ default fallback (built-in: ${fallback})`}
    </div>
  );
}

function ModelSelect({ choices, value, onChange }: {
  choices: string[]; value: string; onChange: (v: string) => void;
}) {
  return (
    <select
      value={choices.includes(value) ? value : choices[0]}
      onChange={e => onChange(e.target.value)}
      style={{
        width: '100%', background: '#1a1a2e', border: '1px solid #1f2937', borderRadius: 4,
        padding: '6px 8px', color: '#e2e8f0', fontSize: 12,
        fontFamily: 'ui-monospace, Consolas, monospace', outline: 'none',
      }}
    >
      {choices.map(c => <option key={c} value={c}>{c}</option>)}
    </select>
  );
}

function KeyField({ label, placeholder, value, onChange }: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>{label}</div>
      <input
        type="password"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: '100%', boxSizing: 'border-box',
          background: '#0d0d16', border: '1px solid #1f2937', borderRadius: 5,
          padding: '8px 10px', color: '#e2e8f0', fontSize: 12,
          fontFamily: 'ui-monospace, Consolas, monospace', outline: 'none',
        }}
      />
    </div>
  );
}
