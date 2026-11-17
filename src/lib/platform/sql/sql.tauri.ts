// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Tauri SqlAdapter: typed catalog operations over an injected
 * local executor (V3-14, 3E fold).
 *
 * This is a thin wrapper, following the store Tauri precedent
 * (`store.tauri.ts`): the adapter adds validation, wave/exposure
 * enforcement, result narrowing, and error mapping, and delegates
 * all local execution to the injected `SqlLocalKindExecutor`
 * (reconciliation design section 3.5). The executor receives typed
 * operations only and owns the fixed per-kind statements against
 * the local database; callers never supply SQL, and the executor
 * accepts no statement text in any parameter. This file carries no
 * SQL string, no table name, and no plugin import: the executor
 * implementation owns the local database binding.
 *
 * NO DEFAULT EXECUTOR EXISTS YET. The executor implementation
 * (74 fixed per-kind statement sets, mirroring the server handler
 * contract in the local dialect, with the guard semantics of
 * design 4.4/4.5) is an explicit follow-up, owned by whoever wires
 * the Tauri runtime; it is not claimed done here. Until it lands,
 * the Tauri adapter is constructible and spec-covered over a fake
 * executor, but no production Tauri path can call it. Wiring owns
 * the call (AD-33) and supplies both the executor and the metadata
 * lookup; `catalogSqlMetadataLookup` below is the catalog-backed
 * lookup wiring should pass.
 *
 * Semantics match the web adapter, including the answers the web
 * adapter gets from the server: a W2 kind is rejected locally
 * with UNAVAILABLE naming the capability and the phase (there is
 * no server to answer 410 here), the server-only kind is rejected
 * locally with UNAVAILABLE before any executor use, batches over
 * 50 operations are rejected locally, and the whole batch is
 * validated before any executor call, so one invalid operation
 * fails the batch before any execution. Validation order mirrors
 * the server and the web adapter: array shape, request size
 * (transactions only), per-operation object shape, string kind,
 * forbidden fields, known kind, group membership, exposure, then
 * wave. Per-kind field shapes are NOT validated here: TypeScript
 * types guard typed callers and the executor is the final
 * authority on its own statements.
 *
 * `ready()` probes liveness with one zero-parameter read
 * (`tags.list`) through the executor and reports
 * `migrationsCurrent: true` when the probe answers: the local
 * schema is executor-owned, so a successful probe is the load
 * success design 3.2 describes. `ready()` never throws; a failed
 * probe answers not-ok. `close()` delegates to the executor, which
 * owns the connection lifecycle (close plus cache reset); the
 * adapter keeps no closed flag.
 *
 * Known limitation, executor-seam shaped: `execute` for
 * `wiki.commitRevision` cannot return the `committed` flag,
 * because the executor result shape is the general `WriteResult`.
 * The gap is moot in Fase 1 (the kind is W2, so it is rejected
 * locally before reaching the executor). When W2 lands, the
 * executor seam must grow the flag before the kind is admitted.
 *
 * Error messages are built from codes, kind names, and operation
 * indexes only, never from operation content, row data, or
 * executor error text, so throwing can never leak user data into a
 * log. Executor failures the adapter does not recognize become
 * UNKNOWN with `retryable: false` and no message text carried
 * over; a `SqlAdapterError` thrown by the executor passes through
 * unchanged.
 */

import {
  SqlAdapterError,
  type SqlAdapter,
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
  type SqlWriteOpKind,
  type SqlWriteOperationByKind,
  type SqlWriteResultFor,
} from "./ops-catalog";
import type {
  ReconciledKindMetadataLookup,
  ReconciledOpKind,
  SqlTauriAdapterDeps,
} from "./reconciled-forms";

// ---------------------------------------------------------------------------
// Limits and forbidden fields (mirrors, pinned by the spec)
// ---------------------------------------------------------------------------

/**
 * Maximum operations per request (kontrak 3.4, server
 * `DB_MAX_OPERATIONS_PER_REQUEST`, web adapter
 * `SQL_WEB_MAX_OPERATIONS_PER_REQUEST`). The Tauri adapter
 * rejects longer transactions outright; read batches run one
 * executor call per operation, so no chunking applies locally.
 */
export const SQL_TAURI_MAX_OPERATIONS_PER_REQUEST = 50;

/**
 * Field names that must never appear on an operation object
 * (kontrak 1.3 and 1.5, V1-03 4.3 rule 2). Mirrors
 * `FORBIDDEN_OPERATION_FIELDS` in server/src/services/db/kinds.ts
 * and the web adapter list. Only top-level operation keys are
 * checked: a forbidden-looking string carried as nested data is
 * data, and the executor binds it as a parameter.
 */
