// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Wave M6: wiki state tables.
//
// Source: fase1/desain-sql-adapter.md section 1.2 (V1-03), wave M6.
// There are no foreign keys between wiki tables, following upstream,
// which uses composite primary keys only. Consistency across wiki tables
// is enforced by transactional operations, not by foreign keys. Each
// table does carry a workspace_id foreign key to workspaces with cascade
// delete, following the section 1.1 convention that every domain table
// carries an owned workspace_id; the M6 table rows are silent on that
// column and the convention governs. See laporan-db-schema.md.
//
// Payload shapes live in jsonb and are validated by the service layer.
// No created or updated timestamp columns exist on wiki tables in V1-03;
// versioning is carried inside the payloads and the version column.

import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { workspaces } from './m1-foundation.js';

export const wikiSources = pgTable(
  'wiki_sources',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contextId: text('context_id').notNull(),
    stableId: text('stable_id').notNull(),
    sourceKey: text('source_key').notNull(),
    contentHash: text('content_hash').notNull(),
    status: text('status').notNull(),
    revisionId: text('revision_id'),
    version: integer('version').notNull().default(1),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.contextId, t.stableId] })],
);

export const wikiRevisions = pgTable(
  'wiki_revisions',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contextId: text('context_id').notNull(),
    id: text('id').notNull(),
    sourceId: text('source_id').notNull(),
    inputHash: text('input_hash').notNull(),
    outputHash: text('output_hash').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.contextId, t.id] }),
    index('wiki_revisions_workspace_hashes_idx').on(
      t.workspaceId,
      t.contextId,
      t.inputHash,
      t.outputHash,
    ),
  ],
);

export const wikiPages = pgTable(
  'wiki_pages',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contextId: text('context_id').notNull(),
    id: text('id').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.contextId, t.id] })],
);

export const wikiJobs = pgTable(
  'wiki_jobs',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contextId: text('context_id').notNull(),
    id: text('id').notNull(),
    status: text('status').notNull(),
    readyAt: timestamp('ready_at', { withTimezone: true, mode: 'date' }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.contextId, t.id] })],
);

export const wikiSegments = pgTable(
  'wiki_segments',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contextId: text('context_id').notNull(),
    cacheKey: text('cache_key').notNull(),
    // Regenerable cache: rows may be deleted at any time.
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.contextId, t.cacheKey] })],
);

export const wikiMeta = pgTable(
  'wiki_meta',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contextId: text('context_id').notNull(),
    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.contextId, t.key] })],
);
