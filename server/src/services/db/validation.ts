// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Request validation for POST /api/transactions and POST /api/db/batch.
//
// Validation order (first problem wins, operations checked in index
// order, all checks run before any transaction opens, V1-03 4.3
// rule 2):
// 1. The body must be a JSON object whose only field is `operations`.
//    Unknown fields, including workspaceId/workspace_id, are rejected
//    with validation_failed and details.fields (kontrak 1.1, 1.5).
// 2. `operations` must be a non-empty array of at most 50 entries
//    (kontrak 3.4, CT-X5). An empty array is rejected with
//    validation_failed and details.fields: it carries no operation,
//    so it is an invalid body, not an unknown kind (kontrak 6.2:
//    invalid_operation is only for an unknown kind or a kind from
//    the wrong group). Rejecting here keeps the failure a 400 at
//    the validation boundary instead of a 500 from dispatch when
//    no database is available (finding 41a, VRF-3A-32).
// 3. Each operation must be an object with a string `kind`.
// 4. Forbidden fields on an operation (sql, query, statement, table,
//    columns, raw, workspaceId, workspace_id, operations) are
//    rejected with validation_failed (kontrak 1.3, CT-S5). No field
//    on any operation may ever carry SQL, a table name, a column
//    name, or a workspace id (AD-26).
// 5. An unknown kind, or a kind from the wrong group for the
//    endpoint, is rejected with invalid_operation 400 and details
//    { operationIndex, kind } (kontrak 6.2, K-14). The server-only
//    kind (vector.replaceChunks) is NOT rejected here: it is a
//    known write kind, so dispatch pre-flight rejects it with 410
//    capability_unavailable as the server-side second defense
//    (penguncian D/G section 7 rule 5). In the read batch it is
//    rejected here as a wrong-group kind, like any write kind.
//
// Per-kind field shapes (required fields, types, additional
// properties per kind) are validated by the kind handlers
// themselves; dispatch runs each handler's optional `validate` step
// before opening the transaction. This module validates only what
// is kind-independent, so it never needs a per-kind schema table
// that could drift from the catalog.
//
// Injection strings carried as DATA values (for example a mark
// content that looks like SQL) are not rejected here: they are data,
// and handlers bind them as parameters through Drizzle. Only field
// NAMES from the forbidden list are rejected (CT-S5).

import { createHash } from 'node:crypto';
import { ApiError } from '../../plugins/envelope.js';
import {
  DB_MAX_OPERATIONS_PER_REQUEST,
  FORBIDDEN_OPERATION_FIELDS,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  dbOpGroup,
  type DbOpGroup,
} from './kinds.js';
import type { DbOperationInput } from './registry.js';

export interface ValidationFieldIssue {
  field: string;
  issue: string;
}

