// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Wave M3: conversations, chat messages, conversation compactions.
//
// Source: fase1/desain-sql-adapter.md section 1.2 (V1-03), wave M3.
// The upstream table chats is renamed chat_messages. Sync columns
// (syncId, syncUpdatedAt) are not created: the server is the single
// source of truth and the sync protocol is deleted (AD-11).
//
// The value sets for chat_messages role and type carry no CHECK
// constraint: V1-03 assumption A4 records them as unverified, and the
// service layer validates them instead.

import { desc } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { workspaces } from './m1-foundation.js';
import { tags } from './m2-records.js';

export const conversations = pgTable(
  'conversations',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    // Denormalized: maintained in the same transaction as message writes.
    messageCount: integer('message_count').notNull().default(0),
    isPinned: boolean('is_pinned').notNull().default(false),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('conversations_workspace_updated_idx').on(t.workspaceId, desc(t.updatedAt))],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: bigint('conversation_id', { mode: 'number' })
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    // Kept for the legacy per-tag read path (getChats, clearChatsByTagId).
    // New read paths use conversation_id.
    tagId: bigint('tag_id', { mode: 'number' }).references(() => tags.id, { onDelete: 'set null' }),
    content: text('content'),
    role: text('role').notNull(),
    type: text('type').notNull(),
    image: text('image'),
    images: jsonb('images').$type<unknown[]>(),
    imageAnalyses: jsonb('image_analyses').$type<unknown[]>(),
    attachments: jsonb('attachments').$type<unknown[]>(),
    inserted: boolean('inserted').notNull().default(false),
    ragSources: jsonb('rag_sources').$type<unknown[]>(),
    ragSourceDetails: jsonb('rag_source_details').$type<unknown[]>(),
    agentHistory: jsonb('agent_history').$type<unknown[]>(),
    thinking: text('thinking'),
    quoteData: jsonb('quote_data').$type<Record<string, unknown>>(),
    condensedContent: text('condensed_content'),
    condensedAt: timestamp('condensed_at', { withTimezone: true, mode: 'date' }),
    originalTokenCount: integer('original_token_count'),
    originalMessageCount: integer('original_message_count'),
    uiBlocks: jsonb('ui_blocks').$type<unknown[]>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('chat_messages_workspace_conversation_idx').on(t.workspaceId, t.conversationId, t.id),
    index('chat_messages_workspace_tag_idx').on(t.workspaceId, t.tagId, t.id),
  ],
);

export const conversationCompactions = pgTable(
  'conversation_compactions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: bigint('conversation_id', { mode: 'number' })
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    // Logical reference to chat_messages, deliberately without a foreign
    // key so compaction history survives message pruning.
    coveredThroughChatId: bigint('covered_through_chat_id', { mode: 'number' }).notNull(),
    tailStartChatId: bigint('tail_start_chat_id', { mode: 'number' }),
    sourceTokenCount: integer('source_token_count').notNull(),
    summaryTokenCount: integer('summary_token_count').notNull(),
    model: text('model').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    revision: integer('revision').notNull(),
    retainedTurnCount: integer('retained_turn_count').notNull().default(0),
    prunedToolResultCount: integer('pruned_tool_result_count').notNull().default(0),
    prunedToolTokenCount: integer('pruned_tool_token_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('conversation_compactions_workspace_idx').on(t.workspaceId, t.conversationId, desc(t.revision)),
  ],
);
