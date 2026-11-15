// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Db/transactions registration adapter (AD-61; desain registrasi
// programatik section 3.3, rank 100). Verbatim move of the
// db/transactions block of buildApp (app.ts, V3-13a; canonical
// contract section 3.4) plus the kind handler wiring (V3-13b/V3-13c).
//
// Routes declared by this group (via registerDbRoutes, routes/db.ts):
// - POST /api/transactions
// - POST /api/db/batch
// The empty-batch FIX is preserved unchanged: POST /api/db/batch
// with an empty operations array answers 400 validation_failed.
// That behavior lives in services/db/validation.ts and routes/db.ts,
// both untouched here; this adapter only registers the route.
// Deps: dbDeps from createDefaultDbRouteDeps(ctx.config)
// (services/db/deps.ts). The registry starts empty on purpose; the
// 54 kind handlers below are registered into the same registry
// instance before registerDbRoutes runs, as in app.ts (dispatch
// looks handlers up per request, so the order relative to route
// registration does not matter, but the app.ts order is kept).
// Handlers: 54 total, A 29 (V3-13b) + B 25 (V3-13c); 27 read + 27
// write; 8 handlers intentionally without a validate step answer
// 410, so validation must never mask an unavailable capability.
// No onClose hook is added here: db-close wiring (FIX-05) belongs
// to the lifecycle worker (B-12), and adapters must not add hooks
// (desain section 3.1). Handler wiring is inline verbatim from
// app.ts because handlers.generated.ts (handler scan, B-02) is not
// on trunk yet; the migration swaps this block for one
// registerDbHandlers(dbDeps.registry) call with no behavior change.

import type { RegistrationContext } from '../registration/context.js';
import { registerDbRoutes } from './db.js';
import { createDefaultDbRouteDeps } from '../services/db/deps.js';

// Db kind handlers (V3-13b): one direct import per handler file,
// no barrel (see services/db/deps.ts wiring pattern).
import { HANDLER_KIND as canvasesCreateKind, handle as canvasesCreate, validate as validateCanvasesCreate } from '../services/db/canvases-create.js';
import { HANDLER_KIND as canvasesGetKind, handle as canvasesGet, validate as validateCanvasesGet } from '../services/db/canvases-get.js';
import { HANDLER_KIND as canvasesListKind, handle as canvasesList, validate as validateCanvasesList } from '../services/db/canvases-list.js';
import { HANDLER_KIND as canvasesRestoreKind, handle as canvasesRestore, validate as validateCanvasesRestore } from '../services/db/canvases-restore.js';
import { HANDLER_KIND as canvasesSaveKind, handle as canvasesSave, validate as validateCanvasesSave } from '../services/db/canvases-save.js';
import { HANDLER_KIND as canvasesSoftDeleteKind, handle as canvasesSoftDelete, validate as validateCanvasesSoftDelete } from '../services/db/canvases-soft-delete.js';
import { HANDLER_KIND as compactionsInsertKind, handle as compactionsInsert, validate as validateCompactionsInsert } from '../services/db/compactions-insert.js';
import { HANDLER_KIND as compactionsListByConversationKind, handle as compactionsListByConversation, validate as validateCompactionsListByConversation } from '../services/db/compactions-list-by-conversation.js';
import { HANDLER_KIND as conversationsCreateKind, handle as conversationsCreate, validate as validateConversationsCreate } from '../services/db/conversations-create.js';
import { HANDLER_KIND as conversationsDeleteKind, handle as conversationsDelete, validate as validateConversationsDelete } from '../services/db/conversations-delete.js';
import { HANDLER_KIND as conversationsGetKind, handle as conversationsGet, validate as validateConversationsGet } from '../services/db/conversations-get.js';
import { HANDLER_KIND as conversationsListKind, handle as conversationsList, validate as validateConversationsList } from '../services/db/conversations-list.js';
import { HANDLER_KIND as conversationsUpdateKind, handle as conversationsUpdate, validate as validateConversationsUpdate } from '../services/db/conversations-update.js';
import { HANDLER_KIND as imageCacheGetKind, handle as imageCacheGet, validate as validateImageCacheGet } from '../services/db/image-cache-get.js';
import { HANDLER_KIND as imageCachePutKind, handle as imageCachePut, validate as validateImageCachePut } from '../services/db/image-cache-put.js';
import { HANDLER_KIND as memoriesCreateKind, handle as memoriesCreate, validate as validateMemoriesCreate } from '../services/db/memories-create.js';
import { HANDLER_KIND as memoriesDeleteKind, handle as memoriesDelete, validate as validateMemoriesDelete } from '../services/db/memories-delete.js';
import { HANDLER_KIND as memoriesGetKind, handle as memoriesGet, validate as validateMemoriesGet } from '../services/db/memories-get.js';
import { HANDLER_KIND as memoriesListKind, handle as memoriesList, validate as validateMemoriesList } from '../services/db/memories-list.js';
import { HANDLER_KIND as memoriesStatsKind, handle as memoriesStats, validate as validateMemoriesStats } from '../services/db/memories-stats.js';
import { HANDLER_KIND as memoriesUpdateKind, handle as memoriesUpdate, validate as validateMemoriesUpdate } from '../services/db/memories-update.js';
import { HANDLER_KIND as messagesAppendKind, handle as messagesAppend, validate as validateMessagesAppend } from '../services/db/messages-append.js';
import { HANDLER_KIND as messagesDeleteKind, handle as messagesDelete, validate as validateMessagesDelete } from '../services/db/messages-delete.js';
import { HANDLER_KIND as messagesGetKind, handle as messagesGet, validate as validateMessagesGet } from '../services/db/messages-get.js';
import { HANDLER_KIND as messagesListByConversationKind, handle as messagesListByConversation, validate as validateMessagesListByConversation } from '../services/db/messages-list-by-conversation.js';
import { HANDLER_KIND as messagesListByTagKind, handle as messagesListByTag, validate as validateMessagesListByTag } from '../services/db/messages-list-by-tag.js';
import { HANDLER_KIND as messagesUpdateKind, handle as messagesUpdate, validate as validateMessagesUpdate } from '../services/db/messages-update.js';
import { HANDLER_KIND as policyGetKind, handle as policyGet, validate as validatePolicyGet } from '../services/db/policy-get.js';
import { HANDLER_KIND as policyPutKind, handle as policyPut, validate as validatePolicyPut } from '../services/db/policy-put.js';

