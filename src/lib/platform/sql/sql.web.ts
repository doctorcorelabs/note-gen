// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Web SqlAdapter: typed catalog operations over the batch/transaction
 * HTTP port (V3-14, part 1).
 *
 * Surface: the reconciled adapter shape from design 3.2 as tightened
 * by the V3-14 reconciliation design (v3b-14d): kind-indexed `query`,
 * `queryOne`, and `execute`, heterogeneous `queryMany`, all-or-nothing
 * `transaction`, `ready`, and `close`. Reads go to
 * `POST /api/db/batch`; writes go to `POST /api/transactions`
 * (kontrak-api-kanonis.md 3.4). There is no raw SQL, no table name,
 * no column name, and no workspace id anywhere in this module (AD-26).
 * Every kind check derives from the catalog constants in
 * `ops-catalog.ts`, the single source of truth (N-11): no kind list
 * is restated here, so a catalog amendment flows through with no
 * change to this file.
 *
 * PORT SEAM: this module defines the port interface `SqlDbPort`
 * and consumes it. The port implementation lives in `db-client.ts`
 * (`SqlDbClient`, fetch + CSRF + envelope + idempotency keys +
 * retry policy). The port types below mirror the client shapes
 * (same method names, same result shapes, same error fields), and
 * a `SqlDbClient` satisfies this port structurally: its extra
 * optional `signal` options do not break assignability (pinned by
 * a type-level check in the spec). The seam is retained
 * deliberately at the 3E fold so the dependency still points one
 * way: this module never imports the port implementation file.
 * Wiring passes a `SqlDbClient` where this module asks for a
 * `SqlDbPort`. The adapter itself never touches fetch, headers,
 * cookies, or envelopes. Auth and CSRF are the port's job (AD-40);
 * the adapter only validates operations, chunks read batches, maps
 * errors, and narrows rows per kind.
 *
 * HEALTH SEAM: `ready()` reads migration currency from
 * `GET /api/health/ready` (design 3.2). That endpoint answers the
 * AD-19 non-envelope health shape, which the batch/transaction port
 * does not speak, so the factory takes an optional `health` probe
 * supplied by wiring (V3-11/AD-33) from the health client. Without
 * a probe, `ready()` falls back to an empty batch call for
 * liveness and reports `migrationsCurrent: false` (unverified, not
 * known-drifted). `ready()` never throws; a failed probe answers
 * not-ok. See divergence D-6 in the task report.
 *
 * DIVERGENCES, documented for the integrator and for v3b-14d (the
 * reconciliation owner). None of these forks a fourth form; all
 * follow the catalog and name the exact point where the reconciled
 * design and this implementation differ:
 *
 * - D-1 `messages.get`: CLOSED. The catalog amendment (AD-44,
 *   G-04) has landed, so the catalog lists 74 kinds and this
 *   adapter admits `messages.get` with no code change here, as
 *   designed. The spec still pins the catalog-following behavior.
 * - D-2 Read chunking vs one snapshot: design 3.2 says `queryMany`
 *   runs in one consistent read snapshot, and the reconciled design
 *   says the adapter rejects batches over 50 locally. This module
 *   chunks `queryMany` into sequential 50-operation port calls
 *   instead, because the task brief requires chunked batch calls
 *   through the port and the 14c client chunks the same way. Each
 *   chunk is one server read transaction; consistency ACROSS chunks
 *   is best-effort, not snapshot-guaranteed. The integrator must
 *   confirm this trade-off or restore the reject rule.
 * - D-3 Transaction chunking is REFUSED: a `transaction` over 50
 *   operations is rejected locally with VALIDATION before any
 *   port call, because splitting one transaction across HTTP
 *   requests would break all-or-nothing atomicity (kontrak 3.4).
 *   The 14c client chunks transactions internally for direct
 *   callers; adapter calls never reach that path. The integrator
 *   must decide whether 14c transaction chunking stays for direct
 *   callers or is aligned to reject.
 * - D-4 Metadata lookup: the reconciled design injects a metadata
 *   lookup through adapter deps. This module imports
 *   `SQL_OP_METADATA` directly for the one runtime fact it needs
 *   (the server-only exposure check). Metadata is static catalog
 *   data, not I/O, so injection buys nothing here; no wave or
 *   exposure list is restated.
 * - D-5 Error and health types: CLOSED at the W23/3E fold. The
 *   definitions moved to `interface.ts` next to the reconciled
 *   surface (the reconciled `SqlAdapterError` interface pins the
 *   same fields the class provides); this file imports them and
 *   defines none of them. The two definitions must never coexist.
 * - D-6 `__sqlAdapterStub`: CLOSED at the W23/3E fold. The marker
 *   is deleted with the `interface.ts` replacement, and the class
 *   implements the real `SqlAdapter` surface. The spec pins the
 *   marker's absence so it is never reintroduced silently.
 *
 * Validation order mirrors the server (services/db/validation.ts)
 * and the 14c client: array shape, request size (transactions
 * only), per-operation object shape, string kind, forbidden
 * fields, known kind, group membership, then server-only
 * exposure. The whole batch is validated before any port call, so
 * one invalid operation fails the batch before any execution
 * (design 3.2). Per-kind field shapes are NOT validated here:
 * TypeScript types guard typed callers and the server is the
 * final authority (it rejects unknown fields with 400). W2 kinds
 * other than the server-only kind are sent normally; the server
 * answers 410 when no handler is registered, and the adapter maps
 * it to UNAVAILABLE. The server-only kind is rejected locally
 * with UNAVAILABLE before any port call.
 *
 * Error messages are built from codes, statuses, kind names, and
 * operation indexes only, never from operation content, row data,
 * or port error text, so throwing can never leak user data into a
 * log. Port error `details` are passed through (plus correlation
 * keys `wireCode`, `status`, and `requestId`) because the envelope
 * contract already restricts them to safe fields.
 */

