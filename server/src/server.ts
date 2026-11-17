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
// it in memory, run the startup migration step (apply pending
// migrations, or refuse start on drift when MIGRATE_ON_START is
// 'false'; skip entirely when DATABASE_URL is unset), create the
// Postgres pool without an eager connection, build the auth context,
// check the SETUP_TOKEN boot prerequisite against the auth store
// (refuse when the database holds no accounts and no token of
// sufficient length is configured; warn and continue when the check
// cannot run, so health keeps reporting instead of the server dying
// on a database it is meant to report on), build the Fastify app,
// then listen. The server starts even when
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
import {
  checkSetupBootPrerequisite,
  createAuthContextFromConfig,
  type SetupPrerequisiteFlags,
} from './auth/context.js';
import type { AuthStore } from './auth/store.js';
import { loadConfig, MIN_SECRET_LENGTH, type ServerConfig } from './config.js';
import {
  checkMigrationDrift,
  MIGRATION_DRIFT_CODE,
  MIGRATION_LOCK_TIMEOUT_CODE,
  MIGRATION_MANIFEST_CODE,
  readMigrationErrorDetails,
  runMigrations,
  type CheckDriftOptions,
  type CheckDriftResult,
  type DriftResult,
  type RunMigrationsOptions,
  type RunMigrationsResult,
} from './db/migrate.js';
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

export type SetupBootPrerequisiteOutcome = 'proceed' | 'refused';

// Enforces the SETUP_TOKEN boot prerequisite (desain-auth.md section
// 2.2) through checkSetupBootPrerequisite: when the database holds no
// accounts, boot must refuse unless a setup token of sufficient length
// is configured. Returns 'refused' only when the store answers and the
// prerequisite fails. A null store (no usable database) or a database
// error (for example an unmigrated database) means the prerequisite
// cannot be checked: warn through the callback and return 'proceed',
// so health checks keep reporting readiness honestly instead of the
// server dying on a database they are meant to report on. Warning
// text names the variable only, never a secret value, and never
// includes database error detail.
export async function enforceSetupBootPrerequisite(
  store: AuthStore | null,
  flags: SetupPrerequisiteFlags,
  warn: (message: string) => void,
): Promise<SetupBootPrerequisiteOutcome> {
  if (store === null) {
    warn('SETUP_TOKEN boot prerequisite could not be checked: the database is not available.');
    return 'proceed';
  }
  let result: 'ok' | 'refused';
  try {
    result = await checkSetupBootPrerequisite(store, flags);
  } catch {
    warn('SETUP_TOKEN boot prerequisite could not be checked: the database query failed.');
    return 'proceed';
  }
  return result === 'refused' ? 'refused' : 'proceed';
}

// Startup migration wiring (AD-104, SMK-F1). main() applies pending
// migrations in-process before the server accepts traffic, following
// the contract in db/migrate.ts: when MIGRATE_ON_START is not
// 'false', runMigrations runs before the SETUP_TOKEN prerequisite
// check and before listen; when it is 'false', checkMigrationDrift
// runs and startup refuses unless the schema is already current (the
// manual migration path, Opsi C); when DATABASE_URL is unset,
// migration is skipped entirely and readiness reports the database
// as unconfigured, preserving Fase 0 behavior. The lock timeout
// keeps the migrate.ts default of 30 seconds (AD-104 E-4): no
// override is passed. Failure is fail-fast (AD-104 E-3 Opsi A):
// main() exits 1 before the pool, the auth context, or listen
// exists, so no ready response can claim the server is up. This
// wiring covers the boot schema only; the ready-endpoint migration
// check stays owned by V3-15 (AD-104 E-5) and is not touched here.

// Parse rule for MIGRATE_ON_START (AD-104 E-2 Opsi B, binding):
// enabled unless the value is exactly 'false'. Unset, empty, and
// unrecognized values (including 'FALSE', '0', and 'no') all mean
// enabled, matching the migrate.ts contract; the check is a plain
// string comparison, not a truthiness or boolean parse. server.ts
// reads process.env directly; loadConfig has no migration field and
// server/.env.example Bagian B is unchanged by this wiring.
export function isMigrateOnStartEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MIGRATE_ON_START !== 'false';
}

