// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Wave M2: records, tags, small notes, activity events.
//
// Source: fase1/desain-sql-adapter.md section 1.2 (V1-03), wave M2, and
// section 1.3 for the record_tag_metadata normalization into mark_tags.
// The three SQLite triggers over record_tag_metadata have no database
// counterpart here: their behavior moves to the service layer inside
// Drizzle transactions. This migration creates zero triggers.

import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
import { workspaces } from './m1-foundation.js';

export const tags = pgTable(
  'tags',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isLocked: boolean('is_locked').notNull().default(false),
    isPin: boolean('is_pin').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Case-sensitive, like the upstream SQLite behavior: names that differ
    // only by case are distinct.
    uniqueIndex('tags_workspace_name_key').on(t.workspaceId, t.name),
    index('tags_workspace_idx').on(t.workspaceId),
  ],
);

export const marks = pgTable(
  'marks',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // Primary tag, kept for read compatibility. The primary tag is always
    // also present as a row in mark_tags; the service layer enforces that
    // invariant on every write (V1-03 section 1.3 rule 2).
    tagId: bigint('tag_id', { mode: 'number' })
      .notNull()
      .references(() => tags.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    content: text('content'),
    url: text('url'),
    desc: text('desc'),
    // Soft delete replaces the upstream integer flag.
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    sourceId: text('source_id'),
    // Denormalized: maintained by the service layer whenever the tag set
    // of this mark changes. Replaces updatedAt on record_tag_metadata.
    tagUpdatedAt: timestamp('tag_updated_at', { withTimezone: true, mode: 'date' }),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      'marks_type_check',
      sql`${t.type} IN ('scan', 'text', 'image', 'link', 'file', 'recording', 'todo')`,
    ),
    uniqueIndex('marks_workspace_source_key').on(t.workspaceId, t.sourceId).where(sql`${t.sourceId} IS NOT NULL`),
    index('marks_workspace_tag_created_idx').on(t.workspaceId, t.tagId, desc(t.createdAt)),
    index('marks_workspace_source_idx').on(t.workspaceId, t.sourceId),
  ],
);

export const markTags = pgTable(
  'mark_tags',
  {
    markId: bigint('mark_id', { mode: 'number' })
      .notNull()
      .references(() => marks.id, { onDelete: 'cascade' }),
    tagId: bigint('tag_id', { mode: 'number' })
      .notNull()
      .references(() => tags.id, { onDelete: 'restrict' }),
    // Denormalized for workspace isolation predicates. The service layer
    // keeps it equal to marks.workspace_id; contract tests verify it.
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.markId, t.tagId] }),
    index('mark_tags_workspace_tag_idx').on(t.workspaceId, t.tagId),
  ],
);

export const notes = pgTable(
  'notes',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tagId: bigint('tag_id', { mode: 'number' })
      .notNull()
      .references(() => tags.id, { onDelete: 'restrict' }),
    content: text('content'),
    locale: text('locale').notNull(),
    // Kept as text, matching upstream.
    count: text('count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('notes_workspace_tag_idx').on(t.workspaceId, t.tagId)],
);

export const activityEvents = pgTable(
  'activity_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tagId: bigint('tag_id', { mode: 'number' }).references(() => tags.id, { onDelete: 'set null' }),
    source: text('source').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    path: text('path'),
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('activity_events_workspace_dedupe_key')
      .on(t.workspaceId, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
    index('activity_events_workspace_created_idx').on(t.workspaceId, desc(t.createdAt)),
  ],
);
