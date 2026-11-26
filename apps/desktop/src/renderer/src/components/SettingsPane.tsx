import React, { useEffect, useState } from 'react';
import LibraryIndexPanel from './LibraryIndexPanel';
import ReextractPanel from './ReextractPanel';
import type { EmbeddingsStatus, ExtractionMode, LlmTraceSummary, ProviderId, SettingsSnapshot } from '@starcall/shared';

type Snapshot = SettingsSnapshot;

const PROVIDER_INFO: Record<ProviderId, { label: string; tagline: string }> = {
  groq: {
    label: 'Groq',
    tagline: 'Free tier — 100K TPD / 12K TPM. Fast llama models. Good for prototyping.',
  },
  anthropic: {
    label: 'Anthropic',
    tagline: 'Paid. Tier 1: 50 RPM / 40K ITPM. No daily cap. Better quality on extraction.',
  },
  local: {
    label: 'Local model',
    tagline: 'Free and offline. Any OpenAI-compatible server on your machine or network (Ollama, llama.cpp, LM Studio). Quality depends on the model — check it with the eval harness.',
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
  const [exportStatus, setExportStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  async function exportLibrary(format: 'markdown' | 'anki'): Promise<void> {
    setExportStatus('saving');
    try {
      const res = await window.api.export.bundle({ scope: 'library', format });
      if (res.ok) { setExportStatus('saved'); setTimeout(() => setExportStatus('idle'), 2200); }
      else if (res.canceled) { setExportStatus('idle'); }
      else { setExportStatus('error'); setTimeout(() => setExportStatus('idle'), 2800); }
    } catch {
      setExportStatus('error'); setTimeout(() => setExportStatus('idle'), 2800);
    }
  }

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
  async function autoSave(patch: { modelOverrides?: Record<string, string>; provider?: ProviderId; extractionMode?: ExtractionMode; heavyModel?: string; lightModel?: string; gradeSelfConsistency?: boolean; localBaseUrl?: string; localModel?: string; embeddingsEnabled?: boolean; embeddingModel?: string; srsScheduler?: 'sm2' | 'fsrs'; pdfParser?: 'builtin' | 'docling'; doclingBaseUrl?: string }): Promise<void> {
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
    return <div style={{ padding: 40, color: 'var(--gray-700)', fontSize: 13 }}>Loading settings…</div>;
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
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, marginBottom: 4, color: 'var(--text)' }}>
          Extraction Mode
        </h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0, marginBottom: 16 }}>
          How a source is processed. Deterministic is the daily-use default.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 32 }}>
          {(['deterministic', 'candidate_gated', 'full'] as const).map(m => {
            const info = MODE_INFO[m];
            const selected = extractionMode === m;
            return (
              <label key={m} style={{
                display: 'block', cursor: 'pointer',
                background: selected ? 'rgba(75,85,99,0.26)' : 'rgba(75,85,99,0.12)',
                backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
                border: `1px solid ${selected ? info.accent : 'rgba(31,41,55,0.7)'}`,
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
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 22, lineHeight: 1.5 }}>{info.desc}</div>
              </label>
            );
          })}
        </div>

        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, marginBottom: 4, color: 'var(--text)' }}>
          LLM Provider
        </h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0, marginBottom: 16 }}>
          Only matters for lazy task generation and grading in <em>deterministic</em> mode. All passes use it in the other modes.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
          {(['groq', 'anthropic', 'local'] as const).map(p => {
            const info = PROVIDER_INFO[p];
            const configured = p === 'groq' ? snap.groqApiKeyConfigured
              : p === 'anthropic' ? snap.anthropicApiKeyConfigured
              : true;
            const selected = provider === p;
            return (
              <label key={p} style={{
                display: 'block', cursor: 'pointer',
                background: selected ? 'rgba(75,85,99,0.26)' : 'rgba(75,85,99,0.12)',
                backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
                border: `1px solid ${selected ? '#818cf8' : 'rgba(31,41,55,0.7)'}`,
                borderRadius: 6, padding: '12px 14px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <input
                    type="radio" name="provider" checked={selected}
                    onChange={() => pickProvider(p)}
                    style={{ accentColor: 'var(--indigo-400)' }}
                  />
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{info.label}</span>
                  <span style={{
                    marginLeft: 'auto', fontSize: 10, padding: '2px 8px', borderRadius: 10,
                    background: configured ? '#14532d' : '#3f1515',
                    color:      configured ? '#bbf7d0' : '#fca5a5',
                  }}>
                    {p === 'local' ? 'no key needed' : configured ? 'key set' : 'no key'}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 22, lineHeight: 1.5 }}>{info.tagline}</div>
              </label>
            );
          })}
        </div>

        <div style={{
          background: 'rgba(13,13,22,0.35)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
          border: '1px solid rgba(31,41,55,0.7)', borderRadius: 6,
          padding: 14, marginBottom: 28,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10 }}>
            Model — {provider}
          </div>
          {provider === 'local' ? (
            <LocalProviderFields
              key={`${snap.localBaseUrl}|${snap.localModel}`}
              baseUrl={snap.localBaseUrl}
              model={snap.localModel}
              defaultBaseUrl={snap.defaultLocalBaseUrl}
              onSave={patch => void autoSave(patch)}
            />
          ) : (
            <>
              <ModelSelect choices={allChoices} value={modelValue} onChange={pickHeavy} />
              <SavedBadge saved={modelSaved} fallback={allChoices[0]} />
              <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 10, lineHeight: 1.5 }}>
                Used for every LLM pass (enrichment, concepts, misconceptions, tasks, grader, prerequisite suggestions) unless overridden below.
                <br />
                Cheap/structural passes (graph, structure) auto-use <code style={{ color: 'var(--text-secondary)' }}>{lightFallback}</code>.
              </div>
              <PassOverrides
                choices={allChoices}
                overrides={snap.modelOverrides}
                heavyDefault={modelValue}
                lightDefault={lightFallback}
                onSave={modelOverrides => void autoSave({ modelOverrides })}
              />
            </>
          )}
        </div>

        <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.1em', margin: 0, marginBottom: 12 }}>
          API Keys
        </h2>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 0, marginBottom: 16 }}>
          Stored locally in <code style={{ color: 'var(--text-secondary)' }}>settings.json</code> under your Electron user data directory. Never sent to the renderer process. Leave blank to keep the current value.
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
        <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-faint)' }}>
          Provider, mode, and model selections save automatically.
        </div>
        {msg && (
          <div style={{ marginTop: 14, fontSize: 12, color: msg.startsWith('Save failed') ? '#fca5a5' : '#86efac' }}>
            {msg}
          </div>
        )}

        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, marginTop: 36, marginBottom: 4, color: 'var(--text)' }}>
          Grading
        </h1>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', marginTop: 8 }}>
          <input
            type="checkbox"
            checked={snap.gradeSelfConsistency}
            onChange={e => void autoSave({ gradeSelfConsistency: e.target.checked })}
            style={{ marginTop: 3, accentColor: 'var(--indigo-400)' }}
          />
          <span>
            <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>Double-check borderline grades</span>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: 2 }}>
              When a grade looks borderline, grade the answer up to two more times and take the majority.
              More consistent, but up to 3× the grading calls on those answers. On by default for Anthropic, off for Groq.
            </span>
          </span>
        </label>

        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600, marginBottom: 6 }}>Review scheduler</div>
          {([
            ['sm2', 'SM-2', 'The classic algorithm. Predictable fixed growth of intervals.'],
            ['fsrs', 'FSRS', 'Models how fast you forget each concept; usually needs fewer reviews for the same retention. Existing cards convert on their next review.'],
          ] as const).map(([id, label, desc]) => (
            <label key={id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 6 }}>
              <input
                type="radio" name="srsScheduler" checked={snap.srsScheduler === id}
                onChange={() => void autoSave({ srsScheduler: id })}
                style={{ marginTop: 3, accentColor: 'var(--indigo-400)' }}
              />
              <span>
                <span style={{ fontSize: 12, color: 'var(--text)' }}>{label}</span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{desc}</span>
              </span>
            </label>
          ))}
          <div style={{ fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.5 }}>
            Either way, an answer you were over-confident about (and didn't fully get) comes back sooner.
          </div>
        </div>

        <EmbeddingsSection
          enabled={snap.embeddingsEnabled}
          model={snap.embeddingModel}
          defaultModel={snap.defaultEmbeddingModel}
          baseUrl={snap.localBaseUrl || snap.defaultLocalBaseUrl}
          onSave={patch => autoSave(patch)}
        />

        <PdfParserSection
          parser={snap.pdfParser}
          baseUrl={snap.doclingBaseUrl}
          defaultBaseUrl={snap.defaultDoclingBaseUrl}
          onSave={patch => autoSave(patch)}
        />

        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, marginTop: 36, marginBottom: 4, color: 'var(--text)' }}>
          Passage index
        </h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0, marginBottom: 10, lineHeight: 1.5 }}>
          The passages Ask searches. Index every source at once, including sources added before Ask existed and
          ones indexed by an older parser. Runs locally in the background; with embeddings on it also embeds
          every passage. Concepts, candidates and notes are never changed.
        </p>
        <LibraryIndexPanel />

        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, marginTop: 36, marginBottom: 4, color: 'var(--text)' }}>
          Outdated sources
        </h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0, marginBottom: 10, lineHeight: 1.5 }}>
          Sources whose candidates were extracted by an older version of the parser. Re-extracting them applies
          the current parser, one source at a time in the background. Promoted concepts with evidence, notes and
          study history are kept; unpromoted candidates are rebuilt.
        </p>
        <ReextractPanel />

        <LlmUsageSection />

        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, marginTop: 36, marginBottom: 4, color: 'var(--text)' }}>
          Export
        </h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0, marginBottom: 16 }}>
          Download every promoted concept across all sources as one file. (Per-source export lives on each source in the Sources sidebar.)
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {(['markdown', 'anki'] as const).map(fmt => (
            <button key={fmt} onClick={() => void exportLibrary(fmt)} disabled={exportStatus === 'saving'}
              style={{
                background: 'transparent', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
                border: '1px solid rgba(99,102,241,0.5)', borderRadius: 6, padding: '9px 18px',
                color: exportStatus === 'saving' ? '#6b7280' : '#c7d2fe', fontSize: 13, fontWeight: 600,
                cursor: exportStatus === 'saving' ? 'wait' : 'pointer',
              }}>
              Library → {fmt === 'markdown' ? 'Markdown (.md)' : 'Anki (.txt)'}
            </button>
          ))}
          {exportStatus === 'saving' && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Choose a location…</span>}
          {exportStatus === 'saved' && <span style={{ fontSize: 12, color: 'var(--text-success)' }}>Exported.</span>}
          {exportStatus === 'error' && <span style={{ fontSize: 12, color: 'var(--text-danger)' }}>Export failed.</span>}
        </div>
      </div>
    </div>
  );
}

