// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Schema entry point: every table of waves M1 to M10, in dependency order.
//
// drizzle-kit reads this file (see server/drizzle.config.ts). The schema
// object below is the single registry passed to drizzle(); endpoint
// workers import tables from here or from server/src/db/index.ts, never
// from the wave files directly, so a future wave split does not move
// import paths.
//
// No relations() are defined. Cross-table reads use explicit queries and
// joins in the service layer, which keeps the wave files acyclic (each
// wave imports only earlier waves) and keeps the schema usable without a
// relations graph. Relations may be added later without a migration,
// since they change no database object.

export * from './m1-foundation.js';
export * from './m8-auth.js';
export * from './m2-records.js';
export * from './m3-conversations.js';
export * from './m4-canvas-files.js';
export * from './m5-knowledge.js';
export * from './m6-wiki.js';
export * from './m7-memory.js';
export * from './m9-citations.js';
export * from './m10-deep-search.js';

import {
  auditEvents,
  idempotencyKeys,
  sessions,
  settingRevisions,
  settings,
  secrets,
  users,
  workspaceMembers,
  workspaces,
} from './m1-foundation.js';
import {
  accountActionTokens,
  accountLockouts,
  agentTokens,
  installationState,
  loginChallenges,
  rateLimitBuckets,
  recoveryCodes,
  totpCredentials,
  totpEnrollmentStages,
} from './m8-auth.js';
import { activityEvents, markTags, marks, notes, tags } from './m2-records.js';
import { chatMessages, conversationCompactions, conversations } from './m3-conversations.js';
import { canvases, fileEvents, files, imageAnalysisCache } from './m4-canvas-files.js';
import { knowledgeSources, vectorChunks } from './m5-knowledge.js';
import { wikiJobs, wikiMeta, wikiPages, wikiRevisions, wikiSegments, wikiSources } from './m6-wiki.js';
import { memories, memoryJobs, memoryPolicies } from './m7-memory.js';
import { citationReferences, factReferences, facts, markBibliography } from './m9-citations.js';
import {
  searchCandidates,
  searchEvidence,
  searchFactCandidates,
  searchJobs,
  searchJobSteps,
} from './m10-deep-search.js';

// Listed explicitly, one entry per table, so no helper export (such as
// the bytea column builder) can leak into the Drizzle schema object.
export const schema = {
  users,
  sessions,
  workspaces,
  workspaceMembers,
  settings,
  settingRevisions,
  secrets,
  auditEvents,
  idempotencyKeys,
  agentTokens,
  totpCredentials,
  totpEnrollmentStages,
  recoveryCodes,
  loginChallenges,
  accountActionTokens,
  rateLimitBuckets,
  accountLockouts,
  installationState,
  tags,
  marks,
  markTags,
  notes,
  activityEvents,
  conversations,
  chatMessages,
  conversationCompactions,
  canvases,
  files,
  fileEvents,
  imageAnalysisCache,
  knowledgeSources,
  vectorChunks,
  wikiSources,
  wikiRevisions,
  wikiPages,
  wikiJobs,
  wikiSegments,
  wikiMeta,
  memories,
  memoryJobs,
  memoryPolicies,
  citationReferences,
  facts,
  factReferences,
  markBibliography,
  searchJobs,
  searchJobSteps,
  searchCandidates,
  searchFactCandidates,
  searchEvidence,
};
