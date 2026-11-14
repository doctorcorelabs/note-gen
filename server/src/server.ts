// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// API server entrypoint. This is the only file that calls listen().
//
// Startup order: parse and validate config (fail-closed boot refusals
// in config/env.ts: an invalid PORT, an unrecognized REGISTRATION_MODE
// or CF_ACCESS_ENABLED value, a Cloudflare Access deployment without
// its audience or team domain, Access disabled outside local
// development, and COOKIE_SECURE=false outside development on
// localhost), read the version once from server/package.json and keep
// it in memory, create the Postgres pool without an eager connection,
// build the Fastify app, then listen. The server starts even when
// DATABASE_URL or WORKSPACE_ROOT is missing, so the misconfiguration
// shows up as a failed readiness check instead of a dead backend.
//
// Startup logs name variables only, never values. In particular, the
// DATABASE_URL value is never logged. Workspace configuration is logged
// as configured/not-configured, not as a path.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createAuthContextFromConfig } from './auth/context.js';
import { loadConfig, type ServerConfig } from './config.js';
import { closePool, createPool, type HealthDbPool } from './db/pool.js';

export function readServerVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const parsed = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version !== '') {
      return parsed.version;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function safeLoadConfig(): ServerConfig {
  try {
    return loadConfig(process.env);
  } catch (err) {
    // loadConfig refusal messages name variables only, never values,
    // so printing the message is safe and tells the operator exactly
    // which variable to fix.
    const message = err instanceof Error ? err.message : 'Configuration is not valid.';
    console.error(`Failed to start: ${message}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const config = safeLoadConfig();
  const version = readServerVersion();
  const pool: HealthDbPool | null = createPool(config.databaseUrl, config.checkTimeoutMs);
  // Production auth context (V3-01): builds the Drizzle-backed store
  // lazily from DATABASE_URL and reads secret values from the
  // environment. With no DATABASE_URL the store is null and every
  // auth path fails closed; the server still boots so health keeps
  // reporting readiness honestly.
  const auth = createAuthContextFromConfig(config);
  const app = await buildApp({ config, pool, version, auth });

  for (const warning of config.warnings) {
    app.log.warn(warning);
  }
  app.log.info(
    {
      service: 'note-gen-web-api',
      version,
      host: config.host,
      port: config.port,
      databaseConfigured: config.databaseUrl !== undefined,
      workspaceConfigured: config.workspaceRoot !== undefined,
    },
    'starting api server',
  );

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
    } catch {
      // Ignore close errors during shutdown.
    }
    try {
      await auth.close();
    } catch {
      // Ignore auth close errors during shutdown. buildApp also
      // closes the context on app.close(); the close is idempotent.
    }
    try {
      await closePool(pool);
    } catch {
      // Ignore pool close errors during shutdown.
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : undefined;
    app.log.error({ code: typeof code === 'string' ? code : 'LISTEN_FAILED' }, 'failed to listen');
    try {
      await closePool(pool);
    } catch {
      // Ignore pool close errors during failed startup.
    }
    process.exit(1);
  }
}

function isMainModule(): boolean {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const invoked = process.argv[1] === undefined ? '' : realpathSync(process.argv[1]);
    return self === invoked;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}
