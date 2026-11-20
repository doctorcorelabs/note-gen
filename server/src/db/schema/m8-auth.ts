// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Wave M8: auth tables from design V1-08 (fase1/desain-auth.md
// section 1), arriving as a forward-only migration over the frozen
// 0000 migration (AD-25). These tables are created in their final form
// by the expand migration 0001; new tables carry no old rows, so they
// need no expand/tighten/contract staging of their own columns.
//
// Decisions applied here (see laporan-v3-01a-m8.md): R1 text plus
// lower() index, no citext; R2 text plus CHECK, no Postgres enum
// types; R3 no vector objects; R5 agent_tokens.scopes as text[];
// R7 installation_state, not server_metadata; D1 devices is removed
// by the contract migration, not defined here; D2 refresh_tokens is
// excluded from M8 and is deliberately not defined here; D4 both
// creator columns use ON DELETE SET NULL.
//
// agent_tokens is schema-only in the MVP: no endpoint issues or
// verifies agent tokens (desain-auth section 11). installation_state
// holds at most one row (id = 1); the row itself is NOT created by
// any migration (migrations are DDL-only) and the setup transaction
// in V3-01 must upsert it.

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { inet, users } from './m1-foundation.js';

export const agentTokens = pgTable(
  'agent_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 of the full raw token value. The raw value is never stored.
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    last4: text('last4').notNull(),
    name: text('name').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    workspaceIds: uuid('workspace_ids').array().notNull().default([]),
    pathPrefixes: text('path_prefixes').array(),
    credentialEpoch: integer('credential_epoch').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    createdByIp: inet('created_by_ip'),
  },
  (t) => [
    uniqueIndex('agent_tokens_token_hash_key').on(t.tokenHash),
    index('agent_tokens_user_created_idx').on(t.userId, t.createdAt),
    index('agent_tokens_expires_idx').on(t.expiresAt),
  ],
);

export const totpCredentials = pgTable('totp_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Sealed TOTP secret (AES-256-GCM, base64url of iv + tag +
  // ciphertext). No plaintext secret column exists.
  secretSealed: text('secret_sealed').notNull(),
  keyVersion: integer('key_version').notNull(),
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
  // Filled when enrollment completes, not when the secret is created.
  enrolledAt: timestamp('enrolled_at', { withTimezone: true, mode: 'date' }).notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
});

// Pending TOTP enrollment stages (DA-02-F03; desain-auth.md section
// 1.4). One row per account with an unconfirmed stage-1 secret. The
// staged secret lives here, never in the live credential row, so a
// re-enrollment that is abandoned or expires cannot destroy the
// credential the login path still verifies against. Confirm promotes
// the stage into totp_credentials in one transaction; an expired
// stage is deleted and the live credential, if any, is untouched.
// Created by migration 0005, not by the M8 expand migration.
export const totpEnrollmentStages = pgTable('totp_enrollment_stages', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Sealed staged TOTP secret (AES-256-GCM, base64url of iv + tag +
  // ciphertext), the same sealed form as totp_credentials.
  secretSealed: text('secret_sealed').notNull(),
  keyVersion: integer('key_version').notNull(),
  // When the stage was created. A stage older than 15 minutes is
  // expired (TOTP_ENROLL_STAGE_MS in services/auth/totp-enroll.ts).
  stagedAt: timestamp('staged_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 of the normalized raw code. The raw code is never stored.
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    batchId: uuid('batch_id').notNull(),
  },
  (t) => [
    index('recovery_codes_user_used_idx').on(t.userId, t.usedAt),
    index('recovery_codes_batch_idx').on(t.batchId),
  ],
);

export const loginChallenges = pgTable(
  'login_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 of the raw challenge token. The raw value is never stored.
    challengeHash: text('challenge_hash').notNull(),
    createdIp: inet('created_ip'),
    userAgentHash: text('user_agent_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('login_challenges_challenge_hash_key').on(t.challengeHash),
    index('login_challenges_expires_idx').on(t.expiresAt),
  ],
);

export const accountActionTokens = pgTable(
  'account_action_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Null for invitations, which bind an email, not an account yet.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    purpose: text('purpose').notNull(),
    // SHA-256 of the raw token. The raw value is never stored.
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    // D4: ON DELETE SET NULL. Deleting an account must not delete the
    // record of an action it created.
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('account_action_tokens_token_hash_key').on(t.tokenHash),
    index('account_action_tokens_email_purpose_expires_idx').on(t.email, t.purpose, t.expiresAt),
    check(
      'account_action_tokens_purpose_check',
      sql`${t.purpose} IN ('reset_password', 'invitation')`,
    ),
  ],
);

export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    scope: text('scope').notNull(),
    // HMAC-derived bucket key, never the raw value (no raw IP, no raw
    // email). Part of the composite primary key.
    rateKey: text('rate_key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    hits: integer('hits').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.rateKey, t.windowStart] }),
    index('rate_limit_buckets_expires_idx').on(t.expiresAt),
  ],
);

export const accountLockouts = pgTable('account_lockouts', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lockoutLevel: integer('lockout_level').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true, mode: 'date' }),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const installationState = pgTable(
  'installation_state',
  {
    // Always 1. The CHECK below guarantees a single row.
    id: integer('id').primaryKey(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    // D4: ON DELETE SET NULL. Deleting the first account must not
    // delete the installation record and reopen setup.
    completedByUserId: uuid('completed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [check('installation_state_single_row_check', sql`${t.id} = 1`)],
);