import {
  SqlAdapterError,
  type SqlAdapter,
  type SqlErrorCode,
  type SqlHealth,
  type SqlTransactionOptions,
  type WriteResult,
} from "./interface";
import {
  SQL_OP_KINDS,
  SQL_OP_METADATA,
  SQL_READ_OP_KINDS,
  SQL_WRITE_OP_KINDS,
  type DbReadOperation,
  type DbWriteOperation,
  type SqlOpKind,
  type SqlReadOpKind,
  type SqlReadOperationByKind,
  type SqlReadRow,
  type SqlWikiCommitResult,
  type SqlWriteOpKind,
  type SqlWriteOperationByKind,
  type SqlWriteResultFor,
} from "./ops-catalog";

// ---------------------------------------------------------------------------
// Limits and forbidden fields (mirrors, pinned by the spec)
// ---------------------------------------------------------------------------

/**
 * Maximum operations per HTTP request (kontrak 3.4, server
 * `DB_MAX_OPERATIONS_PER_REQUEST`, 14c
 * `DB_CLIENT_MAX_OPERATIONS_PER_REQUEST`). The adapter chunks read
 * batches at this size and rejects longer transactions outright.
 */
export const SQL_WEB_MAX_OPERATIONS_PER_REQUEST = 50;

/**
 * Field names that must never appear on an operation object
 * (kontrak 1.3 and 1.5, V1-03 4.3 rule 2). Mirrors
 * `FORBIDDEN_OPERATION_FIELDS` in server/src/services/db/kinds.ts
 * and the 14c client list. Only top-level operation keys are
 * checked: a forbidden-looking string carried as nested data is
 * data, and handlers bind it as a parameter.
 */
export const SQL_WEB_FORBIDDEN_OPERATION_FIELDS: readonly string[] = [
  "sql",
  "query",
  "statement",
  "table",
  "columns",
  "raw",
  "workspaceId",
  "workspace_id",
  "operations",
];

// Kind membership derived from the catalog constants, so a catalog
// amendment (for example `messages.get`, AD-44) flows through with
// no change here. No kind name is restated in this module.
const READ_KIND_SET: ReadonlySet<string> = new Set(SQL_READ_OP_KINDS);
const WRITE_KIND_SET: ReadonlySet<string> = new Set(SQL_WRITE_OP_KINDS);
const KNOWN_KIND_SET: ReadonlySet<string> = new Set(SQL_OP_KINDS);

// Adapter surface types (`SqlAdapter`, `SqlAdapterError`,
// `SqlErrorCode`, `SqlHealth`, `WriteResult`,
// `SqlTransactionOptions`) live in `./interface.ts` (D-5 closed at
// the W23/3E fold) and are imported above. They must never be
// redefined here.

// ---------------------------------------------------------------------------
// Port: batch/transaction HTTP client (14c owns the implementation)
// ---------------------------------------------------------------------------

/**
 * PORT DEFINITION. The names and shapes mirror `./db-client`
 * exactly, and `SqlDbClient` satisfies `SqlDbPort` structurally
 * (pinned by a type-level check in the spec). This module must
 * never import the port implementation file, so the dependency
 * points one way only; wiring supplies the client.
 */

/**
 * One read batch result entry. Rows are untyped at the port: row
 * narrowing per kind is the adapter's job. The port guarantees
 * only that `rows` is an array and that entries keep request order
 * with matching kinds; the adapter re-validates both defensively.
 */
export interface SqlBatchResultEntry {
  kind: SqlReadOpKind;
  rows: readonly unknown[];
}

export interface SqlBatchResult {
  /** Batch results in request order, concatenated across chunks. */
  results: SqlBatchResultEntry[];
}

