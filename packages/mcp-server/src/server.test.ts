// End-to-end over the MCP protocol (in-memory transport), plus config,
// loopback-embedder and "never reads settings" checks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from './server';
import { DEFAULT_EMBED_URL, DEFAULT_SCOPES, parseArgs, type Scope } from './config';
import { createLoopbackEmbedder } from './embedder';
import type { AuditEntry } from './audit';
import { openFixtureReadOnly, seedFixture, type Fixture } from './fixture.test-helper';

let f: Fixture;
let db: DatabaseSync;

beforeAll(async () => {
  f = await seedFixture();
  db = openFixtureReadOnly(f);
});
afterAll(() => {
  db.close();
  f.cleanup();
});

async function connect(scopes: Scope[], audit: AuditEntry[] = []) {
  const server = buildServer(
    { db, embedder: null, embedderNote: 'Embeddings disabled (--no-embeddings).', scopes: new Set(scopes) },
    { record: e => audit.push(e) },
  );
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe('MCP protocol', () => {
  it('lists only enabled, read-only tools', async () => {
    const client = await connect(DEFAULT_SCOPES);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(
      ['get_concept', 'get_learning_progress', 'get_passage', 'list_sources', 'search_concepts', 'search_passages'],
    );
    expect(tools.every(t => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false)).toBe(true);
    await client.close();
  });

  it('answers a tool call with attributed JSON and audits metadata only', async () => {
    const audit: AuditEntry[] = [];
    const client = await connect(DEFAULT_SCOPES, audit);
    const res = await client.callTool({ name: 'search_passages', arguments: { query: 'oxidative phosphorylation' } });
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(body.results[0]).toMatchObject({ source_title: 'Cell Biology', page_start: 7 });
    expect(audit).toEqual([expect.objectContaining({ tool: 'search_passages', ok: true, results: body.results.length })]);
    expect(JSON.stringify(audit)).not.toContain('oxidative');
    await client.close();
  });

  it('reports bad ids and invalid input as tool errors', async () => {
    const client = await connect(DEFAULT_SCOPES);
    const missing = await client.callTool({ name: 'get_concept', arguments: { concept_id: 424242 } });
    expect(missing.isError).toBe(true);
    expect((missing.content as Array<{ text: string }>)[0].text).toMatch(/No concept/);
    const bad = await client.callTool({ name: 'search_passages', arguments: { query: '' } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it('does not expose a tool whose scope is disabled', async () => {
    const client = await connect(DEFAULT_SCOPES);
    const res = await client.callTool({ name: 'search_highlights', arguments: { query: 'ATP' } });
    expect(res.isError).toBe(true);
    await client.close();
  });
});

describe('config', () => {
  it('defaults to the userData DB, default scopes and loopback embeddings', () => {
    const cfg = parseArgs([], { APPDATA: 'C:/Users/x/AppData/Roaming' });
    expect(cfg.scopes).toEqual(new Set(DEFAULT_SCOPES));
    expect(cfg.embedUrl).toBe(DEFAULT_EMBED_URL);
    if (process.platform === 'win32') expect(cfg.dbPath).toBe(path.join('C:/Users/x/AppData/Roaming', 'StarcallOS', 'stellaria.db'));
  });

  it('parses flags and rejects unknown input', () => {
    const cfg = parseArgs(['--db', 'x.db', '--scopes', 'passages,highlights', '--no-embeddings', '--log', 'off'], {});
    expect(cfg).toMatchObject({ dbPath: 'x.db', embeddings: false, logPath: null });
    expect([...cfg.scopes]).toEqual(['passages', 'highlights']);
    expect(parseArgs([], { STARCALL_DB: 'env.db' }).dbPath).toBe('env.db');
    expect(() => parseArgs(['--scopes', 'passages,keys'], {})).toThrow(/Unknown scope/);
    expect(() => parseArgs(['--write'], {})).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--db'], {})).toThrow(/needs a value/);
  });
});

describe('loopback embedder', () => {
  it('refuses a non-loopback embedding URL', async () => {
    await expect(createLoopbackEmbedder(db, { enabled: true, url: 'http://192.168.1.20:11434/v1', model: null }))
      .rejects.toThrow(/not a loopback/);
    await expect(createLoopbackEmbedder(db, { enabled: true, url: 'https://api.example.com/v1', model: null }))
      .rejects.toThrow(/not allowed/);
  });

  it('uses the model the library was indexed with when none is given', async () => {
    const s = await createLoopbackEmbedder(db, { enabled: true, url: DEFAULT_EMBED_URL, model: null });
    expect(s.embedder?.model).toBe('topic');
  });

  it('times out a slow embedding server so search can fall back', async () => {
    const s = await createLoopbackEmbedder(db, {
      enabled: true, url: 'http://127.0.0.1:9/v1', model: 'topic', timeoutMs: 50,
      lookupAll: async () => [{ address: '127.0.0.1' }],
    });
    await expect(s.embedder!.embed(['x'])).rejects.toThrow();
  });

  it('is off with --no-embeddings', async () => {
    expect(await createLoopbackEmbedder(db, { enabled: false, url: DEFAULT_EMBED_URL, model: null }))
      .toEqual({ embedder: null, note: expect.stringMatching(/disabled/) });
  });
});

describe('settings isolation', () => {
  it('no server source file reads the app settings or API keys', () => {
    const srcDir = __dirname;
    for (const file of fs.readdirSync(srcDir).filter(n => n.endsWith('.ts') && !n.includes('test'))) {
      const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
      expect(text, file).not.toMatch(/loadSettings|settings\.json'|ApiKey|safeStorage|SecretCodec/);
    }
  });
});
