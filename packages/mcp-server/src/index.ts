#!/usr/bin/env node
// starcall-mcp: read-only StarcallOS MCP server over stdio.
//
// Trust boundary: this is a local subprocess. It opens no network listener;
// the only party that can talk to it is the process that spawned it. Its only
// outbound connection is the optional loopback embedding server.
//
// It never reads the app's settings.json (API keys), never runs migrations,
// and opens the database read-only.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { assertSchemaCurrent, openDbReadOnly } from '@starcall/services';
import { USAGE, parseArgs } from './config';
import { createLoopbackEmbedder } from './embedder';
import { createFileAuditLog } from './audit';
import { buildServer } from './server';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(USAGE);
    return;
  }
  const cfg = parseArgs(argv);
  const db = openDbReadOnly(cfg.dbPath);
  assertSchemaCurrent(db);
  const { embedder, note } = await createLoopbackEmbedder(db, {
    enabled: cfg.embeddings, url: cfg.embedUrl, model: cfg.embedModel,
  });
  const audit = cfg.logPath ? createFileAuditLog(cfg.logPath) : undefined;
  const server = buildServer({ db, embedder, embedderNote: note, scopes: cfg.scopes }, audit);

  const shutdown = () => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  };
  // The client closing our stdin is the normal end of a session.
  process.stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `starcall-mcp ready (scopes: ${[...cfg.scopes].join(',')}; search: ${embedder ? `hybrid via ${embedder.model}` : 'keyword'})\n`,
  );
}

main().catch(err => {
  process.stderr.write(`starcall-mcp: ${(err as Error).message}\n`);
  process.exit(1);
});
