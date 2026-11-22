// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Wave M9: citation foundation (Fase 2, F2-1).
//
// Source: fase1/evidence/fase2/rancangan-f2-1.md sections 2.1 and 2.2,
// approved by Daivan 22 Nov 2026 (all design recommendations).
//
// Four new tables, purely additive (expand only):
// - references: numbered bibliography entries per project. The number
//   is assigned by the service layer when the reference is first
//   mapped to a fact in the project and is stable after that; it is
//   never shifted by deletions (gaps stay gaps), so existing [n]
//   markers in notes never change meaning.
// - facts: scored facts per project. A fact with status 'unmapped'
//   never receives a marker; the service layer enforces that.
// - fact_references: bridge table; the citation map is a query over
//   this table joined to references.number, not a loose file.
// - mark_bibliography: companion table holding structured
//   bibliographic metadata for a record (mark). The marks table
//   itself is untouched (design option b).
//
// Dedupe: partial unique indexes on (workspace_id, doi) and
// (workspace_id, pmid) over references. Normalization (lowercase DOI,
// stripped prefixes) happens in the service layer before insert.

import { sql } from 'drizzle-orm';
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
import { marks } from './m2-records.js';

export const citationReferences = pgTable(
  'references',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // Project key: slug of the deck project folder (design decision 2).
    projectKey: text('project_key').notNull(),
    // Citation number [n] inside the project. Null until first mapped
    // to a fact; assigned once by the service layer, never renumbered.
    number: integer('number'),
    // Source record, when the reference came from a structured record.
    // SET NULL so the reference (and its number) survives permanent
    // deletion of the source record; bibliographic metadata below is
    // copied at creation time.
    sourceRecordId: bigint('source_record_id', { mode: 'number' }).references(() => marks.id, {
      onDelete: 'set null',
    }),
    title: text('title'),
    authors: text('authors'),
    journal: text('journal'),
    year: integer('year'),
    doi: text('doi'),
    pmid: text('pmid'),
    pmcid: text('pmcid'),
    url: text('url'),
    oaFlag: boolean('oa_flag'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('references_workspace_project_number_key').on(t.workspaceId, t.projectKey, t.number),
    uniqueIndex('references_workspace_doi_key')
      .on(t.workspaceId, t.doi)
      .where(sql`${t.doi} IS NOT NULL`),
    uniqueIndex('references_workspace_pmid_key')
      .on(t.workspaceId, t.pmid)
      .where(sql`${t.pmid} IS NOT NULL`),
    index('references_workspace_project_idx').on(t.workspaceId, t.projectKey),
  ],
);

export const facts = pgTable(
  'facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectKey: text('project_key').notNull(),
    factText: text('text').notNull(),
    score: integer('score').notNull(),
    status: text('status').notNull().default('unmapped'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check('facts_score_check', sql`${t.score} >= 0 AND ${t.score} <= 100`),
    check('facts_status_check', sql`${t.status} IN ('mapped', 'unmapped')`),
    index('facts_workspace_project_idx').on(t.workspaceId, t.projectKey),
  ],
);

export const factReferences = pgTable(
  'fact_references',
  {
    factId: uuid('fact_id')
      .notNull()
      .references(() => facts.id, { onDelete: 'cascade' }),
    referenceId: uuid('reference_id')
      .notNull()
      .references(() => citationReferences.id, { onDelete: 'cascade' }),
    // Denormalized for workspace isolation predicates, following the
    // mark_tags pattern. The service layer keeps it equal to the
    // workspace of both sides.
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.factId, t.referenceId] }),
    index('fact_references_workspace_reference_idx').on(t.workspaceId, t.referenceId),
  ],
);

export const markBibliography = pgTable(
  'mark_bibliography',
  {
    markId: bigint('mark_id', { mode: 'number' })
      .primaryKey()
      .references(() => marks.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title'),
    authors: text('authors'),
    journal: text('journal'),
    year: integer('year'),
    doi: text('doi'),
    pmid: text('pmid'),
    pmcid: text('pmcid'),
    url: text('url'),
    oaFlag: boolean('oa_flag'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('mark_bibliography_workspace_doi_idx').on(t.workspaceId, t.doi),
    index('mark_bibliography_workspace_pmid_idx').on(t.workspaceId, t.pmid),
  ],
);
