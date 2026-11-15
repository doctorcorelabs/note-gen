// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: activity.insert.
//
// Upstream: insertActivityEvent (insert or ignore). The write uses ON
// CONFLICT DO NOTHING on the dedupe key: a repeat insert with a
// dedupeKey already present in the workspace writes nothing and
// reports affected 0 instead of throwing. A null dedupeKey never
// conflicts, so such events always insert. createdAt is honored when
// sent and defaults to now when omitted, exactly as upstream does.
// Callers that need an activity event alongside another write send
// this kind in the same transaction (D-04); this handler writes only
// the one event and nothing else.
//
// When tagId is sent, the tag must belong to the caller's workspace:
// a missing tag, or a tag owned by another workspace, answers the
// generic 404, indistinguishable from a missing tag (AD-08). The
// foreign key alone cannot enforce this, because it checks existence
// without checking the workspace.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { activityEvents, tags, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'activity.insert' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export type ActivitySource = 'record' | 'chat' | 'writing' | 'canvas';

export interface NewActivityEvent {
  source: ActivitySource;
  title: string;
  description?: string | null;
  path?: string | null;
  tagId?: number | null;
  dedupeKey?: string | null;
  createdAt?: number;
}

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  event: NewActivityEvent;
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

const EVENT_KEYS: readonly string[] = [
  'source',
  'title',
  'description',
  'path',
  'tagId',
  'dedupeKey',
  'createdAt',
];

const SOURCES: readonly string[] = ['record', 'chat', 'writing', 'canvas'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

function validateEvent(event: unknown): asserts event is NewActivityEvent {
  if (!isRecord(event)) {
    throw validationIssue('event', 'must be an object');
  }
  for (const key of Object.keys(event)) {
    if (!EVENT_KEYS.includes(key)) {
      throw validationIssue(`event.${key}`, 'unknown field');
    }
  }
  if (typeof event.source !== 'string' || !SOURCES.includes(event.source)) {
    throw validationIssue('event.source', 'must be a known activity source');
  }
  if (typeof event.title !== 'string') {
    throw validationIssue('event.title', 'must be a string');
  }
  for (const key of ['description', 'path', 'dedupeKey']) {
    const value = event[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw validationIssue(`event.${key}`, 'must be a string or null');
    }
  }
  if (
    event.tagId !== undefined &&
    event.tagId !== null &&
    (typeof event.tagId !== 'number' || !Number.isInteger(event.tagId))
  ) {
    throw validationIssue('event.tagId', 'must be an integer or null');
  }
  if (
    event.createdAt !== undefined &&
    (typeof event.createdAt !== 'number' || !Number.isInteger(event.createdAt))
  ) {
    throw validationIssue('event.createdAt', 'must be an integer');
  }
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'event') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  validateEvent(op.event);
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const event = op.event;
  if (event.tagId !== undefined && event.tagId !== null) {
    const owned = await ctx.tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.id, event.tagId)))
      .limit(1);
    if (owned.length === 0) {
      throw ApiError.notFound();
    }
  }
  const inserted = await ctx.tx
    .insert(activityEvents)
    .values({
      workspaceId: ctx.workspaceId,
      tagId: event.tagId ?? null,
      source: event.source,
      title: event.title,
      description: event.description ?? null,
      path: event.path ?? null,
      dedupeKey: event.dedupeKey ?? null,
      createdAt: event.createdAt === undefined ? new Date() : new Date(event.createdAt),
    })
    .onConflictDoNothing()
    .returning({ id: activityEvents.id });
  const created = inserted[0];
  if (created === undefined) {
    return { affected: 0 };
  }
  return { affected: 1, id: created.id };
}