/**
 * One write result entry, mirroring the kontrak 3.4 transaction
 * result shape. `committed` appears only for `wiki.commitRevision`,
 * where a guard miss reports `committed: false` with HTTP 200.
 */
export interface SqlTransactionResultEntry {
  kind: SqlWriteOpKind;
  affected: number;
  id?: number | string;
  version?: number;
  committed?: boolean;
}

export interface SqlTransactionResult {
  /**
   * One server-minted id per chunk sent, in chunk order. Adapter
   * calls always send a single chunk, so this holds exactly one
   * id; the adapter does not expose it (callers use the
   * idempotency key for replay).
   */
  transactionIds: string[];
  /** Write results in request order. */
  results: SqlTransactionResultEntry[];
}

/**
 * Structural shape of a port failure. It matches the 14c
 * `SqlDbClientError` fields: the exact wire code (or null when no
 * envelope arrived), the HTTP status (or null when no response was
 * received), the K-07 retryable flag, and envelope details. The
 * adapter recognizes port errors structurally through
 * `isSqlDbPortError`, never by class identity, so any conforming
 * port implementation maps the same way.
 */
export interface SqlDbPortError extends Error {
  /** Exact wire code, or null when no envelope arrived. */
  code: string | null;
  /** HTTP status, or null when no response was received. */
  status: number | null;
  retryable: boolean;
  requestId?: string | null;
  details?: Readonly<Record<string, unknown>>;
  /** Failing operation index, when the port identified one. */
  operationIndex?: number | null;
  /** Failing operation kind, when the port identified one. */
  kind?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural guard for port errors: an Error carrying the wire
 * code, status, retryable flag, and details fields. Anything else
 * a port throws is treated as an unexpected failure and wrapped
 * as UNKNOWN without its message text.
 */
export function isSqlDbPortError(error: unknown): error is SqlDbPortError {
  if (!(error instanceof Error) || !isRecord(error)) {
    return false;
  }
  const code = error["code"];
  const status = error["status"];
  const retryable = error["retryable"];
  const details = error["details"];
  return (
    (typeof code === "string" || code === null) &&
    (typeof status === "number" || status === null) &&
    typeof retryable === "boolean" &&
    (details === undefined || isRecord(details))
  );
}

/** Port options for one transaction call: the idempotency key only. */
export interface SqlTransactionPortOptions {
  /**
   * Idempotency key for the call. When absent, the port generates
   * a fresh key. An explicit null or empty string sends no key.
   * The adapter passes the caller's key through verbatim.
   */
  idempotencyKey?: string | null;
}

/**
 * Transport seam for the web SqlAdapter. Two methods, one per
 * canonical endpoint. The adapter calls `executeBatch` with at
 * most 50 operations per call (it chunks longer read batches
 * itself) and `executeTransaction` with at most 50 operations per
 * call (it rejects longer transactions; see D-3). Both methods
 * throw `SqlDbPortError`-shaped errors on failure and never return
 * partial results.
 */
export interface SqlDbPort {
  executeTransaction(
    operations: readonly DbWriteOperation[],
    options?: SqlTransactionPortOptions,
  ): Promise<SqlTransactionResult>;
  executeBatch(
    operations: readonly DbReadOperation[],
  ): Promise<SqlBatchResult>;
}

/** Raw health values from GET /api/health/ready, fetched by wiring. */
export interface SqlHealthProbeResult {
  ok: boolean;
  migrationsCurrent: boolean;
}

/**
 * Health probe supplied by wiring. The adapter never fetches the
 * health endpoint itself: the probe owns the HTTP call and hands
 * the adapter only the two booleans `ready()` reports.
 */
export type SqlHealthProbe = () => Promise<SqlHealthProbeResult>;

/** Construction dependencies of the web adapter. */
export interface WebSqlAdapterDeps {
  port: SqlDbPort;
  /**
   * Optional health probe. When absent, `ready()` probes liveness
   * through an empty batch call and reports `migrationsCurrent`
   * as false (unverified). Wiring should always supply this in
   * production so `ready()` reflects the real migration check.
   */
  health?: SqlHealthProbe;
}

// ---------------------------------------------------------------------------
// Wire code to adapter code mapping (kontrak 6.5, code-first)
// ---------------------------------------------------------------------------

const CONFLICT_WIRE_CODES: ReadonlySet<string> = new Set([
  "revision_conflict",
  "record_tags_changed",
  "already_exists",
  "target_exists",
  "wrong_kind",
  "repair_precondition_failed",
  "reconcile_already_running",
  "idempotency_key_reused",
  "tag_in_use",
  "tag_locked",
  "tag_name_taken",
  "backup_in_progress",
]);

const VALIDATION_WIRE_CODES: ReadonlySet<string> = new Set([
  "validation_failed",
  "invalid_operation",
  "invalid_json",
  "invalid_path",
  "invalid_query",
  "invalid_cursor",
  "invalid_limit",
  "invalid_precondition",
  "invalid_patch_range",
  "invalid_upload",
  "invalid_move",
  "invalid_action_token",
  "confirm_required",
  "precondition_required",
  "tag_not_found",
  "asset_not_found",
  "symlink_not_allowed",
  "not_a_directory",
  "not_text_file",
  "unsupported_media_type",
  "range_not_satisfiable",
  "invalid_text_encoding",
  "unsupported_backup_format",
  "backup_corrupt",
  "backup_decrypt_failed",
  "schema_too_new",
  "payload_too_large",
  "text_too_large",
  "media_too_large",
  "asset_too_large",
]);

const UNAUTHORIZED_WIRE_CODES: ReadonlySet<string> = new Set([
  "unauthenticated",
  "invalid_credentials",
  "invalid_verification_code",
  "invalid_setup_token",
]);

const FORBIDDEN_WIRE_CODES: ReadonlySet<string> = new Set([
  "forbidden",
  "csrf_invalid",
  "origin_rejected",
  // The caller is authenticated but the action needs a fresh
  // step-up; refusing the action is a FORBIDDEN, not a missing
  // session.
  "step_up_required",
]);

const UNAVAILABLE_WIRE_CODES: ReadonlySet<string> = new Set([
  "rate_limited",
  "service_unavailable",
  "write_queue_timeout",
  "fuzzy_search_unavailable",
  "document_parse_unavailable",
  "restore_unavailable",
]);

/**
 * Map a wire failure to an adapter code, code-first (kontrak 6.1
 * rule 3: one code can arrive on two statuses, so the code decides
 * and the status is only the fallback). The status mapping matches
 * the reconciled design: 410 UNAVAILABLE, 409 CONFLICT, 404
 * NOT_FOUND, 400 VALIDATION, 401 UNAUTHORIZED, 403 FORBIDDEN,
 * extended here for 412 (same conflict code), 413/415/422/428
 * (validation), 429/501/503 (unavailable), and any other 5xx or
 * unknown failure (UNKNOWN). `not_found` maps to NOT_FOUND even
 * though the 14c coarse mapping folds it into VALIDATION_ERROR:
 * this adapter has a dedicated NOT_FOUND code and the reconciled
 * design assigns 404 to it.
 */
export function sqlErrorCodeFromWireCode(
  wireCode: string | null,
  status: number | null,
): SqlErrorCode {
  if (wireCode !== null) {
    if (wireCode === "capability_unavailable") {
      return "UNAVAILABLE";
    }
    if (CONFLICT_WIRE_CODES.has(wireCode)) {
      return "CONFLICT";
    }
    if (wireCode === "not_found") {
      return "NOT_FOUND";
    }
    if (VALIDATION_WIRE_CODES.has(wireCode)) {
      return "VALIDATION";
    }
    if (UNAUTHORIZED_WIRE_CODES.has(wireCode)) {
      return "UNAUTHORIZED";
    }
    if (FORBIDDEN_WIRE_CODES.has(wireCode)) {
      return "FORBIDDEN";
    }
    if (UNAVAILABLE_WIRE_CODES.has(wireCode)) {
      return "UNAVAILABLE";
    }
  }
  if (status !== null) {
    if (status === 400 || status === 413 || status === 415 || status === 422 || status === 428) {
      return "VALIDATION";
    }
    if (status === 401) {
      return "UNAUTHORIZED";
    }
    if (status === 403) {
      return "FORBIDDEN";
    }
    if (status === 404) {
      return "NOT_FOUND";
    }
    if (status === 409 || status === 412) {
      return "CONFLICT";
    }
    if (status === 410 || status === 429 || status === 501 || status === 503) {
      return "UNAVAILABLE";
    }
  }
  return "UNKNOWN";
}

function portErrorOperationIndex(error: SqlDbPortError): number | null {
  if (typeof error.operationIndex === "number" && Number.isInteger(error.operationIndex)) {
    return error.operationIndex;
  }
  const fromDetails = error.details?.["operationIndex"];
  return typeof fromDetails === "number" && Number.isInteger(fromDetails) ? fromDetails : null;
}

function portErrorKind(error: SqlDbPortError): string | null {
  if (typeof error.kind === "string" && error.kind !== "") {
    return error.kind;
  }
  const fromDetails = error.details?.["kind"];
  return typeof fromDetails === "string" && fromDetails !== "" ? fromDetails : null;
}

/** Chunk position of a failed port call, for index remapping. */
interface PortErrorContext {
  /** Operations completed in earlier chunks of the same call. */
  chunkOffset: number;
  chunkIndex: number;
  chunkCount: number;
}

const SINGLE_CALL_CONTEXT: PortErrorContext = {
  chunkOffset: 0,
  chunkIndex: 0,
  chunkCount: 1,
};

/**
 * Convert any port failure into a `SqlAdapterError`. Port errors
 * map code-first with the K-07 retryable flag passed through
 * verbatim, and a chunk-local operation index is remapped to the
 * caller's global index. Anything else becomes UNKNOWN with
 * `retryable: false` and no message text carried over.
 */
function toSqlAdapterError(error: unknown, context: PortErrorContext): SqlAdapterError {
  if (error instanceof SqlAdapterError) {
    return error;
  }
  if (isSqlDbPortError(error)) {
    const wireCode = error.code;
    const status = error.status;
    const code = sqlErrorCodeFromWireCode(wireCode, status);
    const localIndex = portErrorOperationIndex(error);
    const kind = portErrorKind(error);
    const globalIndex = localIndex === null ? null : localIndex + context.chunkOffset;
    const details: Record<string, unknown> = { ...(error.details ?? {}) };
    if (wireCode !== null) {
      details["wireCode"] = wireCode;
    }
    if (status !== null) {
      details["status"] = status;
    }
    if (error.requestId !== undefined && error.requestId !== null) {
      details["requestId"] = error.requestId;
    }
    if (globalIndex !== null) {
      details["operationIndex"] = globalIndex;
    }
    if (kind !== null) {
      details["kind"] = kind;
    }
    if (context.chunkCount > 1) {
      details["failedChunkIndex"] = context.chunkIndex;
      details["completedOperations"] = context.chunkOffset;
    }
    const statusText = status === null ? "no response" : `HTTP ${status}`;
    const wireText = wireCode === null ? "no wire code" : wireCode;
    const opText =
      globalIndex !== null && kind !== null
        ? `, operation ${globalIndex} (${kind})`
        : globalIndex !== null
          ? `, operation ${globalIndex}`
          : kind !== null
            ? `, kind ${kind}`
            : "";
    return new SqlAdapterError(code, `SqlAdapter request failed: ${code} (${statusText}, ${wireText}${opText})`, {
      retryable: error.retryable,
      details,
    });
  }
  const errorName =
    typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
      ? error.name
      : "unknown";
  return new SqlAdapterError("UNKNOWN", "SqlAdapter request failed: UNKNOWN (unexpected port error)", {
    retryable: false,
    details: { wireCode: null, errorName },
  });
}

async function callPort<T>(
  call: () => Promise<T>,
  context: PortErrorContext,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toSqlAdapterError(error, context);
  }
}