export const SQL_TAURI_FORBIDDEN_OPERATION_FIELDS: readonly string[] = [
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
// amendment flows through with no change here. No kind name is
// restated in this module.
const READ_KIND_SET: ReadonlySet<string> = new Set(SQL_READ_OP_KINDS);
const WRITE_KIND_SET: ReadonlySet<string> = new Set(SQL_WRITE_OP_KINDS);
const KNOWN_KIND_SET: ReadonlySet<string> = new Set(SQL_OP_KINDS);

/**
 * Catalog-backed metadata lookup for wiring: wave and exposure
 * read straight from `SQL_OP_METADATA`, with no restated kind
 * list. Pass this as the `metadata` dependency unless a test
 * substitutes its own lookup.
 */
export const catalogSqlMetadataLookup: ReconciledKindMetadataLookup = {
  metadata(kind: ReconciledOpKind) {
    return SQL_OP_METADATA[kind as SqlOpKind];
  },
};

// ---------------------------------------------------------------------------
// Operation validation (closed catalog, group, exposure, wave)
// ---------------------------------------------------------------------------

type SqlDbOperationGroup = "read" | "write";

function safeKindForMessage(kind: string): string {
  return kind.length > 80 ? `${kind.slice(0, 77)}...` : kind;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationError(
  message: string,
  details: Record<string, unknown>,
): SqlAdapterError {
  return new SqlAdapterError("VALIDATION", message, {
    retryable: false,
    details,
  });
}

function invalidOperationError(
  operationIndex: number,
  kind: string,
): SqlAdapterError {
  return validationError(
    `SqlAdapter request failed: VALIDATION (unknown or wrong-group operation kind "${safeKindForMessage(kind)}" at index ${operationIndex})`,
    { wireCode: "invalid_operation", operationIndex, kind },
  );
}

function unavailableError(
  operationIndex: number,
  kind: string,
  reason: string,
): SqlAdapterError {
  return new SqlAdapterError(
    "UNAVAILABLE",
    `SqlAdapter request failed: UNAVAILABLE (capability "${safeKindForMessage(kind)}" ${reason})`,
    {
      retryable: false,
      details: {
        wireCode: "capability_unavailable",
        capability: kind,
        phase: "Fase 2",
        operationIndex,
        kind,
      },
    },
  );
}

function assertOperationsArray(
  operations: unknown,
): asserts operations is readonly unknown[] {
  if (!Array.isArray(operations)) {
    throw validationError(
      "SqlAdapter request failed: VALIDATION (operations must be an array)",
      {
        wireCode: "validation_failed",
        fields: [{ field: "operations", issue: "must be an array" }],
      },
    );
  }
}

/**
 * Validate one operation in the server's check order: object
 * shape, string kind, forbidden fields, known kind, group
 * membership, server-only exposure, then wave. The exposure check
 * runs after the group check, matching the server: the server-only
 * kind in a read batch is a wrong-group VALIDATION, not a 410.
 * The wave check runs last: a W2 kind answers UNAVAILABLE naming
 * the phase. Throws on the first problem, in index order, before
 * any executor call.
 */
function validateOperation(
  operation: unknown,
  index: number,
  group: SqlDbOperationGroup,
  metadata: ReconciledKindMetadataLookup,
): void {
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
        fields: [
          {
            field: `${prefix}.kind`,
            issue: "is required and must be a string",
          },
        ],
      },
    );
  }
  const kind = kindValue;
  const forbiddenPresent = SQL_TAURI_FORBIDDEN_OPERATION_FIELDS.filter(
    (field) => field in operation,
  );
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
  const inGroup =
    group === "read" ? READ_KIND_SET.has(kind) : WRITE_KIND_SET.has(kind);
  if (!inGroup) {
    throw invalidOperationError(index, kind);
  }
  const meta = metadata.metadata(kind as ReconciledOpKind);
  if (meta.exposure === "server-only") {
    throw unavailableError(
      index,
      kind,
      "is server-only and not available to clients, Fase 2",
    );
  }
  if (meta.wave === "W2") {
    throw unavailableError(
      index,
      kind,
      "is not available in Fase 1; it is planned for Fase 2",
    );
  }
}

function validateOperations(
  operations: unknown,
  group: SqlDbOperationGroup,
  metadata: ReconciledKindMetadataLookup,
): void {
  assertOperationsArray(operations);
  for (let index = 0; index < operations.length; index += 1) {
    validateOperation(operations[index], index, group, metadata);
  }
}

