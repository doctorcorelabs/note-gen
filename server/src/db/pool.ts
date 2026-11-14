// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// The single Postgres connection pool for the API server.
//
// The pool is created at startup from DATABASE_URL without an eager
// connection: when the database is down at startup, the server still starts,
// liveness still answers, and readiness reports the database check as
// failed. Health checks use this same pool, never a separate DSN or pool,
// so readiness tests exactly the configuration the application itself uses.
//
// The narrow HealthDbPool interface exists so health checks can be tested
// with fake pools. It exposes only what the checks need.

import { Pool } from 'pg';

export interface HealthDbClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: (err?: Error) => void;
}

export interface HealthDbPool {
  connect: () => Promise<HealthDbClient>;
  end: () => Promise<void>;
}

export function createPool(
  databaseUrl: string | undefined,
  connectionTimeoutMs: number,
): HealthDbPool | null {
  if (databaseUrl === undefined) {
    return null;
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: connectionTimeoutMs,
    idleTimeoutMillis: 30000,
  });
  // Idle client errors must never log raw driver messages (they can carry
  // host or credential fragments). The next health check surfaces the
  // failure with a machine error code instead.
  pool.on('error', () => {
    // Intentionally silent. See the comment above.
  });
  return {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text, params) => {
          const result = await client.query(text, params);
          return { rows: result.rows as Array<Record<string, unknown>> };
        },
        release: (err) => {
          client.release(err);
        },
      };
    },
    end: async () => {
      await pool.end();
    },
  };
}

export async function closePool(pool: HealthDbPool | null): Promise<void> {
  if (pool !== null) {
    await pool.end();
  }
}
