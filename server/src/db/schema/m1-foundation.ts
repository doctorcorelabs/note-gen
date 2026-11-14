// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Wave M1: foundation tables (auth, workspace, settings, secrets).
//
// Source: fase1/desain-sql-adapter.md section 1.2 (V1-03), wave M1,
// with the auth shape of fase1/desain-auth.md section 1 (V1-08)
// applied by the forward-only M8 migrations 0001-0003 (AD-25).
// Table and column names are snake_case in Postgres; the service layer
// maps them to camelCase JSON. Times are timestamptz in the database and
// epoch milliseconds in the API. Status values use text plus CHECK, never
// a Postgres enum type, so new values need no type migration.
//
// History: the 0000 migration holds the V1-03 M1 shape (login,
// api_tokens, owner_id, devices table). Migration 0001 added the V1-08
// columns and tables, migration 0002 tightened them after the data
// procedure ran, migration 0003 removes the old M1 columns, and
// migration 0004 removes the devices and api_tokens tables. This
// intermediate state still defines those two tables; the final shape
// is reached at migration 0004.

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Binary column type. drizzle-orm pg-core has no built-in bytea builder,
// so the type is declared explicitly. The postgres.js driver maps bytea
// to and from Buffer values.
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

// IP address column type. drizzle-orm pg-core has no built-in inet
// builder, so the type is declared explicitly, mirroring bytea above.
// The postgres.js driver maps inet to and from string values.
export const inet = customType<{ data: string; driverData: string }>({
  dataType: () => 'inet',
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The only login identifier. Uniqueness is case-insensitive via
    // the lower() index below, without the citext extension (R1).
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    credentialEpoch: integer('credential_epoch').notNull().default(0),
    role: text('role').notNull().default('user'),
    status: text('status').notNull().default('active'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    disabledAt: timestamp('disabled_at', { withTimezone: true, mode: 'date' }),
    disabledReason: text('disabled_reason'),
  },
  (t) => [
    uniqueIndex('users_email_unique_idx').using('btree', sql`lower(${t.email})`),
    index('users_status_idx').on(t.status),
    check('users_role_check', sql`${t.role} IN ('user', 'admin')`),
    check('users_status_check', sql`${t.status} IN ('active', 'disabled')`),
  ],
);

// M8 contract-columns state: the devices and api_tokens tables are
// still defined here. Their columns are already unreferenced (the
// sessions device link and all old columns are gone); the tables
// themselves are dropped by migration 0004, which is generated only
// after 0003 has removed the columns and constraints. A single
// contract entry cannot drop both, because drizzle-kit emits
// DROP TABLE before DROP CONSTRAINT and the CASCADE drop of the
// devices table removes the sessions FK before its explicit
// DROP CONSTRAINT runs. See laporan-v3-01a-m8.md.
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceName: text('device_name').notNull(),
    userAgentHash: text('user_agent_hash').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [index('devices_user_id_idx').on(t.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 of the raw opaque session id. The raw value is never stored.
    sessionHash: text('session_hash').notNull(),
    // SHA-256 of the raw CSRF token for this session.
    csrfTokenHash: text('csrf_token_hash').notNull(),
    // Copy of users.credential_epoch at session creation time.
    credentialEpoch: integer('credential_epoch').notNull().default(0),
    deviceLabel: text('device_label').notNull(),
    // Raw User-Agent, truncated to 512 characters by the service layer.
    userAgent: text('user_agent'),
    createdIp: inet('created_ip'),
    lastSeenIp: inet('last_seen_ip'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    // created_at + 30 days, never extended. Idle expiry is computed in
    // code from last_seen_at + 24 hours, not from a column.
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    // Kept for audit compatibility (R6); revocation is a hard delete
    // and the audit trail lives in audit_events.
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    stepUpAt: timestamp('step_up_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('sessions_session_hash_key').on(t.sessionHash),
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_user_created_idx').on(t.userId, t.createdAt),
    index('sessions_absolute_expires_idx').on(t.absoluteExpiresAt),
  ],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('workspaces_owner_user_id_idx').on(t.ownerUserId)],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    check('workspace_members_role_check', sql`${t.role} IN ('owner', 'editor', 'viewer')`),
    index('workspace_members_user_id_idx').on(t.userId),
  ],
);

export const settings = pgTable(
  'settings',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const settingRevisions = pgTable('setting_revisions', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
});

export const secrets = pgTable(
  'secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    ref: text('ref').notNull(),
    // AES-256-GCM ciphertext plus nonce. No plaintext column exists.
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    keyVersion: integer('key_version').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [uniqueIndex('secrets_user_kind_ref_key').on(t.userId, t.kind, t.ref)],
);

// M8 contract-columns state: api_tokens is still defined here and is
// dropped by migration 0004, for the reason stated above devices.
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // SHA-256 of the raw token. The raw value is never stored.
    tokenHash: text('token_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('api_tokens_token_hash_key').on(t.tokenHash),
    index('api_tokens_user_id_idx').on(t.userId),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    // Subject of the event. Null for events without an identified
    // account (for example a failed login for an unknown email; the
    // email is never recorded, in metadata or elsewhere).
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    // Account that performed the action; differs from the subject for
    // admin actions.
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    // From the catalog in desain-auth 12.1, enforced by code, not by
    // a CHECK constraint.
    eventType: text('event_type'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    // Non-secret detail only. Must never hold passwords, tokens,
    // secrets, or credential hashes.
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_events_user_created_idx').on(t.userId, t.createdAt),
    index('audit_events_event_created_idx').on(t.eventType, t.createdAt),
    index('audit_events_created_idx').on(t.createdAt),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    // Hash of the request body. Required by V1-03 section 4.3 rule 6:
    // a reused key with a different body must be answered 409, which is
    // impossible to decide without storing the body hash. This column is
    // an addition to the V1-03 table row, which lists the contract but no
    // column for the hash. See laporan-db-schema.md.
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [uniqueIndex('idempotency_keys_user_scope_key').on(t.userId, t.scope, t.key)],
);