export type StartupMigrationOutcome =
  | { status: 'migrated'; appliedTags: string[] }
  | { status: 'current' }
  | { status: 'skipped' }
  | { status: 'failed'; kind: 'database-unreachable' | 'migration-failed'; message: string };

// Runners for the migration step, injectable so tests can prove the
// decision table without a database. Production main() uses the real
// migrate.ts functions through the default below.
export interface StartupMigrationRunners {
  runMigrations: (options: RunMigrationsOptions) => Promise<RunMigrationsResult>;
  checkMigrationDrift: (options: CheckDriftOptions) => Promise<CheckDriftResult>;
}

export interface StartupMigrationStepDeps {
  databaseUrl: string | undefined;
  migrateOnStart: boolean;
  runners?: StartupMigrationRunners;
  log: (message: string) => void;
}

// Connection-level failure codes: the database could not be reached
// at all, as opposed to a migration that ran and failed. The log
// wording distinguishes the two (AD-104 E-3); only the machine code
// is logged, never the driver message, which may quote an address.
const DATABASE_UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EPIPE',
  'ECONNABORTED',
]);

// Converts a runner failure into a failed outcome with a message
// built ONLY from validated structured details (machine code,
// failure family, migration tags) read through
// readMigrationErrorDetails. This function never reads an error
// message, query, params, or cause message: a drizzle apply error
// embeds the failing SQL verbatim in its message with no top-level
// code (PREDEPLOY finding F-01, AD-131), and quoting any message
// would put that SQL in the boot log. The driver code, when one
// exists, is recovered from the cause chain by the reader; a
// migration tag appears only when the error itself legitimately
// carries one (manifest and drift failures), never from the apply
// wrapper, which claims no tag because the post-failure journal
// state does not identify the failing migration. Every branch
// below composes its message from fixed
// templates plus validated tokens, so no log line from this
// function can contain SQL, a URL, or credential material.
function toFailedMigrationOutcome(error: unknown): Extract<StartupMigrationOutcome, { status: 'failed' }> {
  const details = readMigrationErrorDetails(error);
  const code = details.code;
  if (code !== undefined && DATABASE_UNREACHABLE_CODES.has(code)) {
    return {
      status: 'failed',
      kind: 'database-unreachable',
      message:
        'The database could not be reached during startup migrations ' +
        `(DATABASE_URL is configured; connection error ${code}). ` +
        'Startup fails; no traffic is served.',
    };
  }
  if (code === MIGRATION_LOCK_TIMEOUT_CODE) {
    return {
      status: 'failed',
      kind: 'migration-failed',
      message:
        'Startup migrations failed: timed out waiting for the migration advisory lock. ' +
        'Startup fails; no traffic is served.',
    };
  }
  if (code === MIGRATION_MANIFEST_CODE) {
    const tagSuffix = details.migrationTag !== undefined ? ` (migration ${details.migrationTag})` : '';
    return {
      status: 'failed',
      kind: 'migration-failed',
      message:
        `Startup migrations failed: the migration manifest could not be read (_journal.json)${tagSuffix}. ` +
        'Startup fails; no traffic is served.',
    };
  }
  if (code === MIGRATION_DRIFT_CODE) {
    const tags = details.missingTags;
    const detail =
      tags !== undefined && tags.length > 0 ? ` (missing or changed migrations: ${tags.join(', ')})` : '';
    return {
      status: 'failed',
      kind: 'migration-failed',
      message:
        `Startup migrations failed: migration drift detected${detail}. ` +
        'Startup fails; no traffic is served.',
    };
  }
  if (code !== undefined || details.migrationTag !== undefined) {
    const parts: string[] = [];
    if (code !== undefined) {
      parts.push(`database error ${code}`);
    }
    if (details.migrationTag !== undefined) {
      parts.push(`migration ${details.migrationTag}`);
    }
    return {
      status: 'failed',
      kind: 'migration-failed',
      message: `Startup migrations failed (${parts.join('; ')}). Startup fails; no traffic is served.`,
    };
  }
  return {
    status: 'failed',
    kind: 'migration-failed',
    message: 'Startup migrations failed for an unknown reason. Startup fails; no traffic is served.',
  };
}

