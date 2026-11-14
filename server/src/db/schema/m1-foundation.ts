// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Wave M1: foundation tables (auth, workspace, settings, secrets).
//
// Source: fase1/desain-sql-adapter.md section 1.2 (V1-03), wave M1.
// Table and column names are snake_case in Postgres; the service layer
// maps them to camelCase JSON. Times are timestamptz in the database and
// epoch milliseconds in the API. Status values use text plus CHECK, never
// a Postgres enum type, so new values need no type migration.
//
// M8 tighten state (migration 0002): email is NOT NULL with a unique
// lower() index, credential_epoch is integer, session tightening
// columns are NOT NULL, and owner_user_id carries its RESTRICT foreign
// key. This state is only valid after the data procedure has run on an
// expand-state database. Old M1 columns are still present; they are
// removed only by the contract migration 0003. Do not read this
// intermediate state as the final shape; the final shape is documented
// in laporan-v3-01a-m8.md.

import { desc, sql } from 'drizzle-orm';
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
    login: text('login').notNull(),
    passwordHash: text('password_hash').notNull(),
    totpSecret: bytea('totp_secret'),
    credentialEpoch: integer('credential_epoch').notNull().default(0),
    isAdmin: boolean('is_admin').notNull().default(false),
    suspendedAt: timestamp('suspended_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    // M8 tighten: email is NOT NULL with a unique lower() index; the
    // data procedure must have backfilled it before migration 0002.
    email: text('email').notNull(),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    role: text('role').notNull().default('user'),
    status: text('status').notNull().default('active'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    disabledAt: timestamp('disabled_at', { withTimezone: true, mode: 'date' }),
    disabledReason: text('disabled_reason'),
  },
  (t) => [
    // Login uniqueness is case-insensitive without the citext extension.
    uniqueIndex('users_login_lower_key').using('btree', sql`lower(${t.login})`),
    uniqueIndex('users_email_unique_idx').using('btree', sql`lower(${t.email})`),
    index('users_status_idx').on(t.status),
    check('users_role_check', sql`${t.role} IN ('user', 'admin')`),
    check('users_status_check', sql`${t.status} IN ('active', 'disabled')`),
  ],
);

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
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    // SHA-256 of the raw opaque session id. The raw value is never stored.
    sessionHash: text('session_hash').notNull(),
    deviceLabel: text('device_label').notNull(),
    ipHash: text('ip_hash').notNull(),
    userAgentHash: text('user_agent_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    // M8 tighten: csrf_token_hash and absolute_expires_at are NOT NULL;
    // the data procedure must have invalidated pre-M8 sessions first.
    csrfTokenHash: text('csrf_token_hash').notNull(),
    credentialEpoch: integer('credential_epoch').notNull().default(0),
    userAgent: text('user_agent'),
    createdIp: inet('created_ip'),
    lastSeenIp: inet('last_seen_ip'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
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
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // M8 tighten: owner_user_id is NOT NULL with the RESTRICT foreign
    // key kept from M1 (R8); the data procedure backfilled it first.
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
  (t) => [
    index('workspaces_owner_id_idx').on(t.ownerId),
    index('workspaces_owner_user_id_idx').on(t.ownerUserId),
  ],
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
    // M8 expand: backfilled by the column default (migration time) for
    // pre-existing rows; recorded in laporan-v3-01a-m8.md.
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
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    ipHash: text('ip_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    // M8 expand: V1-08 columns, all nullable. The data procedure folds
    // the old columns into these; event_type has no CHECK (the catalog
    // in desain-auth 12.1 is enforced by code, not by constraint).
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    eventType: text('event_type'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('audit_events_actor_created_idx').on(t.actorId, desc(t.createdAt)),
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
