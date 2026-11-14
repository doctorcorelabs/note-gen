// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Wave M4: canvases, file index, file events, image analysis cache.
//
// Source: fase1/desain-sql-adapter.md section 1.2 (V1-03), wave M4.
// Canvas undo and redo stacks are not stored: undo history stays in
// client memory and the server stores snapshot plus version only.
// The files and file_events columns follow F2 section 4.3 as quoted by
// V1-03; V1-09 defines no Drizzle columns for them, so no reconciliation
// delta applies (assumption A3 in V1-03, see laporan-db-schema.md).

import { desc, sql } from 'drizzle-orm';
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
import { users, workspaces } from './m1-foundation.js';

export const canvases = pgTable(
  'canvases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    canvasType: text('canvas_type').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    // Relative FileStore reference.
    thumbnailPath: text('thumbnail_path'),
    pinnedAt: timestamp('pinned_at', { withTimezone: true, mode: 'date' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('canvases_workspace_idx').on(t.workspaceId)],
);

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // Workspace-relative, normalized, POSIX-style path.
    path: text('path').notNull(),
    // SHA-256 hex of the file content.
    contentHash: text('content_hash').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    // Null for directories, which have no media type.
    mimeType: text('mime_type'),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    // One active row per path. Soft-deleted rows keep their path so a
    // later file at the same path can be indexed without a clash.
    uniqueIndex('files_workspace_path_active_key')
      .on(t.workspaceId, t.path)
      .where(sql`${t.deletedAt} IS NULL`),
    index('files_workspace_path_idx').on(t.workspaceId, t.path),
  ],
);

export const fileEvents = pgTable(
  'file_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    eventType: text('event_type').notNull(),
    path: text('path').notNull(),
    previousPath: text('previous_path'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'file_events_event_type_check',
      sql`${t.eventType} IN ('created', 'changed', 'deleted', 'moved')`,
    ),
    index('file_events_workspace_idx').on(t.workspaceId),
  ],
);

export const imageAnalysisCache = pgTable(
  'image_analysis_cache',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    cacheKey: text('cache_key').notNull(),
    imageHash: text('image_hash').notNull(),
    queryHash: text('query_hash').notNull(),
    // Partial results are valid: a row may carry OCR text without a
    // visual analysis, or the reverse.
    ocrText: text('ocr_text'),
    visualAnalysis: text('visual_analysis'),
    mimeType: text('mime_type'),
    width: integer('width'),
    height: integer('height'),
    // Null means the entry does not expire on its own.
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.cacheKey] }),
    index('image_analysis_cache_workspace_hash_idx').on(t.workspaceId, t.imageHash, desc(t.updatedAt)),
  ],
);