// Base URL + model id for the local provider. Saved on blur/Enter (not per
// keystroke); "Test connection" lists the server's models as pickable chips.
function LocalProviderFields({ baseUrl, model, defaultBaseUrl, onSave }: {
  baseUrl: string; model: string; defaultBaseUrl: string;
  onSave: (patch: { localBaseUrl?: string; localModel?: string }) => void;
}) {
  const [url, setUrl] = useState(baseUrl);
  const [mdl, setMdl] = useState(model);
  const [probe, setProbe] = useState<{ state: 'idle' | 'testing' } | { state: 'ok'; models: string[] } | { state: 'error'; error: string }>({ state: 'idle' });

  async function test(): Promise<void> {
    setProbe({ state: 'testing' });
    const res = await window.api.llm.listLocalModels(url.trim() || defaultBaseUrl);
    setProbe(res.ok ? { state: 'ok', models: res.models } : { state: 'error', error: res.error });
  }

  const input: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', background: 'rgba(13,13,22,0.35)',
    border: '1px solid rgba(55,65,81,0.8)', borderRadius: 5, padding: '7px 10px',
    color: 'var(--text)', fontSize: 12, fontFamily: 'ui-monospace, monospace',
  };
  const label: React.CSSProperties = { display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, marginTop: 8 };
  const commit = (patch: { localBaseUrl?: string; localModel?: string }) => onSave(patch);

  return (
    <div>
      <label style={label}>Server base URL</label>
      <input
        style={input} value={url} placeholder={defaultBaseUrl}
        onChange={e => setUrl(e.target.value)}
        onBlur={() => { if (url !== baseUrl) commit({ localBaseUrl: url }); }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      <label style={label}>Model</label>
      <input
        style={input} value={mdl} placeholder="llama3.1:8b"
        onChange={e => setMdl(e.target.value)}
        onBlur={() => { if (mdl !== model) commit({ localModel: mdl }); }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <button onClick={() => void test()} disabled={probe.state === 'testing'}
          style={{
            background: 'transparent', border: '1px solid rgba(99,102,241,0.5)', borderRadius: 5,
            padding: '5px 12px', color: 'var(--text-accent)', fontSize: 12, cursor: probe.state === 'testing' ? 'wait' : 'pointer',
          }}>
          {probe.state === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        {probe.state === 'error' && <span style={{ fontSize: 11, color: 'var(--text-danger)' }}>{probe.error}</span>}
        {probe.state === 'ok' && probe.models.length === 0 && (
          <span style={{ fontSize: 11, color: '#fcd34d' }}>Connected, but the server lists no models.</span>
        )}
      </div>
      {probe.state === 'ok' && probe.models.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {probe.models.map(m => (
            <button key={m} onClick={() => { setMdl(m); commit({ localModel: m }); }}
              title="Use this model"
              style={{
                background: m === mdl ? 'rgba(99,102,241,0.3)' : 'rgba(75,85,99,0.2)',
                border: '1px solid rgba(99,102,241,0.35)', borderRadius: 999, padding: '2px 10px',
                color: 'var(--indigo-100)', fontSize: 11, fontFamily: 'ui-monospace, monospace', cursor: 'pointer',
              }}>
              {m}
            </button>
          ))}
        </div>
      )}
      <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 10, lineHeight: 1.5 }}>
        One model is used for every LLM pass. Nothing leaves this machine unless the URL points elsewhere.
      </div>
    </div>
  );
}

