// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// M8 data procedure (AD-30 D3/D5). Runs OUTSIDE the SQL migrations:
// migrations are DDL-only (V1-03 section 2.1), so the row-level moves
// between the expand migration (0001) and the tighten migration (0002)
// live here, as a reviewable, rerunnable script. It uses the `postgres`
// driver directly with fixed SQL statements and no client input; it
// deliberately does NOT import the Drizzle schema, because the final
// schema no longer defines the expand-state columns this procedure
// reads (users.login, workspaces.owner_id, audit_events.actor_id).
//
// Modes (DATABASE_URL comes from the environment only; it is never
// printed, and no row value is ever printed: output is step names and
// row counts only):
//
//   preflight          Read-only. For the empty-database path (AD-13):
//                      asserts the database holds 0 rows on the five
//                      procedure targets and no M8 table yet. Run it
//                      before a single full runMigrations call and keep
//                      its output as the no-op evidence. Never writes.
//   backfill           For databases with pre-M8 rows (dev/test):
//                      runs only on an expand-state database (0001
//                      applied, 0002 not applied, old and new columns
//                      both present, users.email still nullable).
//                      Fail-closed pre-checks run before any write;
//                      each write step runs in its own transaction and
//                      touches only rows not yet migrated, so a rerun
//                      is a safe no-op. Run it with no application
//                      traffic: it deletes every sessions row, because
//                      pre-M8 sessions cannot gain a CSRF hash or an
//                      epoch copy from their old rows.
//   make-expand-folder <dest>
//                      Builds a copy of server/drizzle/ trimmed to the
//                      0000 + 0001 entries, for stopping the migrator
//                      after expand via the MIGRATIONS_FOLDER override.
//                      The committed migration files are never touched.
//                      <dest> must not exist yet.
//
// Ordering (see laporan-v3-01a-m8.md): empty databases take one full
// runMigrations call (preflight first, as evidence). Databases with
// rows take the P path: make-expand-folder, runMigrations with
// MIGRATIONS_FOLDER set to the trimmed copy, backfill, then
// runMigrations with the full folder. Recovery after a failed full
// run on a database with rows: backfill, then rerun runMigrations;
// the failed tighten entry was never journaled, so the rerun applies
// 0002 + 0003 (0004 after the backfill too, in journal order).
//
// Exit codes: 0 success, 2 fail-closed refusal (expected, named step,
// counts only), 1 unexpected error. A refusal writes nothing.

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const EMAIL_PATTERN = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

const M8_TABLES = [
  'agent_tokens',
  'totp_credentials',
  'recovery_codes',
  'login_challenges',
  'account_action_tokens',
  'rate_limit_buckets',
  'account_lockouts',
  'installation_state',
];

const TARGET_TABLES = ['users', 'sessions', 'api_tokens', 'audit_events', 'workspaces'];

function failClosed(step, detail) {
  console.error(`REFUSED step=${step} ${detail}`);
  process.exit(2);
}

function drizzleDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path, 'utf8'), 'utf8').digest('hex');
}

async function tableExists(sql, table) {
  const rows = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${table} LIMIT 1`;
  return rows.length > 0;
}

async function countRows(sql, table) {
  const rows = await sql.unsafe(`SELECT COUNT(*)::bigint AS n FROM "public"."${table}"`);
  return Number(rows[0].n);
}

async function columnNullable(sql, table, column) {
  const rows = await sql`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`;
  if (rows.length === 0) {
    return null;
  }
  return rows[0].is_nullable === 'YES';
}

async function requireColumns(sql, table, columns) {
  for (const column of columns) {
    const rows = await sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column} LIMIT 1`;
    if (rows.length === 0) {
      failClosed('state-guard', `${table}.${column} is missing; not an expand-state database.`);
    }
  }
}

function connect() {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    console.error('ERROR: DATABASE_URL is required (environment only).');
    process.exit(1);
  }
  return postgres(url, { max: 1 });
}

async function runPreflight() {
  const sql = connect();
  try {
    for (const table of M8_TABLES) {
      if (await tableExists(sql, table)) {
        failClosed('preflight', `table ${table} already exists; database is past expand.`);
      }
    }
    const counts = {};
    for (const table of TARGET_TABLES) {
      counts[table] = (await tableExists(sql, table)) ? await countRows(sql, table) : 0;
    }
    const parts = TARGET_TABLES.map((t) => `${t}=${counts[t]}`).join(' ');
    if (TARGET_TABLES.some((t) => counts[t] > 0)) {
      failClosed('preflight', `non-empty database (${parts}); use the backfill path.`);
    }
    console.log(`M8-PROCEDURE mode=preflight result=ok ${parts}`);
  } finally {
    await sql.end();
  }
}

