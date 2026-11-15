// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: imageCache.put.
//
// Upsert keyed by (workspace, cacheKey). When expiresAt is sent, the
// sent value is used; when omitted, the single handler TTL default
// below applies (G-06). The default is a handler-owner decision,
// recorded with its reason in the wave report: image analysis is
// deterministic for a given image and query and expensive to redo,
// so a 30 day default bounds staleness at one monthly refresh while
// keeping repeat reads cheap. There is no per-kind TTL parameter and
// no cache-cleaner kind.
//
// On conflict, the stored imageHash and queryHash are kept from the
// first write and the analysis fields, expiry, and updatedAt are
// replaced, matching the upstream on-conflict behavior.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { ApiError } from '../../plugins/envelope.js';
import { imageAnalysisCache, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'imageCache.put' as const;

// Default time to live applied when the caller omits expiresAt: 30
// days in milliseconds. Single value for all puts (G-06). See the
// wave report for the decision record.
export const IMAGE_CACHE_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export interface ImageAnalysisCacheInput {
  cacheKey: string;
  imageHash: string;
  queryHash: string;
  ocrText?: string;
  visualAnalysis?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  expiresAt?: number;
}

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  entry: ImageAnalysisCacheInput;
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

const ENTRY_KEYS: readonly string[] = [
  'cacheKey',
  'imageHash',
  'queryHash',
  'ocrText',
  'visualAnalysis',
  'mimeType',
  'width',
  'height',
  'expiresAt',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

function validateEntry(entry: unknown): asserts entry is ImageAnalysisCacheInput {
  if (!isRecord(entry)) {
    throw validationIssue('entry', 'must be an object');
  }
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.includes(key)) {
      throw validationIssue(`entry.${key}`, 'unknown field');
    }
  }
  for (const key of ['cacheKey', 'imageHash', 'queryHash']) {
    if (typeof entry[key] !== 'string') {
      throw validationIssue(`entry.${key}`, 'must be a string');
    }
  }
  for (const key of ['ocrText', 'visualAnalysis', 'mimeType']) {
    if (entry[key] !== undefined && typeof entry[key] !== 'string') {
      throw validationIssue(`entry.${key}`, 'must be a string');
    }
  }
  for (const key of ['width', 'height']) {
    if (entry[key] !== undefined && (typeof entry[key] !== 'number' || !Number.isInteger(entry[key]))) {
      throw validationIssue(`entry.${key}`, 'must be an integer');
    }
  }
  if (
    entry.expiresAt !== undefined &&
    (typeof entry.expiresAt !== 'number' || !Number.isInteger(entry.expiresAt))
  ) {
    throw validationIssue('entry.expiresAt', 'must be an integer');
  }
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'entry') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  validateEntry(op.entry);
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const entry = op.entry;
  const now = new Date();
  const expiresAt =
    entry.expiresAt === undefined
      ? new Date(now.getTime() + IMAGE_CACHE_DEFAULT_TTL_MS)
      : new Date(entry.expiresAt);
  await ctx.tx
    .insert(imageAnalysisCache)
    .values({
      workspaceId: ctx.workspaceId,
      cacheKey: entry.cacheKey,
      imageHash: entry.imageHash,
      queryHash: entry.queryHash,
      ocrText: entry.ocrText ?? null,
      visualAnalysis: entry.visualAnalysis ?? null,
      mimeType: entry.mimeType ?? null,
      width: entry.width ?? null,
      height: entry.height ?? null,
      expiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [imageAnalysisCache.workspaceId, imageAnalysisCache.cacheKey],
      set: {
        ocrText: entry.ocrText ?? null,
        visualAnalysis: entry.visualAnalysis ?? null,
        mimeType: entry.mimeType ?? null,
        width: entry.width ?? null,
        height: entry.height ?? null,
        expiresAt,
        updatedAt: now,
      },
    });
  return { affected: 1, id: entry.cacheKey };
}