// ---------------------------------------------------------------------------
// Operation validation (closed catalog, group, exposure)
// ---------------------------------------------------------------------------

type SqlDbOperationGroup = "read" | "write";

function safeKindForMessage(kind: string): string {
  return kind.length > 80 ? `${kind.slice(0, 77)}...` : kind;
}

function validationError(
  message: string,
  details: Record<string, unknown>,
): SqlAdapterError {
  return new SqlAdapterError("VALIDATION", message, { retryable: false, details });
}

function invalidOperationError(operationIndex: number, kind: string): SqlAdapterError {
  return validationError(
    `SqlAdapter request failed: VALIDATION (unknown or wrong-group operation kind "${safeKindForMessage(kind)}" at index ${operationIndex})`,
    { wireCode: "invalid_operation", operationIndex, kind },
  );
}

function assertOperationsArray(operations: unknown): asserts operations is readonly unknown[] {
  if (!Array.isArray(operations)) {
    throw validationError("SqlAdapter request failed: VALIDATION (operations must be an array)", {
      wireCode: "validation_failed",
      fields: [{ field: "operations", issue: "must be an array" }],
    });
  }
}

/**
 * Validate one operation in the server's check order: object
 * shape, string kind, forbidden fields, known kind, group
 * membership, then server-only exposure. The exposure check runs
 * after the group check, matching the server: the server-only
 * kind in a read batch is a wrong-group VALIDATION, not a 410.
 * Throws on the first problem, in index order, before any port
 * call. Per-kind field shapes are the server's job, not this
 * function's.
 */