function validationFailed(fields: ValidationFieldIssue[]): ApiError {
  return ApiError.validation('Request validation failed.', { fields });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Validate the request body for one endpoint group and return the
// operations in request order. Throws ApiError on the first problem.
export function validateDbOperations(body: unknown, group: DbOpGroup): DbOperationInput[] {
  if (!isPlainObject(body)) {
    throw validationFailed([{ field: 'body', issue: 'must be an object' }]);
  }
  const unknownTopLevel = Object.keys(body).filter((key) => key !== 'operations');
  if (unknownTopLevel.length > 0) {
    throw validationFailed(unknownTopLevel.map((field) => ({ field, issue: 'unknown field' })));
  }
  const operations = body.operations;
  if (operations === undefined) {
    throw validationFailed([{ field: 'operations', issue: 'is required' }]);
  }
  if (!Array.isArray(operations)) {
    throw validationFailed([{ field: 'operations', issue: 'must be an array' }]);
  }
  if (operations.length === 0) {
    throw validationFailed([
      { field: 'operations', issue: 'must contain at least 1 operation' },
    ]);
  }
  if (operations.length > DB_MAX_OPERATIONS_PER_REQUEST) {
    throw validationFailed([
      {
        field: 'operations',
        issue: `must contain at most ${DB_MAX_OPERATIONS_PER_REQUEST} operations`,
      },
    ]);
  }
  const validated: DbOperationInput[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    validated.push(validateOneOperation(operations[index], index, group));
  }
  return validated;
}

function validateOneOperation(value: unknown, index: number, group: DbOpGroup): DbOperationInput {
  const prefix = `operations[${index}]`;
  if (!isPlainObject(value)) {
    throw validationFailed([{ field: prefix, issue: 'must be an object' }]);
  }
  const kind = value.kind;
  if (typeof kind !== 'string' || kind === '') {
    throw validationFailed([{ field: `${prefix}.kind`, issue: 'is required and must be a string' }]);
  }
  const forbiddenPresent = FORBIDDEN_OPERATION_FIELDS.filter((field) => field in value);
  if (forbiddenPresent.length > 0) {
    throw validationFailed(
      forbiddenPresent.map((field) => ({ field: `${prefix}.${field}`, issue: 'unknown field' })),
    );
  }
  const actualGroup = dbOpGroup(kind);
  if (actualGroup === null || actualGroup !== group) {
    throw new ApiError(400, 'invalid_operation', 'The operation is not valid for this endpoint.', {
      details: { operationIndex: index, kind },
    });
  }
  return value as DbOperationInput;
}

// Validate the Idempotency-Key header for POST /api/transactions
// (kontrak 1.6: opaque client string, at most 128 characters).
// Returns null when no usable key was sent. A duplicated header or
// an overlong key is a validation failure, not a silent ignore.
export function validateIdempotencyKey(header: string | string[] | undefined): string | null {
  if (header === undefined || header === '') {
    return null;
  }
  if (Array.isArray(header)) {
    throw validationFailed([{ field: 'Idempotency-Key', issue: 'must be a single value' }]);
  }
  if (header.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw validationFailed([
      { field: 'Idempotency-Key', issue: `must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters` },
    ]);
  }
  return header;
}

// Deterministic JSON serialization: object keys sorted recursively,
// arrays in order. Two request bodies that differ only in key order
// hash identically, so an idempotency replay is not defeated by
// serialization order.
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

// SHA-256 hex digest of the canonical request shape for idempotency
// comparison (kontrak 1.6, V1-03 4.3 rule 6). The method and path are
// part of the digest so a key is never replayed across endpoints.
export function hashDbRequestBody(operations: readonly DbOperationInput[]): string {
  return createHash('sha256')
    .update(stableStringify({ method: 'POST', path: '/api/transactions', operations }))
    .digest('hex');
}

// Validate a write handler result and normalize it to the contract
// result entry shape (kontrak 3.4). A malformed handler result is a
// server bug: internal_error with the failing operation identified.
export function normalizeWriteResult(
  result: unknown,
  kind: string,
  operationIndex: number,
): { affected: number; id?: number | string; version?: number; committed?: boolean } {
  const details = { operationIndex, kind };
  if (!isPlainObject(result)) {
    throw new ApiError(500, 'internal_error', 'Internal server error.', { details });
  }
  const affected = result.affected;
  if (typeof affected !== 'number' || !Number.isInteger(affected) || affected < 0) {
    throw new ApiError(500, 'internal_error', 'Internal server error.', { details });
  }
  const normalized: { affected: number; id?: number | string; version?: number; committed?: boolean } = {
    affected,
  };
  if (result.id !== undefined) {
    if (typeof result.id !== 'number' && typeof result.id !== 'string') {
      throw new ApiError(500, 'internal_error', 'Internal server error.', { details });
    }
    normalized.id = result.id;
  }
  if (result.version !== undefined) {
    if (typeof result.version !== 'number') {
      throw new ApiError(500, 'internal_error', 'Internal server error.', { details });
    }
    normalized.version = result.version;
  }
  if (result.committed !== undefined) {
    if (typeof result.committed !== 'boolean') {
      throw new ApiError(500, 'internal_error', 'Internal server error.', { details });
    }
    normalized.committed = result.committed;
  }
  return normalized;
}

// Validate a read handler result: it must be an array of rows.
export function normalizeReadRows(result: unknown, kind: string, operationIndex: number): readonly unknown[] {
  if (!Array.isArray(result)) {
    throw new ApiError(500, 'internal_error', 'Internal server error.', {
      details: { operationIndex, kind },
    });
  }
  return result;
}
