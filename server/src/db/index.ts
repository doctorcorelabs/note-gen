// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Database accessor for the API server. This path is binding: endpoint
// workers import getDb (and the table definitions) from here.
//
//   import { getDb, marks } from '../db/index.js';
//   const db = getDb();
//   await db.select().from(marks).where(eq(marks.workspaceId, workspaceId));
//
// Rules:
// - The driver is postgres.js (AD-05), with Drizzle ORM on top. The
//   health-check pool in ./pool.ts (node-postgres) is a separate,
//   pre-existing pool; this accessor does not replace it and does not
//   share connections with it. Unifying the two pools is integrator work,
//   not part of the schema wave.
// - Importing this module never connects and never throws: the client is
//   created lazily on the first getDb() call, and postgres.js connects
//   lazily on first use. getDb() throws only when no DATABASE_URL is
//   available; the error names the variable, never its value.
// - getDb() never runs migrations. Migrations run through
//   ./migrate.ts, called explicitly at server start by the startup wiring
//   (which honors MIGRATE_ON_START). Calling getDb() against a database
//   whose migrations are not current fails on first use, with a driver
//   error, exactly like any other unmigrated access.
// - Pool sizing uses the postgres.js defaults until measurements exist
//   (V1-03 section 2.4). createDb accepts an explicit max for tests and
//   for callers that need an isolated client.
// - Transactions use one pooled connection for their duration via
//   db.transaction(). No caller may issue manual transaction statements.

import postgres, { type Sql } from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from './schema/index.js';

export * from './schema/index.js';
export { schema };

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  client: Sql;
  close: () => Promise<void>;
}

export interface CreateDbOptions {
  // Maximum pooled connections. When omitted, the postgres.js default
  // applies.
  max?: number;
}

export function createDb(databaseUrl: string, options: CreateDbOptions = {}): DbHandle {
  const client = postgres(databaseUrl, {
    ...(options.max !== undefined ? { max: options.max } : {}),
  });
  const db = drizzle(client, { schema });
  return {
    db,
    client,
    close: async () => {
      await client.end();
    },
  };
}

let singleton: DbHandle | null = null;

function readDatabaseUrl(explicit: string | undefined): string {
  const value = explicit !== undefined && explicit.trim() !== '' ? explicit.trim() : undefined;
  const fromEnv = process.env.DATABASE_URL;
  const resolved = value ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv.trim() : undefined);
  if (resolved === undefined) {
    throw new Error('DATABASE_URL is not set; the database accessor cannot be created.');
  }
  return resolved;
}

// Returns the process-wide database handle, creating it on first call.
// The first call wins: a later call with a different URL returns the
// existing handle. Tests and tools that need isolation must use
// createDb() instead of this singleton.
export function getDb(databaseUrl?: string): Database {
  if (singleton !== null) {
    return singleton.db;
  }
  singleton = createDb(readDatabaseUrl(databaseUrl));
  return singleton.db;
}

// Closes the singleton client, if one was created. Safe to call when no
// singleton exists. Server shutdown wiring calls this after closing the
// HTTP server.
export async function closeDb(): Promise<void> {
  if (singleton !== null) {
    const handle = singleton;
    singleton = null;
    await handle.close();
  }
}

// True when a DATABASE_URL is available from the argument or the
// environment. Lets startup wiring decide whether database access is
// configured without creating the client.
export function isDbConfigured(databaseUrl?: string): boolean {
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') {
    return true;
  }
  const fromEnv = process.env.DATABASE_URL;
  return fromEnv !== undefined && fromEnv.trim() !== '';
}