// PDF parser: the built-in geometry parser (default) or the user's own
// docling-serve. Switching marks PDF sources outdated (their layout stamp
// changes), so Outdated sources / Passage index below can redo them.
function PdfParserSection({ parser, baseUrl, defaultBaseUrl, onSave }: {
  parser: 'builtin' | 'docling'; baseUrl: string; defaultBaseUrl: string;
  onSave: (patch: { pdfParser?: 'builtin' | 'docling'; doclingBaseUrl?: string }) => Promise<void>;
}) {
  const [url, setUrl] = useState(baseUrl);
  const [probe, setProbe] = useState<{ state: 'idle' | 'testing' } | { state: 'ok'; version: string } | { state: 'error'; error: string }>({ state: 'idle' });
  useEffect(() => { setUrl(baseUrl); }, [baseUrl]);

  async function test(): Promise<void> {
    setProbe({ state: 'testing' });
    const res = await window.api.docling.test(url.trim() || defaultBaseUrl);
    setProbe(res.ok ? { state: 'ok', version: [res.docling && `docling ${res.docling}`, res.serve && `docling-serve ${res.serve}`].filter(Boolean).join(' · ') || 'connected' } : { state: 'error', error: res.error });
  }

  const input: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', background: 'rgba(13,13,22,0.35)',
    border: '1px solid rgba(55,65,81,0.8)', borderRadius: 5, padding: '7px 10px',
    color: 'var(--text)', fontSize: 12, fontFamily: 'ui-monospace, monospace',
  };
  return (
    <div style={{ marginTop: 36 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, marginBottom: 4, color: 'var(--text)' }}>PDF parser</h1>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0, marginBottom: 10, lineHeight: 1.5 }}>
        How PDFs are read into headings, paragraphs and formulas. Text sources always use the built-in reader.
      </p>
      {([
        ['builtin', 'Built-in', 'Fast, no setup. Reads layout from font sizes and positions.'],
        ['docling', 'Docling (your own server)', 'Uses a docling-serve you run locally (pip install docling-serve, then docling-serve run). Better structure on many books; slower. If the server is unreachable, the built-in parser is used.'],
      ] as const).map(([id, label, desc]) => (
        <label key={id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 6 }}>
          <input type="radio" name="pdfParser" checked={parser === id} onChange={() => void onSave({ pdfParser: id })}
            style={{ marginTop: 3, accentColor: 'var(--indigo-400)' }} />
          <span>
            <span style={{ fontSize: 12, color: 'var(--text)' }}>{label}</span>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{desc}</span>
          </span>
        </label>
      ))}
      {parser === 'docling' && (
        <div style={{ marginLeft: 24 }}>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, marginTop: 4 }}>Docling server URL</label>
          <input
            style={input} value={url} placeholder={defaultBaseUrl}
            onChange={e => setUrl(e.target.value)}
            onBlur={() => { if (url !== baseUrl) void onSave({ doclingBaseUrl: url }); }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
            <button onClick={() => void test()} disabled={probe.state === 'testing'}
              style={{
                background: 'transparent', border: '1px solid rgba(99,102,241,0.5)', borderRadius: 5,
                padding: '5px 12px', color: 'var(--text-accent)', fontSize: 12, cursor: probe.state === 'testing' ? 'wait' : 'pointer',
              }}>
              {probe.state === 'testing' ? 'Testing…' : 'Test connection'}
            </button>
            {probe.state === 'ok' && <span style={{ fontSize: 11, color: 'var(--text-success)' }}>{probe.version}</span>}
            {probe.state === 'error' && <span style={{ fontSize: 11, color: 'var(--text-danger)' }}>{probe.error}</span>}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.5 }}>
            PDFs are sent only to this URL. Switching parsers marks PDF sources as outdated; re-extract them below.
          </div>
        </div>
      )}
    </div>
  );
}