// Refusal message for the flag-false drift case, built from the drift
// comparison itself: missing tags are named (migration names only),
// unexpected digests are counted, never quoted.
function describeDriftRefusal(drift: DriftResult): string {
  const parts: string[] = [];
  if (drift.missingTags.length > 0) {
    parts.push(`missing or changed migrations: ${drift.missingTags.join(', ')}`);
  }
  if (drift.unexpectedHashes.length > 0) {
    parts.push(`${drift.unexpectedHashes.length} unexpected applied digests`);
  }
  const detail = parts.length > 0 ? ` (${parts.join('; ')})` : '';
  return (
    `Migration drift detected${detail}. MIGRATE_ON_START is 'false', so startup refuses ` +
    'to serve traffic on a drifted schema; apply migrations manually, then restart.'
  );
}

export async function runStartupMigrationStep(deps: StartupMigrationStepDeps): Promise<StartupMigrationOutcome> {
  const runners: StartupMigrationRunners = deps.runners ?? { runMigrations, checkMigrationDrift };
  if (deps.databaseUrl === undefined) {
    deps.log('Startup migrations skipped: DATABASE_URL is not set.');
    return { status: 'skipped' };
  }
  if (!deps.migrateOnStart) {
    let result: CheckDriftResult;
    try {
      result = await runners.checkMigrationDrift({ databaseUrl: deps.databaseUrl });
    } catch (error: unknown) {
      return toFailedMigrationOutcome(error);
    }
    if (!result.drift.current) {
      return { status: 'failed', kind: 'migration-failed', message: describeDriftRefusal(result.drift) };
    }
    deps.log(
      'Startup migrations disabled by MIGRATE_ON_START=false; ' +
        `drift check passed (${result.drift.appliedCount}/${result.drift.expectedCount} migrations applied).`,
    );
    return { status: 'current' };
  }
  let result: RunMigrationsResult;
  try {
    // Only the database URL is passed: the lock timeout keeps the
    // migrate.ts default of 30 seconds and the migrations folder
    // keeps the default resolution (MIGRATIONS_FOLDER honored).
    result = await runners.runMigrations({ databaseUrl: deps.databaseUrl });
  } catch (error: unknown) {
    return toFailedMigrationOutcome(error);
  }
  if (result.appliedTags.length > 0) {
    deps.log(`Startup migrations applied: ${result.appliedTags.join(', ')}.`);
  } else {
    deps.log('Startup migrations current: no pending migrations.');
  }
  return { status: 'migrated', appliedTags: result.appliedTags };
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
  const migration = await runStartupMigrationStep({
    databaseUrl: config.databaseUrl,
    migrateOnStart: isMigrateOnStartEnabled(),
    log: (message) => {
      console.log(message);
    },
  });
  if (migration.status === 'failed') {
    // Fail-fast (AD-104 E-3 Opsi A): exit before the pool, the auth
    // context, buildApp, and listen exist, so no ready response can
    // claim the server is up. The message was sanitized by the step:
    // it names variables, migration files, the lock, or a machine
    // error code, never a URL, SQL, or credential value.
    console.error(`Failed to start: ${migration.message}`);
    process.exit(1);
  }
  const pool: HealthDbPool | null = createPool(config.databaseUrl, config.checkTimeoutMs);
  // Production auth context (V3-01): builds the Drizzle-backed store
  // lazily from DATABASE_URL and reads secret values from the
  // environment. With no DATABASE_URL the store is null and every
  // auth path fails closed; the server still boots so health keeps
  // reporting readiness honestly.
  const auth = createAuthContextFromConfig(config);
  const prerequisite = await enforceSetupBootPrerequisite(
    auth.store,
    {
      setupTokenConfigured: config.setupTokenConfigured,
      setupTokenLengthOk: config.setupTokenLengthOk,
    },
    (message) => {
      console.warn(message);
    },
  );
  if (prerequisite === 'refused') {
    // Refusal message names the variable only, never its value,
    // matching the safeLoadConfig refusal style above.
    console.error(
      `Failed to start: SETUP_TOKEN must be set with at least ${MIN_SECRET_LENGTH} characters when the database holds no accounts.`,
    );
    try {
      await auth.close();
    } catch {
      // Ignore close errors during refused startup.
    }
    try {
      await closePool(pool);
    } catch {
      // Ignore pool close errors during refused startup.
    }
    process.exit(1);
  }
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
