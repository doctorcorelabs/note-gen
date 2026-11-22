// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Dispatch for the db routes: registry lookup, pre-transaction
// validation, sequential execution inside one transaction, and
// contract-shaped results.
//
// Execution order for a transaction request (kontrak 3.4, V1-03
// section 4.3):
// 1. Pre-flight, before any transaction opens: every operation must
//    have a registered handler, or be a W2 kind. A W2 kind with no
//    handler answers 410 capability_unavailable with a message
//    naming the kind and Fase 2 and details carrying capability,
//    phase, operationIndex, and kind (penguncian D/G section 7
//    rule 4). The server-only kind answers the same 410 even when
//    a handler is registered: it must never run through HTTP
//    (section 7 rule 5). A W1 kind with no handler is a server
//    wiring bug and answers 500 internal_error. Handler
//    `validate` steps also run here, in order, so a validation
//    failure never executes a partial transaction.
// 2. Inside one write transaction: resolve the workspace from the
//    session (404 when none), check the idempotency key (replay or
//    409), run the handlers in request order, store the idempotency
//    record, commit. Any failure rolls back everything (CT-X1).
// 3. A handler failure carries the failing operation: dispatch adds
//    operationIndex and kind to the error details, preserving the
//    handler's status, code, message, retryable flag, and other
//    details (kontrak 3.4: the response carries the index of the
//    operation that failed). Unexpected failures become
//    internal_error with the same operation identification; no SQL
//    text, secret, or stack trace ever reaches the wire.
//
// A read batch follows the same shape in a single read-only
// transaction, without a transaction id and without idempotency:
// results keep request order, each entry is { kind, rows }.

import { randomUUID } from 'node:crypto';
import { ApiError } from '../../plugins/envelope.js';
import { idempotencyScope, type IdempotencyStore } from './idempotency.js';
import { DB_SERVER_ONLY_OP_KIND, isWave2OpKind } from './kinds.js';
import type { DbHandlerContext, DbHandlerRegistry, DbOperationInput } from './registry.js';
import type { DbTransactionRunner } from './runner.js';
import { normalizeReadRows, normalizeWriteResult } from './validation.js';
import type { WorkspaceResolver } from './workspace.js';

export interface DbDispatchDeps {
  registry: DbHandlerRegistry;
  runner: DbTransactionRunner;
  resolveWorkspaceId: WorkspaceResolver;
  idempotencyStore: IdempotencyStore;
  // F02-04(b): post-commit sweep for internal assetKeys returned
  // by delete handlers, mirroring the REST route sweep. Optional:
  // without it, deleted rows' assets are left in place (the
  // pre-IM-4 behavior).
  sweepAssets?: (workspaceId: string, assetKeys: readonly string[]) => Promise<void>;
}

export interface TransactionResultEntry {
  kind: string;
  affected: number;
  id?: number | string;
  version?: number;
  committed?: boolean;
}

export interface TransactionResponseData {
  transactionId: string;
  results: TransactionResultEntry[];
}

export interface BatchResultEntry {
  kind: string;
  rows: readonly unknown[];
}

export interface BatchResponseData {
  results: BatchResultEntry[];
}

export interface TransactionRequestInput {
  userId: string;
  requestId: string;
  operations: DbOperationInput[];
  idempotencyKey: string | null;
  requestHash: string;
}

export interface BatchRequestInput {
  userId: string;
  requestId: string;
  operations: DbOperationInput[];
}

function withOperationContext(error: unknown, operationIndex: number, kind: string): ApiError {
  if (error instanceof ApiError) {
    return new ApiError(error.statusCode, error.code, error.message, {
      retryable: error.retryable,
      details: { ...error.details, operationIndex, kind },
    });
  }
  return new ApiError(500, 'internal_error', 'Internal server error.', {
    details: { operationIndex, kind },
  });
}

function unavailableForKind(kind: string, operationIndex: number): ApiError {
  return new ApiError(
    410,
    'capability_unavailable',
    `The ${kind} operation is not available in Fase 1; it is planned for Fase 2.`,
    {
      details: { capability: kind, phase: 'Fase 2', operationIndex, kind },
    },
  );
}

function missingHandler(kind: string, operationIndex: number): ApiError {
  return new ApiError(500, 'internal_error', 'Internal server error.', {
    details: { operationIndex, kind },
  });
}

// Pre-flight for write operations: handler presence, W2 handling,
// and handler validate steps, all before the transaction opens.
function preflightWrites(registry: DbHandlerRegistry, operations: DbOperationInput[]): void {
  for (let index = 0; index < operations.length; index += 1) {
    const op = operations[index];
    if (op.kind === DB_SERVER_ONLY_OP_KIND) {
      // Server-only kinds never run through HTTP, even when a
      // handler is registered (penguncian D/G section 7 rule 5).
      throw unavailableForKind(op.kind, index);
    }
    const handler = registry.getWrite(op.kind);
    if (handler === undefined) {
      if (isWave2OpKind(op.kind)) {
        throw unavailableForKind(op.kind, index);
      }
      throw missingHandler(op.kind, index);
    }
    if (handler.validate !== undefined) {
      try {
        handler.validate(op);
      } catch (error) {
        throw withOperationContext(error, index, op.kind);
      }
    }
  }
}