// Db kind handlers (V3-13c): one direct import per handler file,
// no barrel (see services/db/deps.ts wiring pattern).
import { HANDLER_KIND as knowledgeGetSourceKind, handle as knowledgeGetSource, validate as validateKnowledgeGetSource } from '../services/db/knowledge-get-source.js';
import { HANDLER_KIND as knowledgeListSourcesKind, handle as knowledgeListSources, validate as validateKnowledgeListSources } from '../services/db/knowledge-list-sources.js';
import { HANDLER_KIND as knowledgeRemoveSourceKind, handle as knowledgeRemoveSource, validate as validateKnowledgeRemoveSource } from '../services/db/knowledge-remove-source.js';
import { HANDLER_KIND as knowledgeStatsKind, handle as knowledgeStats, validate as validateKnowledgeStats } from '../services/db/knowledge-stats.js';
import { HANDLER_KIND as knowledgeUpdateStatusKind, handle as knowledgeUpdateStatus, validate as validateKnowledgeUpdateStatus } from '../services/db/knowledge-update-status.js';
import { HANDLER_KIND as knowledgeUpsertSourceKind, handle as knowledgeUpsertSource, validate as validateKnowledgeUpsertSource } from '../services/db/knowledge-upsert-source.js';
import { HANDLER_KIND as vectorReplaceChunksKind, handle as vectorReplaceChunks } from '../services/db/vector-replace-chunks.js';
import { HANDLER_KIND as vectorSummariesKind, handle as vectorSummaries, validate as validateVectorSummaries } from '../services/db/vector-summaries.js';
import { HANDLER_KIND as wikiCommitRevisionKind, handle as wikiCommitRevision } from '../services/db/wiki-commit-revision.js';
import { HANDLER_KIND as wikiFindRevisionByInputHashKind, handle as wikiFindRevisionByInputHash, validate as validateWikiFindRevisionByInputHash } from '../services/db/wiki-find-revision-by-input-hash.js';
import { HANDLER_KIND as wikiGetActiveRevisionsKind, handle as wikiGetActiveRevisions, validate as validateWikiGetActiveRevisions } from '../services/db/wiki-get-active-revisions.js';
import { HANDLER_KIND as wikiGetMetaKind, handle as wikiGetMeta, validate as validateWikiGetMeta } from '../services/db/wiki-get-meta.js';
import { HANDLER_KIND as wikiGetPageKind, handle as wikiGetPage, validate as validateWikiGetPage } from '../services/db/wiki-get-page.js';
import { HANDLER_KIND as wikiGetRevisionKind, handle as wikiGetRevision, validate as validateWikiGetRevision } from '../services/db/wiki-get-revision.js';
import { HANDLER_KIND as wikiGetSegmentKind, handle as wikiGetSegment, validate as validateWikiGetSegment } from '../services/db/wiki-get-segment.js';
import { HANDLER_KIND as wikiGetSourceStateKind, handle as wikiGetSourceState, validate as validateWikiGetSourceState } from '../services/db/wiki-get-source-state.js';
import { HANDLER_KIND as wikiListJobsKind, handle as wikiListJobs, validate as validateWikiListJobs } from '../services/db/wiki-list-jobs.js';
import { HANDLER_KIND as wikiListPagesKind, handle as wikiListPages, validate as validateWikiListPages } from '../services/db/wiki-list-pages.js';
import { HANDLER_KIND as wikiListSourceStatesKind, handle as wikiListSourceStates, validate as validateWikiListSourceStates } from '../services/db/wiki-list-source-states.js';
import { HANDLER_KIND as wikiPutMetaKind, handle as wikiPutMeta } from '../services/db/wiki-put-meta.js';
import { HANDLER_KIND as wikiPutSegmentKind, handle as wikiPutSegment } from '../services/db/wiki-put-segment.js';
import { HANDLER_KIND as wikiRemoveJobKind, handle as wikiRemoveJob } from '../services/db/wiki-remove-job.js';
import { HANDLER_KIND as wikiUpsertJobKind, handle as wikiUpsertJob } from '../services/db/wiki-upsert-job.js';
import { HANDLER_KIND as wikiUpsertPageKind, handle as wikiUpsertPage } from '../services/db/wiki-upsert-page.js';
import { HANDLER_KIND as wikiUpsertSourceKind, handle as wikiUpsertSource } from '../services/db/wiki-upsert-source.js';