// Opt-in local embeddings: related-concept suggestions + wider grounding.
function EmbeddingsSection({ enabled, model, defaultModel, baseUrl, onSave }: {
  enabled: boolean; model: string; defaultModel: string; baseUrl: string;
  onSave: (patch: { embeddingsEnabled?: boolean; embeddingModel?: string }) => Promise<void>;
}) {
  const [mdl, setMdl] = useState(model);
  const [status, setStatus] = useState<EmbeddingsStatus | null>(null);
  const [job, setJob] = useState<{ state: 'idle' | 'running' } | { state: 'done'; msg: string } | { state: 'error'; msg: string }>({ state: 'idle' });

  const refresh = () => { window.api.embeddings.status().then(setStatus).catch(() => setStatus(null)); };
  useEffect(refresh, [enabled, model]);

  async function indexNow(): Promise<void> {
    setJob({ state: 'running' });
    const r = await window.api.embeddings.indexLibrary();
    setJob(r.ok
      ? { state: 'done', msg: r.embedded > 0 ? `Indexed ${r.embedded} new item${r.embedded === 1 ? '' : 's'} across ${r.sources} sources.` : 'Already up to date.' }
      : { state: 'error', msg: r.error });
    refresh();
  }

  async function toggle(on: boolean): Promise<void> {
    await onSave({ embeddingsEnabled: on });
    if (on) void indexNow();
  }

  return (
    <>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, marginTop: 36, marginBottom: 4, color: 'var(--text)' }}>
        Embeddings
      </h1>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', marginTop: 8 }}>
        <input type="checkbox" checked={enabled} onChange={e => void toggle(e.target.checked)} style={{ marginTop: 3, accentColor: 'var(--indigo-400)' }} />
        <span>
          <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>Use local embeddings</span>
          <span style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: 2 }}>
            Suggests related concepts across sources when linking constellations, and gives the grader related
            excerpts from the same source. Uses the embeddings endpoint of the local server at{' '}
            <code style={{ color: 'var(--text-accent)' }}>{baseUrl}</code> (e.g. <code style={{ color: 'var(--text-accent)' }}>ollama pull {defaultModel}</code>).
            Nothing is sent anywhere else.
          </span>
        </span>
      </label>
      {enabled && (
        <div style={{ marginLeft: 24, marginTop: 10 }}>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>Embedding model</label>
          <input
            value={mdl} placeholder={defaultModel}
            onChange={e => setMdl(e.target.value)}
            onBlur={() => { if (mdl !== model) void onSave({ embeddingModel: mdl }); }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            style={{
              width: 260, background: 'rgba(13,13,22,0.35)', border: '1px solid rgba(55,65,81,0.8)', borderRadius: 5,
              padding: '6px 10px', color: 'var(--text)', fontSize: 12, fontFamily: 'ui-monospace, monospace',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            <button onClick={() => void indexNow()} disabled={job.state === 'running'}
              style={{
                background: 'transparent', border: '1px solid rgba(99,102,241,0.5)', borderRadius: 5,
                padding: '5px 12px', color: 'var(--text-accent)', fontSize: 12, cursor: job.state === 'running' ? 'wait' : 'pointer',
              }}>
              {job.state === 'running' ? 'Indexing…' : 'Index concepts now'}
            </button>
            {status && (
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {status.concepts} concepts · {status.spans} excerpts · {status.sources}/{status.totalSources} sources indexed
              </span>
            )}
          </div>
          {job.state === 'done' && <div style={{ fontSize: 11, color: 'var(--text-success)', marginTop: 6 }}>{job.msg}</div>}
          {job.state === 'error' && <div style={{ fontSize: 11, color: 'var(--text-danger)', marginTop: 6 }}>{job.msg}</div>}
        </div>
      )}
    </>
  );
}

const USAGE_WINDOWS = [7, 30, 90] as const;

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

// Read-only view over the persisted llm_calls trace: per-pass volume, errors,
// retries, latency, and cache reads, so slow/failing passes are visible.
function LlmUsageSection() {
  const [days, setDays] = useState<number>(30);
  const [summary, setSummary] = useState<LlmTraceSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    window.api.llm.traceSummary(days)
      .then(s => { if (live) setSummary(s); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [days]);

  const th: React.CSSProperties = { textAlign: 'right', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 600, fontSize: 11 };
  const td: React.CSSProperties = { textAlign: 'right', padding: '4px 8px', color: 'var(--text-soft)', fontSize: 12, fontVariantNumeric: 'tabular-nums' };

  return (
    <>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, marginTop: 36, marginBottom: 4, color: 'var(--text)' }}>
        LLM usage
      </h1>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0, marginBottom: 12 }}>
        Every call to the configured LLM provider, by pass. Only metadata is stored — never prompt or answer text.
      </p>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {USAGE_WINDOWS.map(d => (
          <button key={d} onClick={() => setDays(d)}
            style={{
              background: d === days ? 'rgba(99,102,241,0.25)' : 'transparent',
              border: '1px solid rgba(99,102,241,0.4)', borderRadius: 999, padding: '3px 10px',
              color: d === days ? '#e0e7ff' : '#9ca3af', fontSize: 11, cursor: 'pointer',
            }}>
            {d}d
          </button>
        ))}
      </div>
      {failed && <div style={{ fontSize: 12, color: 'var(--text-danger)' }}>Could not load usage.</div>}
      {!failed && summary && summary.total_calls === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No LLM calls in the last {summary.days} days.</div>
      )}
      {!failed && summary && summary.total_calls > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
            {summary.total_calls} calls · {fmtTokens(summary.total_tokens)} tokens
            {summary.total_errors > 0 && <span style={{ color: 'var(--text-danger)' }}> · {summary.total_errors} failed</span>}
          </div>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Pass</th>
                <th style={th}>Calls</th>
                <th style={th}>Errors</th>
                <th style={th}>Retries</th>
                <th style={th}>Tokens in/out</th>
                <th style={th}>Cache read</th>
                <th style={th}>Avg / p95</th>
              </tr>
            </thead>
            <tbody>
              {summary.by_pass.map(p => (
                <tr key={p.pass} style={{ borderTop: '1px solid rgba(148,163,184,0.12)' }}>
                  <td style={{ ...td, textAlign: 'left', fontFamily: 'ui-monospace, monospace' }}>{p.pass}</td>
                  <td style={td}>{p.calls}</td>
                  <td style={{ ...td, color: p.errors > 0 ? '#fca5a5' : td.color }}>{p.errors}</td>
                  <td style={{ ...td, color: p.retries > 0 ? '#fcd34d' : td.color }}>{p.retries}</td>
                  <td style={td}>{fmtTokens(p.prompt_tokens)} / {fmtTokens(p.completion_tokens)}</td>
                  <td style={td}>{p.cache_read_tokens > 0 ? fmtTokens(p.cache_read_tokens) : '—'}</td>
                  <td style={td}>{(p.avg_duration_ms / 1000).toFixed(1)}s / {(p.p95_duration_ms / 1000).toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
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

// Per-pass model overrides. Keys mirror OVERRIDABLE_PASSES in services
// settings.ts; main ignores an override that isn't in the current provider's
// roster, so one saved under another provider reads here as "Default".
const PASS_OVERRIDE_ROWS: ReadonlyArray<{ pass: string; label: string; light?: boolean; group: 'study' | 'extraction' }> = [
  { pass: 'grader',         label: 'Grading',                          group: 'study' },
  { pass: 'lazy_tasks',     label: 'Challenge tasks + concept enrich', group: 'study' },
  { pass: 'prereq_suggest', label: 'Prerequisite suggestions',         group: 'study' },
  { pass: 'concepts',       label: 'Concepts + candidate topic filter', group: 'extraction' },
  { pass: 'enrich',         label: 'Block enrichment',                 group: 'extraction' },
  { pass: 'misconceptions', label: 'Misconceptions',                   group: 'extraction' },
  { pass: 'tasks',          label: 'Extraction tasks',                 group: 'extraction' },
  { pass: 'graph',          label: 'Concept graph',     light: true,   group: 'extraction' },
];

function PassOverrides({ choices, overrides, heavyDefault, lightDefault, onSave }: {
  choices: string[];
  overrides: Record<string, string>;
  heavyDefault: string;
  lightDefault: string;
  onSave: (next: Record<string, string>) => void;
}) {
  const active = PASS_OVERRIDE_ROWS.filter(r => choices.includes(overrides[r.pass] ?? '')).length;
  const [open, setOpen] = useState(active > 0);

  function setPass(pass: string, model: string): void {
    const next = { ...overrides };
    if (model) next[pass] = model; else delete next[pass];
    onSave(next);
  }

  const selectStyle: React.CSSProperties = {
    flex: 1, minWidth: 0, background: 'transparent',
    border: '1px solid rgba(31,41,55,0.7)', borderRadius: 4,
    padding: '4px 6px', color: 'var(--text)', fontSize: 11,
    fontFamily: 'ui-monospace, Consolas, monospace', outline: 'none',
  };

  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 11 }}
      >
        {open ? '▾' : '▸'} Per-pass models{active > 0 ? ` · ${active} overridden` : ''}
      </button>
      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(['study', 'extraction'] as const).map(group => (
            <React.Fragment key={group}>
              <div style={{ fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: group === 'extraction' ? 6 : 0 }}>
                {group === 'study' ? 'Study (all modes)' : 'Extraction (candidate-gated / full)'}
              </div>
              {PASS_OVERRIDE_ROWS.filter(r => r.group === group).map(r => {
                const saved = overrides[r.pass] ?? '';
                const value = choices.includes(saved) ? saved : '';
                const fallback = r.light ? lightDefault : heavyDefault;
                return (
                  <label key={r.pass} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 200, flexShrink: 0, fontSize: 11, color: value ? '#c4b5fd' : '#9ca3af' }}>{r.label}</span>
                    <select value={value} onChange={e => setPass(r.pass, e.target.value)} style={selectStyle}>
                      <option value="">Default ({fallback})</option>
                      {choices.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                );
              })}
            </React.Fragment>
          ))}
          <div style={{ fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.5 }}>
            Overrides apply to the current provider only; one saved for another provider is ignored here.
          </div>
        </div>
      )}
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
        width: '100%', background: 'transparent',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        border: '1px solid rgba(31,41,55,0.7)', borderRadius: 4,
        padding: '6px 8px', color: 'var(--text)', fontSize: 12,
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
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>{label}</div>
      <input
        type="password"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: '100%', boxSizing: 'border-box',
          background: 'rgba(13,13,22,0.45)',
          backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
          border: '1px solid rgba(31,41,55,0.7)', borderRadius: 5,
          padding: '8px 10px', color: 'var(--text)', fontSize: 12,
          fontFamily: 'ui-monospace, Consolas, monospace', outline: 'none',
        }}
      />
    </div>
  );
}
