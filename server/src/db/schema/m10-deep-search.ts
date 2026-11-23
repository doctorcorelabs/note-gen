// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Wave M10: Deep Search jobs (Fase 2, F2-2, wave G-F2-2a).
//
// Source: fase1/evidence/fase2/rancangan-f2-2.md sections 3.1 and 6,
// approved by Daivan 23 Nov 2026 (all 10 design recommendations).
//
// Five new tables, purely additive (expand only):
// - search_jobs: one structured literature search job per topic and
//   project. Status moves queued -> collecting -> assessing ->
//   complementing -> writing -> completed, or failed/cancelled. This
//   wave ships schema + job API only; the executor (Collector,
//   Assessor, Complement, Writer) lands in G-F2-2b..e, so jobs stay
//   queued until then.
// - search_job_steps: one row per stage per job. A Complement stage
//   that never triggers is recorded skipped with its threshold
//   reason, never silently absent.
// - search_candidates: sources found by a Collector stage. A
//   candidate becomes a structured record only in the writing stage
//   (G-F2-2e); record_mark_id links out to it and is SET NULL so the
//   project data survives job cleanup.
// - search_fact_candidates: scored fact candidates. A candidate fact
//   becomes a facts row only in the writing stage; fact_id links out
//   the same way. Score null means not yet assessed.
// - search_evidence: per-candidate/fact search trail (query, source,
//   time). No full page bodies, no credentials.
//
// No credential column exists anywhere in this schema. The Exa key
// and the PubMed E-utilities identity live in server configuration
// only (design section 3.4), never in job input or rows.
//
// Money: budget_exa_usd is the caller-approved ceiling for the job
// (null means the Exa stage must not run; decision 1). cost_exa_usd
// accumulates recorded spend per run. Both are numeric so no float
// rounding ever touches a recorded cost.

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { workspaces, users } from './m1-foundation.js';
import { agentTokens } from './m8-auth.js';
import { marks } from './m2-records.js';
import { facts } from './m9-citations.js';

export const searchJobs = pgTable(
  'search_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectKey: text('project_key').notNull(),
    topic: text('topic').notNull(),
    status: text('status').notNull().default('queued'),
    // Non-secret job input: candidate cap, year range, language,
    // stage choice, Complement thresholds. Never carries a key.
    input: jsonb('input').notNull(),
    // Caller-approved Exa ceiling for this job. Null means the Exa
    // stage must not run (PubMed-only job, decision 1).
    budgetExaUsd: numeric('budget_exa_usd'),
    costExaUsd: numeric('cost_exa_usd').notNull().default('0'),
    // Creator: a browser session user or an agent token, never both.
    // SET NULL so the job trail survives account/token removal.
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdByTokenId: uuid('created_by_token_id').references(() => agentTokens.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    // Failure surface without secrets: a stable code plus a short
    // human detail. Never holds credential values or page bodies.
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
  },
  (t) => [
    check(
      'search_jobs_status_check',
      sql`${t.status} IN ('queued', 'collecting', 'assessing', 'complementing', 'writing', 'completed', 'failed', 'cancelled')`,
    ),
    index('search_jobs_workspace_project_created_idx').on(t.workspaceId, t.projectKey, t.createdAt),
    index('search_jobs_status_created_idx').on(t.status, t.createdAt),
  ],
);

export const searchJobSteps = pgTable(
  'search_job_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => searchJobs.id, { onDelete: 'cascade' }),
    step: text('step').notNull(),
    status: text('status').notNull().default('pending'),
    // Non-secret stage detail: query counts, result counts, the
    // Complement skip reason. Never holds credential values.
    detail: jsonb('detail'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check(
      'search_job_steps_step_check',
      sql`${t.step} IN ('collector_pubmed', 'collector_exa', 'assessor', 'complement')`,
    ),
    check(
      'search_job_steps_status_check',
      sql`${t.status} IN ('pending', 'running', 'completed', 'skipped', 'failed')`,
    ),
    uniqueIndex('search_job_steps_job_step_key').on(t.jobId, t.step),
  ],
);

export const searchCandidates = pgTable(
  'search_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => searchJobs.id, { onDelete: 'cascade' }),
    sourceKind: text('source_kind').notNull(),
    // Normalized external identity: PMID, PMCID, DOI, or URL.
    externalId: text('external_id').notNull(),
    title: text('title'),
    authors: text('authors'),
    journal: text('journal'),
    year: integer('year'),
    doi: text('doi'),
    pmid: text('pmid'),
    pmcid: text('pmcid'),
    url: text('url'),
    oaFlag: boolean('oa_flag'),
    // Highlights only, never a full text body.
    snippet: text('snippet'),
    disposition: text('disposition').notNull().default('pending'),
    rejectReason: text('reject_reason'),
    // The structured record this candidate became in the writing
    // stage. SET NULL so project data survives job cleanup.
    recordMarkId: bigint('record_mark_id', { mode: 'number' }).references(() => marks.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'search_candidates_source_kind_check',
      sql`${t.sourceKind} IN ('pubmed', 'europepmc', 'exa')`,
    ),
    check(
      'search_candidates_disposition_check',
      sql`${t.disposition} IN ('pending', 'accepted', 'duplicate', 'rejected')`,
    ),
    uniqueIndex('search_candidates_job_external_key').on(t.jobId, t.externalId),
    index('search_candidates_job_idx').on(t.jobId),
  ],
);

export const searchFactCandidates = pgTable(
  'search_fact_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => searchJobs.id, { onDelete: 'cascade' }),
    factText: text('text').notNull(),
    // Assessor confidence 0-100. Null means not yet assessed; an
    // unassessed candidate is never treated as mapped.
    score: integer('score'),
    status: text('status').notNull().default('pending'),
    // The facts row this candidate became in the writing stage.
    factId: uuid('fact_id').references(() => facts.id, { onDelete: 'set null' }),
    assessorNote: text('assessor_note'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'search_fact_candidates_score_check',
      sql`${t.score} IS NULL OR (${t.score} >= 0 AND ${t.score} <= 100)`,
    ),
    check(
      'search_fact_candidates_status_check',
      sql`${t.status} IN ('pending', 'mapped', 'unmapped')`,
    ),
    index('search_fact_candidates_job_idx').on(t.jobId),
  ],
);

export const searchEvidence = pgTable(
  'search_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => searchJobs.id, { onDelete: 'cascade' }),
    candidateId: uuid('candidate_id').references(() => searchCandidates.id, {
      onDelete: 'set null',
    }),
    factCandidateId: uuid('fact_candidate_id').references(() => searchFactCandidates.id, {
      onDelete: 'set null',
    }),
    queryText: text('query_text').notNull(),
    sourceKind: text('source_kind').notNull(),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    httpStatus: integer('http_status'),
    note: text('note'),
  },
  (t) => [
    check(
      'search_evidence_source_kind_check',
      sql`${t.sourceKind} IN ('pubmed', 'europepmc', 'exa')`,
    ),
    index('search_evidence_job_idx').on(t.jobId),
  ],
);