async function checkJournalState(sql) {
  const dir = drizzleDir();
  let expandHash;
  let tightenHash;
  let contractColumnsHash;
  let contractTablesHash;
  try {
    expandHash = await sha256File(join(dir, '0001_m8-expand.sql'));
    tightenHash = await sha256File(join(dir, '0002_m8-tighten.sql'));
    contractColumnsHash = await sha256File(join(dir, '0003_m8-contract-columns.sql'));
    contractTablesHash = await sha256File(join(dir, '0004_m8-contract-tables.sql'));
  } catch {
    failClosed('journal-guard', 'migration SQL files not found next to this script; run from a checkout.');
  }
  let applied;
  try {
    const rows = await sql`SELECT "hash" FROM "drizzle"."__drizzle_migrations"`;
    applied = new Set(rows.map((row) => String(row.hash)));
  } catch (error) {
    if (error && error.code === '42P01') {
      failClosed('journal-guard', 'drizzle journal table is missing; expand has not been applied.');
    }
    throw error;
  }
  if (!applied.has(expandHash)) {
    failClosed('journal-guard', 'expand migration 0001 is not journaled; apply expand first.');
  }
  for (const [tag, hash] of [
    ['0002', tightenHash],
    ['0003', contractColumnsHash],
    ['0004', contractTablesHash],
  ]) {
    if (applied.has(hash)) {
      failClosed('journal-guard', `migration ${tag} is already journaled; backfill is too late.`);
    }
  }
}

async function runBackfill() {
  const sql = connect();
  try {
    await checkJournalState(sql);
    for (const table of ['users', 'sessions', 'workspaces', 'audit_events', 'devices', 'api_tokens']) {
      if (!(await tableExists(sql, table))) {
        failClosed('state-guard', `table ${table} is missing; not an expand-state database.`);
      }
    }
    await requireColumns(sql, 'users', [
      'login',
      'email',
      'is_admin',
      'suspended_at',
      'totp_secret',
      'credential_epoch',
    ]);
    await requireColumns(sql, 'workspaces', ['owner_id', 'owner_user_id']);
    await requireColumns(sql, 'audit_events', [
      'actor_id',
      'action',
      'target_type',
      'target_id',
      'ip_hash',
      'user_id',
      'actor_user_id',
      'event_type',
      'ip',
      'user_agent',
      'metadata',
    ]);
    if ((await columnNullable(sql, 'users', 'email')) !== true) {
      failClosed('state-guard', 'users.email is already NOT NULL; tighten has run.');
    }

    // Pre-checks: read-only, before any write. Counts only.
    // Parameterized on purpose: the pattern travels as a bound value,
    // so no SQL string-literal escaping can change what the regex
    // sees. See laporan-v3-01a-m8.md for the escape defect this
    // replaces (a plain JS literal collapsed the whitespace class
    // into the letter s and refused valid logins).
    const badLogin = await sql`
      SELECT COUNT(*)::bigint AS n FROM "public"."users" WHERE btrim("login") !~ ${EMAIL_PATTERN}`;
    if (Number(badLogin[0].n) > 0) {
      failClosed('check-login-email', `non-email logins=${badLogin[0].n}; escalate, do not invent emails.`);
    }
    const dupEmail = await sql`
      SELECT COUNT(*)::bigint AS n FROM (
        SELECT lower(btrim("login")) AS g FROM "public"."users" GROUP BY 1 HAVING COUNT(*) > 1
      ) d`;
    if (Number(dupEmail[0].n) > 0) {
      failClosed('check-email-unique', `duplicate normalized emails groups=${dupEmail[0].n}; escalate.`);
    }
    const outOfRange = await sql`
      SELECT COUNT(*)::bigint AS n FROM "public"."users"
      WHERE "credential_epoch" < ${INT32_MIN} OR "credential_epoch" > ${INT32_MAX}`;
    if (Number(outOfRange[0].n) > 0) {
      failClosed('check-epoch-range', `credential_epoch out of int32 range rows=${outOfRange[0].n}; escalate.`);
    }
    const tokenCount = await countRows(sql, 'api_tokens');
    if (tokenCount > 0) {
      failClosed('check-api-tokens', `api_tokens rows=${tokenCount}; no silent copy; escalate.`);
    }
    const totpCountRows = await sql`
      SELECT COUNT(*)::bigint AS n FROM "public"."users" WHERE "totp_secret" IS NOT NULL`;
    const totpSecretCount = Number(totpCountRows[0].n);
    const auditBefore = await countRows(sql, 'audit_events');

    // Step 1: users. Only rows whose new email is still NULL move.
    const usersMoved = await sql.begin(async (tx) => {
      const rows = await tx.unsafe(
        `UPDATE "public"."users" SET "email" = lower(btrim("login")), ` +
          `"role" = CASE WHEN "is_admin" THEN 'admin' ELSE 'user' END, ` +
          `"status" = CASE WHEN "suspended_at" IS NOT NULL THEN 'disabled' ELSE 'active' END, ` +
          `"disabled_at" = "suspended_at", "totp_enabled" = false ` +
          `WHERE "email" IS NULL`,
      );
      return Number(rows.count);
    });
    const usersNull = await sql`SELECT COUNT(*)::bigint AS n FROM "public"."users" WHERE "email" IS NULL`;
    if (Number(usersNull[0].n) > 0) {
      failClosed('verify-users', `users with NULL email remain=${usersNull[0].n}.`);
    }

    // Step 2: workspaces. Only rows whose new owner column is NULL move.
    const workspacesMoved = await sql.begin(async (tx) => {
      const rows = await tx.unsafe(
        `UPDATE "public"."workspaces" SET "owner_user_id" = "owner_id" WHERE "owner_user_id" IS NULL`,
      );
      return Number(rows.count);
    });
    const workspacesNull = await sql`
      SELECT COUNT(*)::bigint AS n FROM "public"."workspaces" WHERE "owner_user_id" IS NULL`;
    if (Number(workspacesNull[0].n) > 0) {
      failClosed('verify-workspaces', `workspaces with NULL owner_user_id remain=${workspacesNull[0].n}.`);
    }

    // Step 3: audit fold. Only rows whose new event_type is NULL move.
    // The old target pair is folded into metadata; the old IP hash is
    // not reversible and becomes NULL, as is the old subject.
    const auditMoved = await sql.begin(async (tx) => {
      const rows = await tx.unsafe(
        `UPDATE "public"."audit_events" SET "actor_user_id" = "actor_id", "event_type" = "action", ` +
          `"metadata" = jsonb_build_object('target_type', "target_type", 'target_id', "target_id") ` +
          `WHERE "event_type" IS NULL`,
      );
      return Number(rows.count);
    });
    const auditAfter = await countRows(sql, 'audit_events');
    if (auditAfter !== auditBefore) {
      failClosed('verify-audit', `audit row count changed before=${auditBefore} after=${auditAfter}.`);
    }
    const auditUnfolded = await sql`
      SELECT COUNT(*)::bigint AS n FROM "public"."audit_events"
      WHERE "event_type" IS NULL AND "action" IS NOT NULL`;
    if (Number(auditUnfolded[0].n) > 0) {
      failClosed('verify-audit', `unfolded audit rows remain=${auditUnfolded[0].n}.`);
    }

    // Step 4: session invalidation. Pre-M8 sessions cannot gain a
    // CSRF hash or an epoch copy; users sign in again after M8.
    const sessionsDeleted = await sql.begin(async (tx) => {
      const rows = await tx.unsafe(`DELETE FROM "public"."sessions"`);
      return Number(rows.count);
    });

    // Step 5: token no-op verification (no copy is ever written).
    const tokensAfter = await countRows(sql, 'api_tokens');
    if (tokensAfter !== 0) {
      failClosed('verify-tokens', `api_tokens rows=${tokensAfter} after procedure.`);
    }
    const totpLeak = await sql`
      SELECT COUNT(*)::bigint AS n FROM "public"."totp_credentials" tc
      JOIN "public"."users" u ON u."id" = tc."user_id" WHERE u."totp_secret" IS NOT NULL`;
    if (Number(totpLeak[0].n) > 0) {
      failClosed('verify-totp', `totp_credentials rows for old-secret accounts=${totpLeak[0].n}.`);
    }

    console.log(
      'M8-PROCEDURE mode=backfill result=ok ' +
        `users_moved=${usersMoved} workspaces_moved=${workspacesMoved} ` +
        `audit_folded=${auditMoved} sessions_deleted=${sessionsDeleted} ` +
        `api_tokens=${tokensAfter} totp_secret_accounts=${totpSecretCount} ` +
        `audit_rows=${auditAfter}`,
    );
  } finally {
    await sql.end();
  }
}