// ---------------------------------------------------------------------------
// Executor result validation (the executor is an untrusted seam)
// ---------------------------------------------------------------------------

function shapeMismatchError(reason: string): SqlAdapterError {
  return new SqlAdapterError(
    "UNKNOWN",
    `SqlAdapter request failed: UNKNOWN (executor result mismatch: ${reason})`,
    {
      retryable: false,
      details: { wireCode: "internal_error", mismatch: reason },
    },
  );
}

function asRowArray(result: unknown): readonly unknown[] {
  if (!Array.isArray(result)) {
    throw shapeMismatchError("read result is not an array");
  }
  return result;
}

function validateWriteResults(
  result: unknown,
  expectedCount: number,
): WriteResult[] {
  if (!Array.isArray(result)) {
    throw shapeMismatchError("write results is not an array");
  }
  if (result.length !== expectedCount) {
    throw shapeMismatchError("write results length does not match the request");
  }
  const validated: WriteResult[] = [];
  for (const entry of result) {
    if (!isRecord(entry)) {
      throw shapeMismatchError("write result entry is not an object");
    }
    const affected: unknown = entry["affected"];
    if (
      typeof affected !== "number" ||
      !Number.isInteger(affected) ||
      affected < 0
    ) {
      throw shapeMismatchError(
        "write affected is not a non-negative integer",
      );
    }
    const validatedEntry: WriteResult = { affected };
    const id: unknown = entry["id"];
    if (id !== undefined) {
      if (typeof id !== "number" && typeof id !== "string") {
        throw shapeMismatchError("write id is not a number or string");
      }
      validatedEntry.id = id;
    }
    const version: unknown = entry["version"];
    if (version !== undefined) {
      if (typeof version !== "number") {
        throw shapeMismatchError("write version is not a number");
      }
      validatedEntry.version = version;
    }
    validated.push(validatedEntry);
  }
  return validated;
}

/**
 * Convert any executor failure into a `SqlAdapterError`. A
 * `SqlAdapterError` passes through unchanged; anything else
 * becomes UNKNOWN with `retryable: false` and no message text
 * carried over.
 */
function toSqlAdapterError(error: unknown): SqlAdapterError {
  if (error instanceof SqlAdapterError) {
    return error;
  }
  const errorName =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
      ? error.name
      : "unknown";
  return new SqlAdapterError(
    "UNKNOWN",
    "SqlAdapter request failed: UNKNOWN (unexpected executor error)",
    {
      retryable: false,
      details: { wireCode: null, errorName },
    },
  );
}

async function callExecutor<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toSqlAdapterError(error);
  }
}

// ---------------------------------------------------------------------------
// Tauri adapter
// ---------------------------------------------------------------------------

/**
 * Tauri SqlAdapter over an injected local executor.
 *
 * The method surface is the reconciled shape (design 3.2, kind
 * indexed), with the same semantics as the web adapter: `query`
 * returns rows, `queryOne` returns the first row or null and never
 * throws over an empty set, `queryMany` returns one row array per
 * operation in request order, `execute` is a one-operation
 * transaction, and `transaction` is all-or-nothing with no exposed
 * begin/commit/rollback. There is no row cache: every `query`
 * reads current state through the executor.
 *
 * Wiring and registration are owned by the Tauri wiring step
 * (AD-33), not by this module: nothing here registers itself in
 * the platform registry, and no default executor is provided (see
 * the module header).
 */
export class TauriSqlAdapter implements SqlAdapter {
  readonly mode = "tauri" as const;

  private readonly executor: SqlTauriAdapterDeps["executor"];
  private readonly metadata: ReconciledKindMetadataLookup;

  constructor(deps: SqlTauriAdapterDeps) {
    if (
      deps === null ||
      typeof deps !== "object" ||
      deps.executor === null ||
      typeof deps.executor !== "object" ||
      typeof deps.executor.executeRead !== "function" ||
      typeof deps.executor.executeWrite !== "function" ||
      typeof deps.executor.close !== "function" ||
      deps.metadata === null ||
      typeof deps.metadata !== "object" ||
      typeof deps.metadata.metadata !== "function"
    ) {
      throw new TypeError(
        "TauriSqlAdapter requires a SqlLocalKindExecutor and a metadata lookup",
      );
    }
    this.executor = deps.executor;
    this.metadata = deps.metadata;
  }

