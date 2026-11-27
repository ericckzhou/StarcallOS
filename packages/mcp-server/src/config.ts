// Command-line configuration. Deliberately does NOT read the app's
// settings.json: that file holds (encrypted) provider API keys, and this
// process never needs them. Everything comes from flags / env with safe
// defaults.

import os from 'node:os';
import path from 'node:path';

export const ALL_SCOPES = ['passages', 'concepts', 'progress', 'highlights', 'notes'] as const;
export type Scope = typeof ALL_SCOPES[number];
// Highlights and notes are user-authored and opt-in.
export const DEFAULT_SCOPES: Scope[] = ['passages', 'concepts', 'progress'];

export const DEFAULT_EMBED_URL = 'http://127.0.0.1:11434/v1';

export interface ServerConfig {
  dbPath: string;
  scopes: Set<Scope>;
  embeddings: boolean;
  embedUrl: string;
  // null = use the model the library's chunk vectors were built with.
  embedModel: string | null;
  // null = audit log off.
  logPath: string | null;
}

// Mirrors Electron's app.getPath('userData') for productName "StarcallOS".
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform === 'win32') {
    return path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'StarcallOS');
  }
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'StarcallOS');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'StarcallOS');
}

export const USAGE = `starcall-mcp: read-only StarcallOS MCP server (stdio)

  --db <path>          database file (env STARCALL_DB; default <userData>/stellaria.db)
  --scopes <list>      comma list of ${ALL_SCOPES.join(', ')}
                       (default ${DEFAULT_SCOPES.join(',')}; highlights and notes are opt-in)
  --embed-url <url>    loopback embedding server (default ${DEFAULT_EMBED_URL})
  --embed-model <name> embedding model (default: the model the library was indexed with)
  --no-embeddings      keyword search only
  --log <path|off>     metadata-only audit log (default <userData>/mcp.log)
`;

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = defaultDataDir(env);
  const cfg: ServerConfig = {
    dbPath: env.STARCALL_DB || path.join(dataDir, 'stellaria.db'),
    scopes: new Set(DEFAULT_SCOPES),
    embeddings: true,
    embedUrl: DEFAULT_EMBED_URL,
    embedModel: null,
    logPath: path.join(dataDir, 'mcp.log'),
  };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--db': cfg.dbPath = value(i, a); i++; break;
      case '--scopes': {
        const list = value(i, a).split(',').map(s => s.trim()).filter(Boolean);
        const bad = list.filter(s => !(ALL_SCOPES as readonly string[]).includes(s));
        if (bad.length) throw new Error(`Unknown scope(s): ${bad.join(', ')}`);
        if (list.length === 0) throw new Error('--scopes needs at least one scope');
        cfg.scopes = new Set(list as Scope[]);
        i++;
        break;
      }
      case '--embed-url': cfg.embedUrl = value(i, a); i++; break;
      case '--embed-model': cfg.embedModel = value(i, a); i++; break;
      case '--no-embeddings': cfg.embeddings = false; break;
      case '--log': { const v = value(i, a); cfg.logPath = v === 'off' ? null : v; i++; break; }
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  return cfg;
}
