// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Wave M5: knowledge index and vector chunks.
//
// Source: fase1/desain-sql-adapter.md section 1.2 (V1-03), wave M5, and
// sections 1.6 and 1.7 for the vector format and the hash status machine.
//
// Vectors follow AD-10: the embedding column is plain text holding a JSON
// array of numbers, exactly the upstream format, plus model and dimension
// columns. This migration creates no vector extension, no vector column,
// and no HNSW index. pgvector is evaluated in Fase 2. There is no foreign
// key between the two tables: vector_chunks refers to its source
// logically (source_type plus source_id) so deleting a source never
// blocks chunk cleanup by the index job.

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
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
import { workspaces } from './m1-foundation.js';

export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceKey: text('source_key').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    title: text('title'),
    locator: jsonb('locator').$type<Record<string, unknown>>().notNull().default({}),
    contentHash: text('content_hash').notNull(),
    indexedHash: text('indexed_hash'),
    status: text('status').notNull().default('pending'),
    error: text('error'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.sourceKey] }),
    check(
      'knowledge_sources_source_type_check',
      sql`${t.sourceType} IN ('article', 'record', 'canvas')`,
    ),
    check(
      'knowledge_sources_status_check',
      sql`${t.status} IN ('pending', 'indexing', 'ready', 'failed')`,
    ),
    uniqueIndex('knowledge_sources_workspace_type_id_key').on(t.workspaceId, t.sourceType, t.sourceId),
    index('knowledge_sources_workspace_type_status_idx').on(t.workspaceId, t.sourceType, t.status),
  ],
);

export const vectorChunks = pgTable(
  'vector_chunks',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    chunkId: integer('chunk_id').notNull(),
    content: text('content').notNull(),
    // JSON array of numbers as text (AD-10). Never sent to clients, never
    // logged. Only the index worker writes this table.
    embedding: text('embedding').notNull(),
    embeddingModel: text('embedding_model'),
    embeddingDimensions: integer('embedding_dimensions'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      'vector_chunks_source_type_check',
      sql`${t.sourceType} IN ('article', 'record', 'canvas')`,
    ),
    uniqueIndex('vector_chunks_workspace_source_chunk_key').on(
      t.workspaceId,
      t.sourceType,
      t.sourceId,
      t.chunkId,
    ),
    index('vector_chunks_workspace_source_idx').on(t.workspaceId, t.sourceType, t.sourceId),
  ],
);