  /**
   * Adapter health. Probes liveness with a zero-parameter read
   * (`tags.list`) through the executor; success reports
   * `migrationsCurrent: true` (the local schema is
   * executor-owned). Never throws: any probe failure answers
   * not-ok.
   */
  async ready(): Promise<SqlHealth> {
    try {
      await callExecutor(() =>
        this.executor.executeRead({ kind: "tags.list" }),
      );
      return { ok: true, mode: "tauri", migrationsCurrent: true };
    } catch {
      return { ok: false, mode: "tauri", migrationsCurrent: false };
    }
  }

  /**
   * Run one read operation through the executor. Row narrowing
   * per kind is a cast, not a runtime validation: the executor
   * guarantees the rows array, and the executor is the authority
   * on row shapes.
   */
  async query<K extends SqlReadOpKind>(
    op: SqlReadOperationByKind<K>,
  ): Promise<SqlReadRow<K>[]> {
    validateOperations([op], "read", this.metadata);
    const result = await callExecutor(() => this.executor.executeRead(op));
    return asRowArray(result) as unknown as SqlReadRow<K>[];
  }

  /**
   * Run one read operation and return the first row, or null when
   * the operation returns no rows. Never throws over an empty set.
   */
  async queryOne<K extends SqlReadOpKind>(
    op: SqlReadOperationByKind<K>,
  ): Promise<SqlReadRow<K> | null> {
    validateOperations([op], "read", this.metadata);
    const result = await callExecutor(() => this.executor.executeRead(op));
    const rows = asRowArray(result);
    if (rows.length === 0) {
      return null;
    }
    return rows[0] as SqlReadRow<K>;
  }

  /**
   * Run read operations in request order, one executor call per
   * operation. The whole batch is validated before any executor
   * call; an empty batch returns no results without touching the
   * executor. A failure in any operation throws; no partial
   * results are returned.
   */
  async queryMany(ops: readonly DbReadOperation[]): Promise<unknown[][]> {
    validateOperations(ops, "read", this.metadata);
    const allRows: unknown[][] = [];
    for (const op of ops) {
      const result = await callExecutor(() => this.executor.executeRead(op));
      allRows.push([...asRowArray(result)]);
    }
    return allRows;
  }

  /**
   * Run one write operation as its own transaction. For
   * `wiki.commitRevision` the result keeps only the general shape:
   * the executor result cannot carry the `committed` flag (see the
   * module header), and the kind is W2-rejected in Fase 1 anyway.
   */
  async execute<K extends SqlWriteOpKind>(
    op: SqlWriteOperationByKind<K>,
  ): Promise<SqlWriteResultFor<K>> {
    validateOperations([op], "write", this.metadata);
    const result = await callExecutor(() => this.executor.executeWrite([op]));
    const entries = validateWriteResults(result, 1);
    // The kind-indexed result follows from the validated kind: the
    // executor returns the general shape for every kind, and the
    // extended `committed` flag is unavailable on this seam.
    return entries[0] as unknown as SqlWriteResultFor<K>;
  }

  /**
   * Run write operations in one all-or-nothing transaction (the
   * executor owns atomicity). A transaction over 50 operations is
   * rejected locally before any executor call: splitting it would
   * silently break atomicity. On failure the method throws; no
   * partial results are returned.
   */
  async transaction(
    ops: readonly DbWriteOperation[],
    _opts?: SqlTransactionOptions,
  ): Promise<WriteResult[]> {
    assertOperationsArray(ops);
    if (ops.length > SQL_TAURI_MAX_OPERATIONS_PER_REQUEST) {
      throw validationError(
        `SqlAdapter request failed: VALIDATION (transaction holds ${ops.length} operations, at most ${SQL_TAURI_MAX_OPERATIONS_PER_REQUEST} per request; transactions are never split)`,
        {
          wireCode: "validation_failed",
          limit: SQL_TAURI_MAX_OPERATIONS_PER_REQUEST,
          received: ops.length,
          fields: [
            {
              field: "operations",
              issue: `at most ${SQL_TAURI_MAX_OPERATIONS_PER_REQUEST} operations per request`,
            },
          ],
        },
      );
    }
    validateOperations(ops, "write", this.metadata);
    // Idempotency keys are a transport concern: the local executor
    // has no replay store, so the key is accepted and ignored.
    void _opts;
    const result = await callExecutor(() => this.executor.executeWrite(ops));
    return validateWriteResults(result, ops.length);
  }

  /**
   * Close the local database through the executor, which owns the
   * connection lifecycle including its cache reset.
   */
  async close(): Promise<void> {
    await callExecutor(() => this.executor.close());
  }
}

/** Factory for the Tauri adapter. Wiring owns the call (AD-33). */
export function createTauriSqlAdapter(
  deps: SqlTauriAdapterDeps,
): TauriSqlAdapter {
  return new TauriSqlAdapter(deps);
}