async function runMakeExpandFolder(dest) {
  if (dest === undefined || dest.trim() === '') {
    console.error('Usage: m8-data-procedure.mjs make-expand-folder <dest>');
    process.exit(1);
  }
  try {
    await stat(dest);
    console.error(`ERROR: destination already exists: ${dest}`);
    process.exit(1);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  const src = drizzleDir();
  const journal = JSON.parse(await readFile(join(src, 'meta', '_journal.json'), 'utf8'));
  const kept = journal.entries.filter((entry) => entry.idx === 0 || entry.idx === 1);
  if (kept.length !== 2) {
    console.error('ERROR: journal does not hold exactly the 0000 + 0001 entries to keep.');
    process.exit(1);
  }
  await mkdir(join(dest, 'meta'), { recursive: true });
  for (const entry of kept) {
    await cp(join(src, `${entry.tag}.sql`), join(dest, `${entry.tag}.sql`));
  }
  await writeFile(
    join(dest, 'meta', '_journal.json'),
    `${JSON.stringify({ version: journal.version, dialect: journal.dialect, entries: kept }, null, 2)}\n`,
    'utf8',
  );
  console.log(
    `M8-PROCEDURE mode=make-expand-folder result=ok dest=${dest} ` +
      `tags=${kept.map((entry) => entry.tag).join(',')}`,
  );
}

const mode = process.argv[2];
if (mode === 'preflight') {
  await runPreflight();
} else if (mode === 'backfill') {
  await runBackfill();
} else if (mode === 'make-expand-folder') {
  await runMakeExpandFolder(process.argv[3]);
} else {
  console.error('Usage: m8-data-procedure.mjs <preflight|backfill|make-expand-folder [dest]>');
  process.exit(1);
}