function validateOperation(operation: unknown, index: number, group: SqlDbOperationGroup): void {
  const prefix = `operations[${index}]`;
  if (!isRecord(operation)) {
    throw validationError(
      `SqlAdapter request failed: VALIDATION (operation at index ${index} must be an object)`,
      {
        wireCode: "validation_failed",
        fields: [{ field: prefix, issue: "must be an object" }],
      },
    );
  }
  const kindValue = operation["kind"];
  if (typeof kindValue !== "string" || kindValue === "") {
    throw validationError(
      `SqlAdapter request failed: VALIDATION (operation at index ${index} has no string kind)`,
      {
        wireCode: "validation_failed",
        fields: [{ field: `${prefix}.kind`, issue: "is required and must be a string" }],
      },
    );
  }
  const kind = kindValue;
  const forbiddenPresent = SQL_WEB_FORBIDDEN_OPERATION_FIELDS.filter((field) => field in operation);
  if (forbiddenPresent.length > 0) {
    throw validationError(
      `SqlAdapter request failed: VALIDATION (forbidden field on operation at index ${index} (${safeKindForMessage(kind)}))`,
      {
        wireCode: "validation_failed",
        fields: forbiddenPresent.map((field) => ({
          field: `${prefix}.${field}`,
          issue: "unknown field",
        })),
      },
    );
  }
  if (!KNOWN_KIND_SET.has(kind)) {
    throw invalidOperationError(index, kind);
  }
  const inGroup = group === "read" ? READ_KIND_SET.has(kind) : WRITE_KIND_SET.has(kind);
  if (!inGroup) {
    throw invalidOperationError(index, kind);
  }
  const metadata = SQL_OP_METADATA[kind as SqlOpKind];
  if (metadata !== undefined && metadata.exposure === "server-only") {
    throw new SqlAdapterError(
      "UNAVAILABLE",
      `SqlAdapter request failed: UNAVAILABLE (capability "${safeKindForMessage(kind)}" is server-only and not available to clients, Fase 2)`,
      {
        retryable: false,
        details: { wireCode: "capability_unavailable", capability: kind, phase: "Fase 2", operationIndex: index, kind },
      },
    );
  }
}

