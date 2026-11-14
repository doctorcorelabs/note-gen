// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// LOCAL MIRROR of the M8-final table shapes, for the auth core only.
//
// This module is NOT the migration and NOT the schema registry:
// the M8 migration belongs to V3-01a (spesifikasi-migrasi-m8-auth.md,
// AD-25/AD-30) and the canonical Drizzle definitions live in
// server/src/db/schema/. This mirror exists because the auth
// endpoints must be written against the M8-final shape before the
// M8 branch lands, and trunk still carries the M1 shape. Every
// definition below was copied from the final shapes in
// spesifikasi-migrasi-m8-auth.md section 2 (net contract result,
// after expand + tighten + data procedure).
//
// INTEGRATOR SWAP: when the M8 branch is on trunk, delete this
// file and repoint the imports in auth/store.ts to the canonical
// definitions: users/workspaces/workspace_members/audit_events from
// db/schema/m1-foundation.ts (M8 shape) and totp_credentials,
// recovery_codes, login_challenges, account_action_tokens,
// rate_limit_buckets, account_lockouts, installation_state from
// db/schema/m8-auth.ts. Do NOT import this module from db/schema/
// and do NOT feed it to drizzle-kit generate: the migration SQL is
// generated from the canonical definitions only, and this mirror
// must never produce SQL.
//
// Column names and types must match the M8 net shape exactly; any
// drift is a bug. Kept intentionally minimal: only the tables and
// columns the auth core reads or writes.

import {
  bigint,
  boolean,
  check,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const tz = (name: string) => timestamp(name, { mode: 'date', withTimezone: true });

export const authUsers = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    credentialEpoch: integer('credential_epoch').notNull().default(1),
    role: text('role').notNull().default('user'),
    status: text('status').notNull().default('active'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    passwordChangedAt: tz('password_changed_at'),
    lastLoginAt: tz('last_login_at'),
    disabledAt: tz('disabled_at'),
    disabledReason: text('disabled_reason'),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_email_lower_key').on(sql`lower(${table.email})`),
    check('users_role_check', sql`${table.role} in ('user','admin')`),
    check('users_status_check', sql`${table.status} in ('active','disabled')`),
  ],
);

export const authSessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    sessionHash: text('session_hash').notNull(),
    csrfTokenHash: text('csrf_token_hash').notNull(),
    credentialEpoch: integer('credential_epoch').notNull(),
    deviceLabel: text('device_label'),
    userAgent: text('user_agent'),
    createdIp: inet('created_ip'),
    lastSeenIp: inet('last_seen_ip'),
    createdAt: tz('created_at').notNull().defaultNow(),
    lastSeenAt: tz('last_seen_at').notNull().defaultNow(),
    absoluteExpiresAt: tz('absolute_expires_at').notNull(),
    revokedAt: tz('revoked_at'),
    stepUpAt: tz('step_up_at'),
  },
  (table) => [
    uniqueIndex('sessions_session_hash_key').on(table.sessionHash),
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_absolute_expires_at_idx').on(table.absoluteExpiresAt),
  ],
);

export const authWorkspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'restrict' }),
    config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
    storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'number' }),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (table) => [index('workspaces_owner_user_id_idx').on(table.ownerUserId)],
);

export const authWorkspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => authWorkspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index('workspace_members_user_id_idx').on(table.userId),
    check('workspace_members_role_check', sql`${table.role} in ('owner','editor','viewer','member')`),
  ],
);

export const totpCredentials = pgTable('totp_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  sealedSecret: text('sealed_secret').notNull(),
  keyVersion: integer('key_version').notNull(),
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
  verifiedAt: tz('verified_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    batchId: uuid('batch_id').notNull(),
    usedAt: tz('used_at'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('recovery_codes_user_code_key').on(table.userId, table.codeHash),
    index('recovery_codes_user_id_idx').on(table.userId),
  ],
);

export const loginChallenges = pgTable(
  'login_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    challengeHash: text('challenge_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    ip: inet('ip'),
    userAgentHash: text('user_agent_hash'),
    expiresAt: tz('expires_at').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('login_challenges_challenge_hash_key').on(table.challengeHash),
    index('login_challenges_expires_at_idx').on(table.expiresAt),
    check('login_challenges_attempts_check', sql`${table.attempts} >= 0`),
  ],
);

export const accountActionTokens = pgTable(
  'account_action_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: tz('expires_at').notNull(),
    usedAt: tz('used_at'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('account_action_tokens_token_hash_key').on(table.tokenHash),
    index('account_action_tokens_expires_at_idx').on(table.expiresAt),
    check('account_action_tokens_action_check', sql`${table.action} in ('password_reset','invitation')`),
  ],
);

export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    scope: text('scope').notNull(),
    rateKey: text('rate_key').notNull(),
    windowStart: tz('window_start').notNull(),
    hits: integer('hits').notNull().default(0),
    expiresAt: tz('expires_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.rateKey, table.windowStart] }),
    check('rate_limit_buckets_hits_check', sql`${table.hits} >= 0`),
  ],
);

export const accountLockouts = pgTable(
  'account_lockouts',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lockoutLevel: integer('lockout_level').notNull().default(0),
    lockedUntil: tz('locked_until'),
    lastFailureAt: tz('last_failure_at'),
  },
  (table) => [check('account_lockouts_failures_check', sql`${table.consecutiveFailures} >= 0`)],
);

export const installationState = pgTable(
  'installation_state',
  {
    id: integer('id').primaryKey(),
    completedAt: tz('completed_at'),
    completedByUserId: uuid('completed_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (table) => [check('installation_state_single_row', sql`${table.id} = 1`)],
);

export const authAuditEvents = pgTable(
  'audit_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: uuid('user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    actorUserId: uuid('actor_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    eventType: text('event_type').notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('audit_events_user_id_idx').on(table.userId),
    index('audit_events_event_type_idx').on(table.eventType),
  ],
);

export type AuthUserRow = typeof authUsers.$inferSelect;
export type AuthSessionRow = typeof authSessions.$inferSelect;
export type AuthWorkspaceRow = typeof authWorkspaces.$inferSelect;
export type TotpCredentialRow = typeof totpCredentials.$inferSelect;
export type RecoveryCodeRow = typeof recoveryCodes.$inferSelect;
export type LoginChallengeRow = typeof loginChallenges.$inferSelect;
export type AccountLockoutRow = typeof accountLockouts.$inferSelect;