function preflightReads(registry: DbHandlerRegistry, operations: DbOperationInput[]): void {
  for (let index = 0; index < operations.length; index += 1) {
    const op = operations[index];
    const handler = registry.getRead(op.kind);
    if (handler === undefined) {
      throw missingHandler(op.kind, index);
    }
    if (handler.validate !== undefined) {
      try {
        handler.validate(op);
      } catch (error) {
        throw withOperationContext(error, index, op.kind);
      }
    }
  }
}

function isTransactionResponseData(value: unknown): value is TransactionResponseData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const data = value as { transactionId?: unknown; results?: unknown };
  return typeof data.transactionId === 'string' && Array.isArray(data.results);
}

export async function runTransactionRequest(
  deps: DbDispatchDeps,
  input: TransactionRequestInput,
): Promise<TransactionResponseData> {
  preflightWrites(deps.registry, input.operations);
  const transactionId = randomUUID();
  let sweepWorkspaceId: string | null = null;
  const pendingSweeps: string[] = [];
  try {
    const data = await deps.runner.runWrite(async (tx) => {
      const workspaceId = await deps.resolveWorkspaceId(tx, input.userId);
      if (workspaceId === null) {
        throw ApiError.notFound();
      }
      sweepWorkspaceId = workspaceId;
      const scope = idempotencyScope(workspaceId);
      if (input.idempotencyKey !== null) {
        const stored = await deps.idempotencyStore.find(tx, {
          userId: input.userId,
          scope,
          key: input.idempotencyKey,
        });
        if (stored !== null) {
          if (stored.requestHash !== input.requestHash) {
            throw new ApiError(
              409,
              'idempotency_key_reused',
              'The idempotency key was reused with a different request.',
            );
          }
          if (!isTransactionResponseData(stored.data)) {
            throw ApiError.internalError();
          }
          return stored.data;
        }
      }
      const ctx: DbHandlerContext = {
        tx,
        workspaceId,
        userId: input.userId,
        requestId: input.requestId,
        transactionId,
      };
      const results: TransactionResultEntry[] = [];
      for (let index = 0; index < input.operations.length; index += 1) {
        const op = input.operations[index];
        const handler = deps.registry.getWrite(op.kind);
        if (handler === undefined) {
          // Pre-flight already proved the handler exists; this is a
          // defensive guard against a registry mutated mid-request.
          throw missingHandler(op.kind, index);
        }
        let raw: unknown;
        try {
          raw = await handler.handle(ctx, op);
        } catch (error) {
          throw withOperationContext(error, index, op.kind);
        }
        // F02-04(b): collect internal asset keys for the
        // post-commit sweep. normalizeWriteResult drops the
        // field, so it never reaches the wire.
        if (typeof raw === 'object' && raw !== null && 'assetKeys' in raw) {
          const keys = (raw as { assetKeys?: unknown }).assetKeys;
          if (Array.isArray(keys)) {
            for (const key of keys) {
              if (typeof key === 'string' && key !== '') pendingSweeps.push(key);
            }
          }
        }
        const normalized = normalizeWriteResult(raw, op.kind, index);
        results.push({ kind: op.kind, ...normalized });
      }
      const data: TransactionResponseData = { transactionId, results };
      if (input.idempotencyKey !== null) {
        await deps.idempotencyStore.store(
          tx,
          { userId: input.userId, scope, key: input.idempotencyKey, requestHash: input.requestHash },
          { status: 200, data },
        );
      }
      return data;
    });
    // F02-04(b): the transaction has committed; sweep deleted
    // rows' assets now, mirroring the REST route. Best effort:
    // a sweep failure must not fail a committed delete. The
    // idempotent-replay path returns inside the transaction
    // without running handlers, so it collects nothing and
    // sweeps nothing (the original execution already swept).
    if (
      deps.sweepAssets !== undefined &&
      sweepWorkspaceId !== null &&
      pendingSweeps.length > 0
    ) {
      try {
        await deps.sweepAssets(sweepWorkspaceId, pendingSweeps);
      } catch {
        // Best effort: the records are already gone.
      }
    }
    return data;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw ApiError.internalError();
  }
}

export async function runBatchRequest(
  deps: DbDispatchDeps,
  input: BatchRequestInput,
): Promise<BatchResponseData> {
  preflightReads(deps.registry, input.operations);
  try {
    return await deps.runner.runRead(async (tx) => {
      const workspaceId = await deps.resolveWorkspaceId(tx, input.userId);
      if (workspaceId === null) {
        throw ApiError.notFound();
      }
      const ctx: DbHandlerContext = {
        tx,
        workspaceId,
        userId: input.userId,
        requestId: input.requestId,
        transactionId: null,
      };
      const results: BatchResultEntry[] = [];
      for (let index = 0; index < input.operations.length; index += 1) {
        const op = input.operations[index];
        const handler = deps.registry.getRead(op.kind);
        if (handler === undefined) {
          throw missingHandler(op.kind, index);
        }
        let raw: unknown;
        try {
          raw = await handler.handle(ctx, op);
        } catch (error) {
          throw withOperationContext(error, index, op.kind);
        }
        const rows = normalizeReadRows(raw, op.kind, index);
        results.push({ kind: op.kind, rows });
      }
      return { results };
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw ApiError.internalError();
  }
}
