// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Wave M7: memories, memory jobs, memory policies.
//
// Source: fase1/desain-sql-adapter.md section 1.2 (V1-03), wave M7.
// memories.id stays text because the upstream id generator was not
// verified to produce UUIDs (V1-03 assumption A5); the server uses a UUID
// string when the client sends no id. The embedding column is JSON text
// per AD-10, same as vector_chunks.
//
// memory_policies defaults follow the upstream seed in
// src/db/memory-policy.ts at HEAD 4dcaa3f: use_memories, generate_memories,
// and exclude_external_context are all seeded true, with defaults_version
// 1 on the seeded row. The column default for defaults_version stays 0
// per V1-03; the bootstrap seed, not the column default, carries the
// value 1. generation_started_at is null when generation never started,
// which is the Postgres form of the upstream integer 0.

import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users, workspaces } from './m1-foundation.js';
import { conversations } from './m3-conversations.js';

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    // JSON array of numbers as text (AD-10). Never sent to clients.
    embedding: text('embedding'),
    category: text('category').notNull(),
    kind: text('kind').notNull().default('fact'),
    scopeType: text('scope_type').notNull().default('global'),
    scopeId: text('scope_id'),
    applyMode: text('apply_mode').notNull().default('relevant'),
    status: text('status').notNull().default('active'),
    origin: text('origin').notNull().default('manual'),
    confidence: doublePrecision('confidence').notNull().default(1),
    conflictKey: text('conflict_key'),
    embeddingModel: text('embedding_model'),
    embeddingDimensions: integer('embedding_dimensions'),
    indexingStatus: text('indexing_status').notNull().default('pending'),
    sensitivity: text('sensitivity').notNull().default('normal'),
    lastRecallReason: text('last_recall_reason'),
    // Logical reference to another memory row, deliberately without a
    // foreign key.
    replacedId: text('replaced_id'),
    accessCount: integer('access_count').notNull().default(0),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true, mode: 'date' }),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check('memories_category_check', sql`${t.category} IN ('preference', 'memory')`),
    index('memories_workspace_category_idx').on(t.workspaceId, t.category),
    index('memories_workspace_access_idx').on(t.workspaceId, t.accessCount),
    index('memories_workspace_scope_idx').on(t.workspaceId, t.scopeType, t.scopeId, t.status),
    index('memories_workspace_conflict_idx').on(t.workspaceId, t.conflictKey),
    index('memories_workspace_updated_idx').on(t.workspaceId, desc(t.updatedAt)),
  ],
);

export const memoryJobs = pgTable(
  'memory_jobs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: bigint('conversation_id', { mode: 'number' })
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    status: text('status').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('memory_jobs_workspace_conversation_revision_key').on(
      t.workspaceId,
      t.conversationId,
      t.revision,
    ),
    index('memory_jobs_workspace_status_idx').on(t.workspaceId, t.status, t.updatedAt),
  ],
);

export const memoryPolicies = pgTable('memory_policies', {
  // One row per user. Replaces the upstream singleton row with id 1.
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  useMemories: boolean('use_memories').notNull().default(true),
  generateMemories: boolean('generate_memories').notNull().default(true),
  excludeExternalContext: boolean('exclude_external_context').notNull().default(true),
  generationStartedAt: timestamp('generation_started_at', { withTimezone: true, mode: 'date' }),
  defaultsVersion: integer('defaults_version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
