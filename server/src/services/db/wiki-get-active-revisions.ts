// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: wiki.getActiveRevisions.
//
// Upstream: getActiveWikiRevisions, with the same two-step logic
// done by the service. First, revisions joined to source states on
// context and revision id, restricted to ready sources. Then, for
// each joined revision, the source state looked up by the stable id
// in the revision payload must itself be ready, must point at this
// revision, and must carry the same content hash as the revision
// payload; the returned revision carries the state source reference
// instead of the payload one. Revisions whose payload source is
// missing or malformed are skipped, as upstream skips unparseable
// payloads. contextId is an opaque context key (A13): the handler
// always applies both the workspace predicate from the session and
// the context predicate from the operation.
//
// The catalog mirror types are declared locally because the emit
// build (rootDir src) cannot import type files from the frontend
// tree.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { wikiRevisions, wikiSources, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'wiki.getActiveRevisions' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  contextId: string;
}

export type KnowledgeSourceType = 'article' | 'record' | 'canvas';

export interface KnowledgeLocator {
  filePath?: string;
  markId?: number;
  tagId?: number;
  tagIds?: number[];
  canvasId?: string;
  nodeIds?: string[];
}

export type WikiSyncDomain = 'library' | 'account-data';

export interface WikiSourceReference {
  sourceKey: string;
  stableId: string;
  sourceType: KnowledgeSourceType;
  title: string;
  contentHash: string;
  locator: KnowledgeLocator;
  syncDomain: WikiSyncDomain;
  remoteVersion?: string;
  tagKeys?: string[];
}

export type WikiSourceStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'deleted'
  | 'excluded'
  | 'unavailable';

export interface WikiSourceState {
  contextId: string;
  stableId: string;
  sourceKey: string;
  sourceType: KnowledgeSourceType;
  source: WikiSourceReference;
  contentHash: string;
  status: WikiSourceStatus;
  revisionId: string | null;
  version: number;
  updatedAt: number;
  error: string | null;
}

export interface WikiEvidence {
  quote: string;
  nodeId?: string;
}

export interface WikiContribution {
  topicKey: string;
  title: string;
  aliases: string[];
  content: string;
  evidence: WikiEvidence[];
}

export interface WikiUsage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

export interface WikiSourceRevision {
  id: string;
  contextId: string;
  inputHash: string;
  outputHash: string;
  pipelineVersion: string;
  generation: number;
  language: string;
  source: WikiSourceReference;
  summary: string;
  contributions: WikiContribution[];
  createdAt: number;
  modelId: string;
  usage: WikiUsage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'operation', issue: 'must be an object' }],
    });
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'contextId') {
      throw ApiError.validation('Request validation failed.', {
        fields: [{ field: key, issue: 'unknown field' }],
      });
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'kind', issue: 'must match the handler kind' }],
    });
  }
  if (typeof op.contextId !== 'string') {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'contextId', issue: 'must be a string' }],
    });
  }
}

export async function handle(
  ctx: HandlerContext,
  op: unknown,
): Promise<readonly WikiSourceRevision[]> {
  validate(op);
  const joined = await ctx.tx
    .select({ payload: wikiRevisions.payload })
    .from(wikiRevisions)
    .innerJoin(
      wikiSources,
      and(
        eq(wikiRevisions.workspaceId, wikiSources.workspaceId),
        eq(wikiRevisions.contextId, wikiSources.contextId),
        eq(wikiRevisions.id, wikiSources.revisionId),
      ),
    )
    .where(
      and(
        eq(wikiRevisions.workspaceId, ctx.workspaceId),
        eq(wikiRevisions.contextId, op.contextId),
        eq(wikiSources.status, 'ready'),
      ),
    );
  const stateRows = await ctx.tx
    .select()
    .from(wikiSources)
    .where(
      and(
        eq(wikiSources.workspaceId, ctx.workspaceId),
        eq(wikiSources.contextId, op.contextId),
      ),
    );
  const states = new Map(
    stateRows.map((row) => [row.stableId, row.payload as unknown as WikiSourceState]),
  );
  const active: WikiSourceRevision[] = [];
  for (const row of joined) {
    const revision = row.payload as unknown as WikiSourceRevision;
    if (!isRecord(revision) || !isRecord(revision.source)) {
      continue;
    }
    const stableId = revision.source.stableId;
    if (typeof stableId !== 'string') {
      continue;
    }
    const state = states.get(stableId);
    if (
      state !== undefined &&
      state.status === 'ready' &&
      state.revisionId === revision.id &&
      state.contentHash === revision.source.contentHash
    ) {
      active.push({ ...revision, source: state.source });
    }
  }
  return active;
}
