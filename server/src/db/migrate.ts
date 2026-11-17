// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Startup migrator: applies the versioned SQL in server/drizzle/ with a
// cross-process advisory lock, then verifies zero drift between the
// migration files and the journal table.
//
// Basis: V1-03 sections 2.2 and 2.3 (AD-05). The Drizzle schema is the
// single source of truth; SQL files are produced by drizzle-kit
// generate and are never edited by hand. This module runs those files
// through the drizzle-orm migrator; it contains no schema statements of
// its own. Seed and bootstrap rows are application code outside
// migrations, not part of this module.
//
// Advisory lock: one fixed lock key derived from the string
// 'notegen-migrations-v1', so every process agrees on the same key.
// The lock is held as a session-level lock on one reserved connection
// for the whole run. V1-03 section 2.2 names a transaction-scoped lock,
// but the drizzle migrator owns the per-migration transactions, so a
// transaction-scoped lock taken outside it cannot span the run; the
// session-level lock on a reserved connection preserves the intent
// (exactly one migrator writes the schema at a time, the other waits)
// and is strictly stronger. Acquisition uses a try-lock poll with a
// JavaScript deadline instead of an unbounded wait: timing out fails
// startup with an error that names the migration lock, never with a
// silent continue on an old schema. Workers never call this module;
// they wait for API readiness instead.
//
// Drift check: after migrating, the stored journal hashes are compared
// with fresh SHA-256 digests of the SQL files named by the journal.
// Any difference fails startup with the migration names. The ready
// endpoint reuses the same comparison without opening a new client:
// it reads the journal hashes through its own pool and calls
// assessMigrationDrift with a manifest from readMigrationManifest.
// The CI generate check (a fresh generate must produce no new file)
// is a separate gate owned by CI, not by this module.
//
// Startup wiring (owned by the server entrypoint, not by this module):
// when MIGRATE_ON_START is not 'false', call runMigrations before the
// server accepts traffic; when it is 'false', call
// checkMigrationDrift and refuse to start unless the result is
// current. When no database URL is configured, the caller skips
// migration entirely and lets readiness report the database as
// unconfigured, preserving the Fase 0 start behavior; this module
// throws on an empty URL rather than guessing.
//
// Deployment note: the migrations folder must be present wherever this
// module runs. The default folder is resolved relative to this file,
// which works both from src/ and from dist/ (dist/db/migrate.js sits
// two levels below server/, same as src/db/migrate.ts). The image
// build must therefore copy server/drizzle/ next to server/dist/.
// MIGRATIONS_FOLDER overrides the default when the layout differs.
//
// Error contract (PREDEPLOY finding F-01, AD-131): the drizzle
// migrator throws DrizzleQueryError values whose message embeds the
// failing SQL verbatim ("Failed query: ..."), with the driver code
// only on the error cause. This module never lets such a message
// reach a log line unmediated: apply failures are wrapped here with
// the fixed message "Migration apply failed.", and the driver code
// travels as a validated property that the server entrypoint reads
// through readMigrationErrorDetails. The wrapper claims no
// migration tag: the journal state left behind by a failed run
// does not identify the failing migration, because the apply is
// atomic and a mid-run failure leaves no migration applied, so
// deriving a tag from that state would name the wrong migration.
// The original error stays reachable as the wrapper cause for
// programmatic inspection only; nothing that logs the wrapper may
// log its cause, its message, or its query/params. Manifest, lock,
// and drift failures carry their own machine codes plus migration
// tags as properties, for the same reason. No error leaving this
// module is safe to log verbatim; callers log codes, families, and
// tags only, never messages.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './index.js';

export const MIGRATION_LOCK_NAME = 'notegen-migrations-v1';
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 30000;
export const DEFAULT_MIGRATION_LOCK_RETRY_MS = 100;

// Machine codes for the failure families this module produces
// itself (as opposed to driver codes such as 42P01, which arrive on
// the cause chain of a drizzle apply error). The server entrypoint
// maps each code to one fixed log template; the codes are part of
// the log contract, not free text.
export const MIGRATION_LOCK_TIMEOUT_CODE = 'MIGRATION_LOCK_TIMEOUT';
export const MIGRATION_MANIFEST_CODE = 'MIGRATION_MANIFEST_ERROR';
export const MIGRATION_DRIFT_CODE = 'MIGRATION_DRIFT';

// Structured failure details: the ONLY parts of a migration error
// that may reach a log line. Messages, SQL text, query parameters,
// and file paths are never loggable, so identity travels here, as
// validated properties, instead of inside a message string.
export interface MigrationErrorDetails {
  code?: string;
  migrationTag?: string;
  missingTags?: string[];
}