function validateOperations(operations: unknown, group: SqlDbOperationGroup): void {
  assertOperationsArray(operations);
  for (let index = 0; index < operations.length; index += 1) {
    validateOperation(operations[index], index, group);
  }
}

// ---------------------------------------------------------------------------
// Port result validation (the port is an untrusted seam)
// ---------------------------------------------------------------------------

function shapeMismatchError(reason: string): SqlAdapterError {
  return new SqlAdapterError("UNKNOWN", `SqlAdapter request failed: UNKNOWN (port result mismatch: ${reason})`, {
    retryable: false,
    details: { wireCode: "internal_error", mismatch: reason },
  });
}

function validateBatchChunkResult(
  result: unknown,
  expectedKinds: readonly string[],
): SqlBatchResultEntry[] {
  if (!isRecord(result)) {
    throw shapeMismatchError("batch result is not an object");
  }
  const results: unknown = result["results"];
  if (!Array.isArray(results)) {
    throw shapeMismatchError("batch results is not an array");
  }
  if (results.length !== expectedKinds.length) {
    throw shapeMismatchError("batch results length does not match the request");
  }
  const validated: SqlBatchResultEntry[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const entry: unknown = results[index];
    if (!isRecord(entry)) {
      throw shapeMismatchError("batch result entry is not an object");
    }
    if (entry["kind"] !== expectedKinds[index]) {
      throw shapeMismatchError("batch result kind order does not match the request");
    }
    const rows: unknown = entry["rows"];
    if (!Array.isArray(rows)) {
      throw shapeMismatchError("batch result rows is not an array");
    }
    validated.push({ kind: expectedKinds[index] as SqlReadOpKind, rows });
  }
  return validated;
}

function validateTransactionResult(
  result: unknown,
  expectedKinds: readonly string[],
): SqlTransactionResultEntry[] {
  if (!isRecord(result)) {
    throw shapeMismatchError("transaction result is not an object");
  }
  const results: unknown = result["results"];
  if (!Array.isArray(results)) {
    throw shapeMismatchError("transaction results is not an array");
  }
  if (results.length !== expectedKinds.length) {
    throw shapeMismatchError("transaction results length does not match the request");
  }
  const validated: SqlTransactionResultEntry[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const entry: unknown = results[index];
    if (!isRecord(entry)) {
      throw shapeMismatchError("transaction result entry is not an object");
    }
    if (entry["kind"] !== expectedKinds[index]) {
      throw shapeMismatchError("transaction result kind order does not match the request");
    }
    const affected: unknown = entry["affected"];
    if (typeof affected !== "number" || !Number.isInteger(affected) || affected < 0) {
      throw shapeMismatchError("transaction affected is not a non-negative integer");
    }
    const validatedEntry: SqlTransactionResultEntry = {
      kind: expectedKinds[index] as SqlWriteOpKind,
      affected,
    };
    const id: unknown = entry["id"];
    if (id !== undefined) {
      if (typeof id !== "number" && typeof id !== "string") {
        throw shapeMismatchError("transaction id is not a number or string");
      }
      validatedEntry.id = id;
    }
    const version: unknown = entry["version"];
    if (version !== undefined) {
      if (typeof version !== "number") {
        throw shapeMismatchError("transaction version is not a number");
      }
      validatedEntry.version = version;
    }
    const committed: unknown = entry["committed"];
    if (committed !== undefined) {
      if (typeof committed !== "boolean") {
        throw shapeMismatchError("transaction committed is not a boolean");
      }
      validatedEntry.committed = committed;
    }
    if (expectedKinds[index] === "wiki.commitRevision" && typeof committed !== "boolean") {
      throw shapeMismatchError("wiki.commitRevision result is missing committed");
    }
    validated.push(validatedEntry);
  }
  return validated;
}