export const REGISTRATION_ID = 'db' as const;
export const REGISTRATION_ORDER = 100;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  const dbDeps = createDefaultDbRouteDeps(ctx.config);
  // Register V3-13b handlers (kinds owned by V3-13b per
  // fase1/pembagian-handler-kind.md). Unregistered kinds keep
  // answering 500 (W1) / 410 (W2) until their merge lands.
  dbDeps.registry.registerWrite(canvasesCreateKind, { validate: validateCanvasesCreate, handle: canvasesCreate });
  dbDeps.registry.registerRead(canvasesGetKind, { validate: validateCanvasesGet, handle: canvasesGet });
  dbDeps.registry.registerRead(canvasesListKind, { validate: validateCanvasesList, handle: canvasesList });
  dbDeps.registry.registerWrite(canvasesRestoreKind, { validate: validateCanvasesRestore, handle: canvasesRestore });
  dbDeps.registry.registerWrite(canvasesSaveKind, { validate: validateCanvasesSave, handle: canvasesSave });
  dbDeps.registry.registerWrite(canvasesSoftDeleteKind, { validate: validateCanvasesSoftDelete, handle: canvasesSoftDelete });
  dbDeps.registry.registerWrite(compactionsInsertKind, { validate: validateCompactionsInsert, handle: compactionsInsert });
  dbDeps.registry.registerRead(compactionsListByConversationKind, { validate: validateCompactionsListByConversation, handle: compactionsListByConversation });
  dbDeps.registry.registerWrite(conversationsCreateKind, { validate: validateConversationsCreate, handle: conversationsCreate });
  dbDeps.registry.registerWrite(conversationsDeleteKind, { validate: validateConversationsDelete, handle: conversationsDelete });
  dbDeps.registry.registerRead(conversationsGetKind, { validate: validateConversationsGet, handle: conversationsGet });
  dbDeps.registry.registerRead(conversationsListKind, { validate: validateConversationsList, handle: conversationsList });
  dbDeps.registry.registerWrite(conversationsUpdateKind, { validate: validateConversationsUpdate, handle: conversationsUpdate });
  dbDeps.registry.registerRead(imageCacheGetKind, { validate: validateImageCacheGet, handle: imageCacheGet });
  dbDeps.registry.registerWrite(imageCachePutKind, { validate: validateImageCachePut, handle: imageCachePut });
  dbDeps.registry.registerWrite(memoriesCreateKind, { validate: validateMemoriesCreate, handle: memoriesCreate });
  dbDeps.registry.registerWrite(memoriesDeleteKind, { validate: validateMemoriesDelete, handle: memoriesDelete });
  dbDeps.registry.registerRead(memoriesGetKind, { validate: validateMemoriesGet, handle: memoriesGet });
  dbDeps.registry.registerRead(memoriesListKind, { validate: validateMemoriesList, handle: memoriesList });
  dbDeps.registry.registerRead(memoriesStatsKind, { validate: validateMemoriesStats, handle: memoriesStats });
  dbDeps.registry.registerWrite(memoriesUpdateKind, { validate: validateMemoriesUpdate, handle: memoriesUpdate });
  dbDeps.registry.registerWrite(messagesAppendKind, { validate: validateMessagesAppend, handle: messagesAppend });
  dbDeps.registry.registerWrite(messagesDeleteKind, { validate: validateMessagesDelete, handle: messagesDelete });
  dbDeps.registry.registerRead(messagesGetKind, { validate: validateMessagesGet, handle: messagesGet });
  dbDeps.registry.registerRead(messagesListByConversationKind, { validate: validateMessagesListByConversation, handle: messagesListByConversation });
  dbDeps.registry.registerRead(messagesListByTagKind, { validate: validateMessagesListByTag, handle: messagesListByTag });
  dbDeps.registry.registerWrite(messagesUpdateKind, { validate: validateMessagesUpdate, handle: messagesUpdate });
  dbDeps.registry.registerRead(policyGetKind, { validate: validatePolicyGet, handle: policyGet });
  dbDeps.registry.registerWrite(policyPutKind, { validate: validatePolicyPut, handle: policyPut });
  // Register V3-13c handlers (kinds owned by V3-13c per
  // fase1/pembagian-handler-kind.md). Unregistered kinds keep
  // answering 500 (W1) / 410 (W2) until their merge lands.
  dbDeps.registry.registerRead(knowledgeGetSourceKind, { validate: validateKnowledgeGetSource, handle: knowledgeGetSource });
  dbDeps.registry.registerRead(knowledgeListSourcesKind, { validate: validateKnowledgeListSources, handle: knowledgeListSources });
  dbDeps.registry.registerWrite(knowledgeRemoveSourceKind, { validate: validateKnowledgeRemoveSource, handle: knowledgeRemoveSource });
  dbDeps.registry.registerRead(knowledgeStatsKind, { validate: validateKnowledgeStats, handle: knowledgeStats });
  dbDeps.registry.registerWrite(knowledgeUpdateStatusKind, { validate: validateKnowledgeUpdateStatus, handle: knowledgeUpdateStatus });
  dbDeps.registry.registerWrite(knowledgeUpsertSourceKind, { validate: validateKnowledgeUpsertSource, handle: knowledgeUpsertSource });
  dbDeps.registry.registerWrite(vectorReplaceChunksKind, { handle: vectorReplaceChunks });
  dbDeps.registry.registerRead(vectorSummariesKind, { validate: validateVectorSummaries, handle: vectorSummaries });
  dbDeps.registry.registerWrite(wikiCommitRevisionKind, { handle: wikiCommitRevision });
  dbDeps.registry.registerRead(wikiFindRevisionByInputHashKind, { validate: validateWikiFindRevisionByInputHash, handle: wikiFindRevisionByInputHash });
  dbDeps.registry.registerRead(wikiGetActiveRevisionsKind, { validate: validateWikiGetActiveRevisions, handle: wikiGetActiveRevisions });
  dbDeps.registry.registerRead(wikiGetMetaKind, { validate: validateWikiGetMeta, handle: wikiGetMeta });
  dbDeps.registry.registerRead(wikiGetPageKind, { validate: validateWikiGetPage, handle: wikiGetPage });
  dbDeps.registry.registerRead(wikiGetRevisionKind, { validate: validateWikiGetRevision, handle: wikiGetRevision });
  dbDeps.registry.registerRead(wikiGetSegmentKind, { validate: validateWikiGetSegment, handle: wikiGetSegment });
  dbDeps.registry.registerRead(wikiGetSourceStateKind, { validate: validateWikiGetSourceState, handle: wikiGetSourceState });
  dbDeps.registry.registerRead(wikiListJobsKind, { validate: validateWikiListJobs, handle: wikiListJobs });
  dbDeps.registry.registerRead(wikiListPagesKind, { validate: validateWikiListPages, handle: wikiListPages });
  dbDeps.registry.registerRead(wikiListSourceStatesKind, { validate: validateWikiListSourceStates, handle: wikiListSourceStates });
  dbDeps.registry.registerWrite(wikiPutMetaKind, { handle: wikiPutMeta });
  dbDeps.registry.registerWrite(wikiPutSegmentKind, { handle: wikiPutSegment });
  dbDeps.registry.registerWrite(wikiRemoveJobKind, { handle: wikiRemoveJob });
  dbDeps.registry.registerWrite(wikiUpsertJobKind, { handle: wikiUpsertJob });
  dbDeps.registry.registerWrite(wikiUpsertPageKind, { handle: wikiUpsertPage });
  dbDeps.registry.registerWrite(wikiUpsertSourceKind, { handle: wikiUpsertSource });

  await registerDbRoutes(ctx.app, dbDeps);
}