// A loggable error code is a short token of letters, digits, and
// underscores: Postgres SQLSTATE codes (42P01), Node system codes
// (ECONNREFUSED), and the MIGRATION_* family codes above. Anything
// else is treated as absent, so a hostile or malformed code value
// can never inject text into a log line.
const SAFE_ERROR_CODE_PATTERN = /^[A-Za-z0-9_]+$/;

export function isSafeMigrationErrorCode(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && SAFE_ERROR_CODE_PATTERN.test(value);
}

// A loggable migration tag is a journal file stem: it must start
// with a letter or digit and contain only letters, digits, dots,
// underscores, and hyphens. Tags come from the committed journal,
// but the pattern still applies, so a malformed journal entry can
// never inject text into a log line.
const SAFE_MIGRATION_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isSafeMigrationTag(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && SAFE_MIGRATION_TAG_PATTERN.test(value);
}

function attachMigrationErrorDetails(error: Error, details: MigrationErrorDetails): Error {
  const holder = error as unknown as Record<string, unknown>;
  if (details.code !== undefined) {
    holder.code = details.code;
  }
  if (details.migrationTag !== undefined) {
    holder.migrationTag = details.migrationTag;
  }
  if (details.missingTags !== undefined) {
    holder.missingTags = [...details.missingTags];
  }
  return error;
}

// Reads the structured details off an error and its cause chain
// (depth-capped, cycle-safe). The first valid value at each field
// wins, walking outward from the thrown error: a wrapper's code and
// tag describe the failure better than a deeper cause's. Values
// that fail validation are ignored, never repaired. This function
// never reads a message, query, or params property.
export function readMigrationErrorDetails(error: unknown): MigrationErrorDetails {
  const details: MigrationErrorDetails = {};
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      return details;
    }
    seen.add(current);
    const holder = current as Record<string, unknown>;
    if (details.code === undefined && isSafeMigrationErrorCode(holder.code)) {
      details.code = holder.code;
    }
    if (details.migrationTag === undefined && isSafeMigrationTag(holder.migrationTag)) {
      details.migrationTag = holder.migrationTag;
    }
    if (details.missingTags === undefined && Array.isArray(holder.missingTags)) {
      const tags = holder.missingTags.filter(isSafeMigrationTag).slice(0, 20);
      if (tags.length > 0) {
        details.missingTags = tags;
      }
    }
    current = holder.cause;
  }
  return details;
}

// One journal entry: the tag names the SQL file (tag + '.sql'), and the
// hash is the SHA-256 hex digest of that file, matching what the
// drizzle journal table stores for an applied migration.
export interface MigrationEntry {
  idx: number;
  tag: string;
  hash: string;
}

export interface MigrationManifest {
  folder: string;
  entries: MigrationEntry[];
}

// Pure comparison result. `missingTags` names files the database has
// not applied (or applied in a different form); `unexpectedHashes`
// carries stored digests with no matching file, reported as hashes
// because the journal table stores digests, not file names.
export interface DriftResult {
  current: boolean;
  expectedCount: number;
  appliedCount: number;
  missingTags: string[];
  unexpectedHashes: string[];
}

export interface RunMigrationsOptions {
  databaseUrl: string;
  migrationsFolder?: string;
  lockTimeoutMs?: number;
  lockRetryIntervalMs?: number;
}

export interface RunMigrationsResult {
  // Tags applied by this run, in journal order. Empty on a database
  // that was already current: a second run is a no-op.
  appliedTags: string[];
  manifest: MigrationManifest;
  drift: DriftResult;
}

export interface CheckDriftOptions {
  databaseUrl: string;
  migrationsFolder?: string;
}

export interface CheckDriftResult {
  manifest: MigrationManifest;
  drift: DriftResult;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// The two 32-bit halves of the advisory lock key, derived
// deterministically from the fixed lock name so every process,
// replica, and one-shot job computes the same key.
export function migrationAdvisoryLockKey(): { key1: number; key2: number } {
  const digest = createHash('sha256').update(MIGRATION_LOCK_NAME, 'utf8').digest();
  return { key1: digest.readInt32BE(0), key2: digest.readInt32BE(4) };
}

export function defaultMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'drizzle');
}

export function resolveMigrationsFolder(explicit?: string): string {
  if (explicit !== undefined && explicit.trim() !== '') {
    return explicit;
  }
  const fromEnv = process.env.MIGRATIONS_FOLDER;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv;
  }
  return defaultMigrationsFolder();
}