// ---------------------------------------------------------------------------
// Chunking (reads only; transactions are never split, D-3)
// ---------------------------------------------------------------------------

/**
 * Split operations into consecutive chunks of at most `chunkSize`,
 * preserving request order. An empty input yields one empty chunk,
 * so the caller still sends one request: the server resolves the
 * workspace (and auth) even for an empty call, matching the port.
 */
function chunkOperations<T>(operations: readonly T[], chunkSize: number): T[][] {
  if (operations.length === 0) {
    return [[]];
  }
  const chunks: T[][] = [];
  for (let start = 0; start < operations.length; start += chunkSize) {
    chunks.push(operations.slice(start, start + chunkSize));
  }
  return chunks;
}

function toGeneralWriteResult(entry: SqlTransactionResultEntry): WriteResult {
  const result: WriteResult = { affected: entry.affected };
  if (entry.id !== undefined) {
    result.id = entry.id;
  }
  if (entry.version !== undefined) {
    result.version = entry.version;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Web adapter
// ---------------------------------------------------------------------------

/**
 * Web SqlAdapter over the batch/transaction port.
 *
 * The method surface is the reconciled shape (design 3.2, kind
 * indexed): `query` returns rows, `queryOne` returns the first row
 * or null and never throws over an empty set, `queryMany` returns
 * one row array per operation in request order, `execute` is a
 * one-operation transaction, and `transaction` is all-or-nothing
 * with no exposed begin/commit/rollback. There is no row cache:
 * every `query` reads current state through the port.
 *
 * Wiring and registration are owned by V3-11 (AD-33), not by this
 * module: nothing here registers itself in the platform registry.
 */
export class WebSqlAdapter implements SqlAdapter {
  readonly mode = "web" as const;

  private readonly port: SqlDbPort;
  private readonly healthProbe?: SqlHealthProbe;

  constructor(deps: WebSqlAdapterDeps) {
    if (
      deps === null ||
      typeof deps !== "object" ||
      deps.port === null ||
      typeof deps.port !== "object" ||
      typeof deps.port.executeBatch !== "function" ||
      typeof deps.port.executeTransaction !== "function"
    ) {
      throw new TypeError("WebSqlAdapter requires a SqlDbPort with executeBatch and executeTransaction");
    }
    this.port = deps.port;
    this.healthProbe = deps.health;
  }

  /**
   * Adapter health. With a wired health probe, reports the probe
   * values (migration currency from /api/health/ready). Without
   * one, probes liveness with an empty batch call and reports
   * `migrationsCurrent: false` (unverified). Never throws: any
   * probe failure answers not-ok.
   */
  async ready(): Promise<SqlHealth> {
    if (this.healthProbe !== undefined) {
      try {
        const probe = await this.healthProbe();
        const ok = isRecord(probe) && probe["ok"] === true;
        const migrationsCurrent = isRecord(probe) && probe["migrationsCurrent"] === true;
        return { ok, mode: "web", migrationsCurrent };
      } catch {
        return { ok: false, mode: "web", migrationsCurrent: false };
      }
    }
    try {
      await callPort(() => this.port.executeBatch([]), SINGLE_CALL_CONTEXT);
      return { ok: true, mode: "web", migrationsCurrent: false };
    } catch {
      return { ok: false, mode: "web", migrationsCurrent: false };
    }
  }

  /**
   * Run one read operation through the batch endpoint. Row
   * narrowing per kind is a cast, not a runtime validation: the
   * port guarantees the rows array and kind order, and the server
   * is the authority on row shapes.
   */
  async query<K extends SqlReadOpKind>(
    op: SqlReadOperationByKind<K>,
  ): Promise<SqlReadRow<K>[]> {
    validateOperations([op], "read");
    const result = await callPort(
      () => this.port.executeBatch([op]),
      SINGLE_CALL_CONTEXT,
    );
    const entries = validateBatchChunkResult(result, [op.kind]);
    return entries[0].rows as unknown as SqlReadRow<K>[];
  }

  /**
   * Run one read operation and return the first row, or null when
   * the operation returns no rows. Never throws over an empty set.
   */
  async queryOne<K extends SqlReadOpKind>(
    op: SqlReadOperationByKind<K>,
  ): Promise<SqlReadRow<K> | null> {
    validateOperations([op], "read");
    const result = await callPort(
      () => this.port.executeBatch([op]),
      SINGLE_CALL_CONTEXT,
    );
    const entries = validateBatchChunkResult(result, [op.kind]);
    const rows = entries[0].rows;
    if (rows.length === 0) {
      return null;
    }
    return rows[0] as SqlReadRow<K>;
  }

  /**
   * Run read operations in request order. The whole batch is
   * validated before any port call; longer batches are chunked
   * into sequential 50-operation calls and the row arrays are
   * concatenated in request order. Chunking trades the
   * single-snapshot guarantee for large batches (D-2): each chunk
   * is one server read transaction, and consistency across chunks
   * is best-effort. A failure in any chunk throws with the
   * failing operation's global index; no partial results are
   * returned.
   */
  async queryMany(ops: readonly DbReadOperation[]): Promise<unknown[][]> {
    validateOperations(ops, "read");
    const chunks = chunkOperations(ops, SQL_WEB_MAX_OPERATIONS_PER_REQUEST);
    const allRows: unknown[][] = [];
    let completedOperations = 0;
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      const result = await callPort(() => this.port.executeBatch(chunk), {
        chunkOffset: completedOperations,
        chunkIndex,
        chunkCount: chunks.length,
      });
      const entries = validateBatchChunkResult(
        result,
        chunk.map((operation) => operation.kind),
      );
      for (const entry of entries) {
        allRows.push([...entry.rows]);
      }
      completedOperations += chunk.length;
    }
    return allRows;
  }

  /**
   * Run one write operation as its own transaction. Each call
   * gets a fresh idempotency key from the port; callers that
   * need replay control use `transaction` with an explicit key.
   * For `wiki.commitRevision` the result keeps the `committed`
   * flag (a guard miss reports `committed: false` with success,
   * never a throw).
   */
  async execute<K extends SqlWriteOpKind>(
    op: SqlWriteOperationByKind<K>,
  ): Promise<SqlWriteResultFor<K>> {
    validateOperations([op], "write");
    const result = await callPort(
      () => this.port.executeTransaction([op], { idempotencyKey: undefined }),
      SINGLE_CALL_CONTEXT,
    );
    const entries = validateTransactionResult(result, [op.kind]);
    const entry = entries[0];
    const writeResult = toGeneralWriteResult(entry);
    if (op.kind === "wiki.commitRevision" && typeof entry.committed === "boolean") {
      (writeResult as SqlWikiCommitResult).committed = entry.committed;
    }
    // The kind-indexed result follows from the validated kind: the
    // entry kind was checked against the operation kind above, and
    // the `committed` flag is attached exactly for commitRevision.
    return writeResult as unknown as SqlWriteResultFor<K>;
  }

  /**
   * Run write operations in one all-or-nothing transaction. A
   * transaction over 50 operations is rejected locally before any
   * port call (D-3): splitting it would silently break atomicity.
   * On failure the method throws with the failing operation's
   * index and kind in the error details; no partial results are
   * returned, and the server rolls the whole transaction back.
   * Results carry the general shape only: the `committed` flag of
   * `wiki.commitRevision` is stripped here (use `execute` for a
   * single commit when the flag matters).
   */
  async transaction(
    ops: readonly DbWriteOperation[],
    opts?: SqlTransactionOptions,
  ): Promise<WriteResult[]> {
    assertOperationsArray(ops);
    if (ops.length > SQL_WEB_MAX_OPERATIONS_PER_REQUEST) {
      throw validationError(
        `SqlAdapter request failed: VALIDATION (transaction holds ${ops.length} operations, at most ${SQL_WEB_MAX_OPERATIONS_PER_REQUEST} per request; transactions are never split)`,
        {
          wireCode: "validation_failed",
          limit: SQL_WEB_MAX_OPERATIONS_PER_REQUEST,
          received: ops.length,
          fields: [
            {
              field: "operations",
              issue: `at most ${SQL_WEB_MAX_OPERATIONS_PER_REQUEST} operations per request`,
            },
          ],
        },
      );
    }
    validateOperations(ops, "write");
    const result = await callPort(
      () =>
        this.port.executeTransaction(ops, {
          idempotencyKey: opts?.idempotencyKey,
        }),
      SINGLE_CALL_CONTEXT,
    );
    const entries = validateTransactionResult(
      result,
      ops.map((operation) => operation.kind),
    );
    return entries.map((entry) => toGeneralWriteResult(entry));
  }

  /**
   * Resolving no-op on web: no connection is held between HTTP
   * requests, so there is nothing to close.
   */
  async close(): Promise<void> {
    return undefined;
  }
}

/** Factory for the web adapter. Wiring owns the call (V3-11). */
export function createWebSqlAdapter(deps: WebSqlAdapterDeps): WebSqlAdapter {
  return new WebSqlAdapter(deps);
}