interface JournalFile {
  entries?: unknown;
}

function migrationManifestError(message: string, migrationTag?: string): Error {
  return attachMigrationErrorDetails(new Error(message), {
    code: MIGRATION_MANIFEST_CODE,
    migrationTag,
  });
}

function parseJournal(content: string, journalPath: string): Array<{ idx: number; tag: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw migrationManifestError(`Migration journal is not valid JSON: ${journalPath}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as JournalFile).entries)) {
    throw migrationManifestError(`Migration journal has no entries array: ${journalPath}`);
  }
  const entries = (parsed as JournalFile).entries as unknown[];
  return entries.map((entry, position) => {
    if (typeof entry !== 'object' || entry === null) {
      throw migrationManifestError(`Migration journal entry ${position} is not an object: ${journalPath}`);
    }
    const record = entry as { idx?: unknown; tag?: unknown };
    if (typeof record.idx !== 'number' || typeof record.tag !== 'string' || record.tag.trim() === '') {
      throw migrationManifestError(
        `Migration journal entry ${position} has no numeric idx or tag: ${journalPath}`,
      );
    }
    return { idx: record.idx, tag: record.tag };
  });
}

// Reads the journal and digests every SQL file it names, in journal
// order. Throws when the folder, the journal, or any named file is
// missing or malformed; the error names the file, never its content.
export async function readMigrationManifest(migrationsFolder?: string): Promise<MigrationManifest> {
  const folder = resolveMigrationsFolder(migrationsFolder);
  const journalPath = join(folder, 'meta', '_journal.json');
  let journalContent: string;
  try {
    journalContent = await readFile(journalPath, 'utf8');
  } catch {
    throw migrationManifestError(`Migration journal not found: ${journalPath}`);
  }
  const journalEntries = parseJournal(journalContent, journalPath).sort((a, b) => a.idx - b.idx);
  const entries: MigrationEntry[] = [];
  for (const journalEntry of journalEntries) {
    const sqlPath = join(folder, `${journalEntry.tag}.sql`);
    let sqlContent: string;
    try {
      sqlContent = await readFile(sqlPath, 'utf8');
    } catch {
      throw migrationManifestError(
        `Migration file not found for journal entry ${journalEntry.tag}: ${sqlPath}`,
        journalEntry.tag,
      );
    }
    entries.push({
      idx: journalEntry.idx,
      tag: journalEntry.tag,
      hash: createHash('sha256').update(sqlContent, 'utf8').digest('hex'),
    });
  }
  return { folder, entries };
}

// Pure comparison of expected digests against stored digests. The
// ready endpoint calls this with hashes read through its own pool;
// the migrator calls it with hashes read through its own client.
export function assessMigrationDrift(
  manifest: MigrationManifest,
  appliedHashes: string[],
): DriftResult {
  const applied = new Set(appliedHashes);
  const expectedHashes = new Set(manifest.entries.map((entry) => entry.hash));
  const missingTags = manifest.entries
    .filter((entry) => !applied.has(entry.hash))
    .map((entry) => entry.tag);
  const unexpectedHashes = appliedHashes.filter((hash) => !expectedHashes.has(hash));
  return {
    current: missingTags.length === 0 && unexpectedHashes.length === 0,
    expectedCount: manifest.entries.length,
    appliedCount: appliedHashes.length,
    missingTags,
    unexpectedHashes,
  };
}

function describeDrift(drift: DriftResult): string {
  const parts: string[] = [];
  if (drift.missingTags.length > 0) {
    parts.push(`missing or changed migrations: ${drift.missingTags.join(', ')}`);
  }
  if (drift.unexpectedHashes.length > 0) {
    parts.push(`unexpected applied digests: ${drift.unexpectedHashes.join(', ')}`);
  }
  if (parts.length === 0) {
    return 'migration drift detected';
  }
  return `migration drift detected (${parts.join('; ')})`;
}

// Reads the stored journal digests. A missing journal table or schema
// means nothing has been applied yet and yields an empty list; any
// other database error propagates to the caller.
async function readAppliedHashes(client: Sql): Promise<string[]> {
  try {
    const rows = await client`SELECT "hash" FROM "drizzle"."__drizzle_migrations" ORDER BY "created_at" ASC, "hash" ASC`;
    return rows.map((row) => String(row.hash));
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === '42P01' || code === '3F000') {
      return [];
    }
    throw error;
  }
}

// Read-only drift check against a live database. Opens its own client
// and closes it before returning. Returns the comparison; it never
// throws merely because the database is behind.
export async function checkMigrationDrift(options: CheckDriftOptions): Promise<CheckDriftResult> {
  if (options.databaseUrl.trim() === '') {
    throw new Error('checkMigrationDrift requires a non-empty database URL.');
  }
  const manifest = await readMigrationManifest(options.migrationsFolder);
  const handle = createDb(options.databaseUrl, { max: 1 });
  try {
    const appliedHashes = await readAppliedHashes(handle.client);
    return { manifest, drift: assessMigrationDrift(manifest, appliedHashes) };
  } finally {
    await handle.close();
  }
}

async function acquireMigrationLock(
  reserved: Awaited<ReturnType<Sql['reserve']>>,
  lockTimeoutMs: number,
  lockRetryIntervalMs: number,
): Promise<void> {
  const { key1, key2 } = migrationAdvisoryLockKey();
  const deadline = Date.now() + lockTimeoutMs;
  for (;;) {
    const rows = await reserved`SELECT pg_try_advisory_lock(${key1}, ${key2}) AS acquired`;
    if (rows.length > 0 && rows[0]?.acquired === true) {
      return;
    }
    if (Date.now() >= deadline) {
      throw attachMigrationErrorDetails(
        new Error(
          'Timed out waiting for the migration advisory lock; another migrator may be running. ' +
            'Startup fails rather than continuing with a possibly stale schema.',
        ),
        { code: MIGRATION_LOCK_TIMEOUT_CODE },
      );
    }
    await sleep(lockRetryIntervalMs);
  }
}

// Wraps a failed drizzle apply run. The thrown error's message
// embeds the failing SQL verbatim and must never be logged; the
// wrapper carries the fixed message "Migration apply failed." plus
// the driver code as a validated property, and the original error
// stays reachable as cause for programmatic inspection only. The
// wrapper claims no migration tag: no journal re-read can identify
// the failing migration after an atomic apply run fails, so the
// wrapper does not guess one.
function wrapMigrationApplyError(error: unknown): Error {
  const details = readMigrationErrorDetails(error);
  const wrapped = new Error('Migration apply failed.');
  attachMigrationErrorDetails(wrapped, { code: details.code });
  (wrapped as unknown as { cause?: unknown }).cause = error;
  return wrapped;
}

// Applies pending migrations under the advisory lock, then verifies
// zero drift. Idempotent: on a current database it applies nothing and
// returns an empty appliedTags list. Throws on lock timeout, on a
// migration failure, or on post-migration drift; in all three cases
// the caller must fail startup rather than serve traffic.
export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  if (options.databaseUrl.trim() === '') {
    throw new Error('runMigrations requires a non-empty database URL; pass DATABASE_URL explicitly.');
  }
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
  const lockRetryIntervalMs = options.lockRetryIntervalMs ?? DEFAULT_MIGRATION_LOCK_RETRY_MS;
  const manifest = await readMigrationManifest(options.migrationsFolder);
  const handle = createDb(options.databaseUrl);
  let reserved: Awaited<ReturnType<Sql['reserve']>> | null = null;
  let lockHeld = false;
  try {
    reserved = await handle.client.reserve();
    await acquireMigrationLock(reserved, lockTimeoutMs, lockRetryIntervalMs);
    lockHeld = true;
    const beforeHashes = await readAppliedHashes(handle.client);
    const before = new Set(beforeHashes);
    try {
      await migrate(handle.db, { migrationsFolder: manifest.folder });
    } catch (error: unknown) {
      throw wrapMigrationApplyError(error);
    }
    const afterHashes = await readAppliedHashes(handle.client);
    const appliedTags = manifest.entries
      .filter((entry) => !before.has(entry.hash) && afterHashes.includes(entry.hash))
      .map((entry) => entry.tag);
    const drift = assessMigrationDrift(manifest, afterHashes);
    if (!drift.current) {
      throw attachMigrationErrorDetails(
        new Error(`${describeDrift(drift)}. Startup fails rather than serving traffic on a drifted schema.`),
        { code: MIGRATION_DRIFT_CODE, missingTags: drift.missingTags },
      );
    }
    return { appliedTags, manifest, drift };
  } finally {
    if (reserved !== null) {
      if (lockHeld) {
        const { key1, key2 } = migrationAdvisoryLockKey();
        try {
          await reserved`SELECT pg_advisory_unlock(${key1}, ${key2})`;
        } catch {
          // Best effort: closing the client releases the session-level
          // lock even when the explicit unlock fails.
        }
      }
      reserved.release();
    }
    await handle.close();
  }
}
