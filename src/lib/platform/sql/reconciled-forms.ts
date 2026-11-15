// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Reconciled SQL operation forms (V3-14, part 4: design + interfaces).
 *
 * This file is the single type-level statement of the reconciliation
 * decided in W23/N-11 and locked in fase1/penguncian-dg-v224.md
 * section 6: the catalog wins. It defines the unified operation types
 * and the per-form adapter interfaces. It contains types and method
 * signatures only: no values, no functions, no classes, no runtime
 * behavior. Implementations land at integration in `interface.ts`
 * (the SqlAdapter surface), `sql.web.ts`, and `sql.tauri.ts`.
 *
 * The three forms reconciled here, with file and line evidence at
 * base 13e4e3e5:
 *
 * 1. Stub (AD-26): `src/lib/platform/sql/interface.ts`, 28 lines, a
 *    marker-only `SqlAdapter` with no callable surface. It replaced
 *    the rejected G0 raw-SQL shape (`SqlDatabase` with
 *    `execute(query: string, ...)` / `select(query: string, ...)`,
 *    branch web-registry-g0 commit 76e1660) at merge M5. Verdict:
 *    REPLACED by the unified interface at integration. The stub
 *    must not survive alongside it, and the G0 names
 *    (`SqlDatabase`, `QueryResult`) must never return.
 * 2. Contract mirror: `tests/contract/contract-types.ts`, lines
 *    236-377, a 30-kind subset union (12 reads + 18 writes) written
 *    from the design sketches before the catalog existed, with its
 *    own `SqlAdapter`, row shapes, and `WriteResult`. Verdict:
 *    BECOMES A RE-EXPORT of the catalog types at integration
 *    (D/G lock-in section 6.3). Its six ghost kinds and its
 *    divergent member shapes die with it; see
 *    `ContractMirrorGhostKind` and `ReconciledKindForMirror` below.
 * 3. Catalog: `src/lib/platform/sql/ops-catalog.ts`, 74 kinds
 *    (34 reads + 40 writes) including `messages.get` since the
 *    V3-14 catalog amendment (wave 3B, AD-44), with row/input
 *    types, result maps, metadata, and type-level exhaustiveness
 *    checks. Verdict: SOURCE OF TRUTH. Every type below is built
 *    from the catalog by alias, union, or indexed access. Nothing
 *    here redefines a kind, a row, or a result shape.
 *
 * `messages.get`, the 74th kind, was ratified as a W1 client read
 * kind by the D/G lock-in (G-04) and carried by the server kind
 * mirror (AD-44, AMD-O10-01) before it entered the catalog code.
 * The V3-14 catalog amendment (wave 3B) added it to the catalog:
 * form `{ kind: "messages.get"; id: number }`, result
 * `SqlChatMessageRow` through `queryOne` (null when the row does
 * not exist). Negative ids (the upstream store-only convention)
 * answer null without error; the caller keeps its store fallback.
 * The kind is defined exactly once, in the catalog; this file
 * carries no extra member for it. History: before the amendment,
 * this file folded the kind in ahead of the catalog code, guarded
 * by a tripwire check that failed typecheck once the catalog
 * carried it; the amendment landed, so the extra member and the
 * tripwire were removed.
 *
 * What this file deliberately does NOT do:
 *
 * - It does not touch `interface.ts`, `ops-catalog.ts`, or
 *   `tests/contract/contract-types.ts`. The integration merge owns
 *   those edits (D/G lock-in section 6.5, steps 2-3).
 * - It is not barrel-exported. `src/lib/platform/index.ts` already
 *   exports `SqlAdapter` from `./sql/interface`; adding a second
 *   export of the same name from here would collide. Integration
 *   folds this surface into `interface.ts` (or re-exports it from
 *   there) and keeps one export.
 * - It does not define a fourth form. The server-side kind mirror
 *   (`server/src/services/db/kinds.ts`) is a restatement pinned to
 *   the catalog text by `server/test/db-kinds.spec.ts`, not a form;
 *   it keeps its pin and gains no new shape from this file.
 * - It does not restate upstream. Upstream `src/db/*` (raw SQL
 *   strings through `@tauri-apps/plugin-sql` `getDb()`, plus
 *   `invoke('execute_record_transaction', ...)` carrying SQL
 *   statements) is the legacy surface the 3C codemod rewrites
 *   call-site by call-site into unified operations. The server
 *   Drizzle usage (`server/src/db/*`, `server/src/services/db/*`)
 *   is the handler-side implementation behind the HTTP endpoints,
 *   not a client form. Neither is a competing interface shape.
 *
 * Invariant (AD-26): no raw SQL reaches the client, and no unified
 * operation carries SQL, a table name, a column name, or a
 * workspace id. The type-level half of that invariant is checked
 * below (`ReconciledNoForbiddenKeysCheck`); the runtime half is
 * pinned by `reconciled-forms.spec.ts` and enforced at the points
 * listed in fase1/desain-rekonsiliasi-tiga-bentuk-sql.md section 5.
 */

import type {
  DbReadOperation,
  DbWriteOperation,
  SqlOpKind,
  SqlOpMetadata,
  SqlReadOpKind,
  SqlReadRowByKind,
  SqlWriteOpKind,
  SqlWriteResult,
  SqlWriteResultByKind,
} from "./ops-catalog";

// ---------------------------------------------------------------------------
// Unified operations: exactly the catalog
// ---------------------------------------------------------------------------

/**
 * Unified read operations: exactly the catalog read union.
 * `messages.get` (kind 74) lives in the catalog since the V3-14
 * catalog amendment; no extra member is defined here.
 */
export type ReconciledReadOperation = DbReadOperation;

/** Unified write operations: exactly the catalog write union. */
export type ReconciledWriteOperation = DbWriteOperation;

/** Any unified operation, read or write. */
export type ReconciledOperation =
  | ReconciledReadOperation
  | ReconciledWriteOperation;

/** Unified read kinds: exactly the catalog read kinds. */
export type ReconciledReadOpKind = ReconciledReadOperation["kind"];

/** Unified write kinds: exactly the catalog write kinds. */
export type ReconciledWriteOpKind = ReconciledWriteOperation["kind"];

/** All unified kinds. */
export type ReconciledOpKind = ReconciledReadOpKind | ReconciledWriteOpKind;

/**
 * Read result rows by kind: exactly the catalog map. The catalog
 * map is not copied, so a catalog row change flows through
 * unchanged; it carries `messages.get` since the V3-14 catalog
 * amendment.
 */
export type ReconciledReadRowByKind = SqlReadRowByKind;

/** Write results by kind: exactly the catalog map. */
export type ReconciledWriteResultByKind = SqlWriteResultByKind;

/** The row type returned by read kind K. */
export type ReconciledReadRow<K extends ReconciledReadOpKind> =
  ReconciledReadRowByKind[K];

/** The result type returned by write kind K. */
export type ReconciledWriteResult<K extends ReconciledWriteOpKind> =
  ReconciledWriteResultByKind[K];

/** The read operation object for kind K. */
export type ReconciledReadOperationByKind<K extends ReconciledReadOpKind> =
  Extract<ReconciledReadOperation, { kind: K }>;

/** The write operation object for kind K. */
export type ReconciledWriteOperationByKind<K extends ReconciledWriteOpKind> =
  Extract<ReconciledWriteOperation, { kind: K }>;

/** The operation object (read or write) for kind K. */
export type ReconciledOperationByKind<K extends ReconciledOpKind> = Extract<
  ReconciledOperation,
  { kind: K }
>;

// ---------------------------------------------------------------------------
// Client-visible subset: the server-only kind never reaches a client
// ---------------------------------------------------------------------------

/**
 * The one server-only kind (catalog metadata `exposure:
 * "server-only"`, wave W2). It runs inside the server worker only,
 * never through the HTTP endpoints, and never through a client
 * adapter. The web adapter rejects it locally before any HTTP; the
 * server rejects it with 410 as the second defense (D/G lock-in
 * section 7 rule 5). The literal is pinned against the catalog
 * metadata at runtime by `reconciled-forms.spec.ts`.
 */
export type ReconciledServerOnlyKind = "vector.replaceChunks";

/** Unified operations a browser or desktop client may send. */
export type ReconciledClientOperation = Exclude<
  ReconciledOperation,
  { kind: ReconciledServerOnlyKind }
>;

/** Unified read operations a client may send. */
export type ReconciledClientReadOperation = Exclude<
  ReconciledReadOperation,
  { kind: ReconciledServerOnlyKind }
>;

/** Unified write operations a client may send. */
export type ReconciledClientWriteOperation = Exclude<
  ReconciledWriteOperation,
  { kind: ReconciledServerOnlyKind }
>;

// ---------------------------------------------------------------------------
// Adapter surface (design 3.2, kind-indexed)
// ---------------------------------------------------------------------------

/**
 * Production adapter modes. `"fake"` is NOT a member: it lives only
 * on the contract fake class (D/G lock-in section 6.3), never on a
 * production adapter type.
 */
export type SqlMode = "tauri" | "web";

/** Adapter health, from design 3.2. */
export interface SqlHealth {
  ok: boolean;
  mode: SqlMode;
  /** Web: from /api/health/ready. Tauri: true once load succeeds. */
  migrationsCurrent: boolean;
}

/** Adapter error codes, from design 3.2. */
export type SqlErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "UNAVAILABLE"
  | "UNKNOWN";

/**
 * Adapter error shape. The integration merge provides the class;
 * this interface pins the fields callers may rely on: a code, a
 * retryable flag, and optional details that never carry SQL text,
 * secrets, or absolute paths.
 */
export interface SqlAdapterError extends Error {
  code: SqlErrorCode;
  retryable: boolean;
  details?: unknown;
}

/**
 * Write result shape, aliased from the catalog (D-10). There is no
 * second definition: the mirror's `duplicate?`/`committed?`
 * extensions on the general shape are rejected. Only
 * `wiki.commitRevision` returns the extended
 * `SqlWikiCommitResult`, through `ReconciledWriteResult`.
 */
export type WriteResult = SqlWriteResult;

/** Options for `transaction`: the idempotency key only. */
export interface SqlTransactionOptions {
  idempotencyKey?: string;
}

/**
 * The unified adapter interface. Deliberate tightening over the
 * design 3.2 sketch and the contract mirror: `query`, `queryOne`,
 * and `execute` are indexed by kind, so the row and result types
 * follow from the operation and a caller can no longer claim the
 * wrong row type with an explicit type argument. `queryMany` keeps
 * the design shape (results in request order, narrowed per
 * position by the caller) because a read batch is heterogeneous.
 * `transaction` returns the general `WriteResult` array; a caller
 * that needs the `committed` flag of `wiki.commitRevision` uses
 * `execute` for that single operation.
 *
 * Semantics carried from design 3.2 and the D/G lock-in:
 * - `query` returns an array of rows; `queryOne` returns the first
 *   row or null, and never throws over an empty set.
 * - `queryMany` runs all reads in one consistent read snapshot; one
 *   invalid operation fails the whole batch before any execution.
 * - `execute` is a one-operation transaction; `transaction` is
 *   all-or-nothing. No `begin`/`commit`/`rollback` is exposed.
 * - No row cache lives in the adapter; every `query` reads current
 *   state. `close()` is a resolving no-op on web.
 * - A W2 kind answers `UNAVAILABLE` naming the capability and the
 *   phase (never fake success, never an empty list). The
 *   server-only kind is rejected locally with `UNAVAILABLE`
 *   before any transport use.
 */
export interface ReconciledSqlAdapter {
  readonly mode: SqlMode;
  ready(): Promise<SqlHealth>;
  query<K extends ReconciledReadOpKind>(
    op: ReconciledReadOperationByKind<K>,
  ): Promise<ReconciledReadRow<K>[]>;
  queryOne<K extends ReconciledReadOpKind>(
    op: ReconciledReadOperationByKind<K>,
  ): Promise<ReconciledReadRow<K> | null>;
  queryMany(
    ops: readonly ReconciledReadOperation[],
  ): Promise<unknown[][]>;
  execute<K extends ReconciledWriteOpKind>(
    op: ReconciledWriteOperationByKind<K>,
  ): Promise<ReconciledWriteResult<K>>;
  transaction(
    ops: readonly ReconciledWriteOperation[],
    opts?: SqlTransactionOptions,
  ): Promise<WriteResult[]>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Kind metadata lookup: wave and exposure without duplicating lists
// ---------------------------------------------------------------------------

/** Per-kind audit metadata, aliased from the catalog. */
export type ReconciledKindMetadata = SqlOpMetadata;

/**
 * Read access to the catalog metadata, through which adapters
 * enforce wave and exposure rules locally (W2 rejection, the
 * server-only rejection) without restating the kind lists. The
 * metadata values themselves stay in `SQL_OP_METADATA`; no adapter
 * may carry its own copy of the wave or exposure table.
 */
export interface ReconciledKindMetadataLookup {
  metadata(kind: ReconciledOpKind): ReconciledKindMetadata;
}

// ---------------------------------------------------------------------------
// Per-form adapters: web (HTTP), Tauri (local), fake (contract only)
// ---------------------------------------------------------------------------

/**
 * One HTTP round trip for the database endpoints. The transport
 * carries typed operations only: the endpoint is one of the two
 * canonical paths, the body is the operation list, and the
 * idempotency key travels as a header value supplied by the
 * adapter. The transport never sees SQL, and the response body is
 * untrusted wire data the adapter validates before returning rows.
 */
export interface SqlDbHttpRequest {
  endpoint: "/api/transactions" | "/api/db/batch";
  operations: readonly ReconciledOperation[];
  idempotencyKey?: string;
}

/** Unvalidated HTTP response; the adapter maps status and body. */
export interface SqlDbHttpResponse {
  status: number;
  body: unknown;
}

/** Minimal HTTP dependency of the web adapter (one method). */
export interface SqlHttpTransport {
  request(input: SqlDbHttpRequest): Promise<SqlDbHttpResponse>;
}

/** Construction dependencies of the web adapter. */
export interface SqlWebAdapterDeps {
  transport: SqlHttpTransport;
  metadata: ReconciledKindMetadataLookup;
}

/**
 * Web adapter: the unified surface over HTTP. `query`/`queryOne`/
 * `queryMany` go to `POST /api/db/batch`; `execute`/`transaction`
 * go to `POST /api/transactions`. Both endpoints require session
 * auth plus CSRF. Status mapping is fixed: 410 becomes
 * `UNAVAILABLE`, 409 becomes `CONFLICT`, 404 becomes `NOT_FOUND`,
 * 400 becomes `VALIDATION`, 401/403 become `UNAUTHORIZED`/
 * `FORBIDDEN`. At most 50 operations per request; the adapter
 * rejects a longer batch locally with `VALIDATION` before any HTTP.
 */
export interface ReconciledWebSqlAdapter extends ReconciledSqlAdapter {
  readonly mode: "web";
}

/** Factory signature for the web adapter (wiring owns the call). */
export type CreateReconciledWebSqlAdapter = (
  deps: SqlWebAdapterDeps,
) => ReconciledWebSqlAdapter;

/**
 * Local execution boundary for the Tauri adapter. The executor
 * receives typed operations only and owns the fixed per-kind
 * statements against the local database; callers never supply SQL,
 * and the executor accepts no statement text in any parameter.
 * Statements stay inside the executor implementation, one fixed
 * set per kind, mirroring the server handler contract.
 */
export interface SqlLocalKindExecutor {
  executeRead(
    op: ReconciledReadOperation,
  ): Promise<readonly unknown[]>;
  executeWrite(
    ops: readonly ReconciledWriteOperation[],
  ): Promise<WriteResult[]>;
  close(): Promise<void>;
}

/** Construction dependencies of the Tauri adapter. */
export interface SqlTauriAdapterDeps {
  executor: SqlLocalKindExecutor;
  metadata: ReconciledKindMetadataLookup;
}

/**
 * Tauri adapter: the unified surface over the local database. Same
 * operation semantics as web, including W2 `UNAVAILABLE` answers
 * and the local server-only rejection, so callers cannot observe
 * which form backs the adapter except through `mode` and `ready()`.
 */
export interface ReconciledTauriSqlAdapter extends ReconciledSqlAdapter {
  readonly mode: "tauri";
}

/** Factory signature for the Tauri adapter (wiring owns the call). */
export type CreateReconciledTauriSqlAdapter = (
  deps: SqlTauriAdapterDeps,
) => ReconciledTauriSqlAdapter;

/**
 * Fake-only mode value. It exists solely so the contract fake can
 * identify itself; it is not a `SqlMode` and must never appear on
 * a production adapter, a health payload, or a wire value.
 */
export type SqlFakeMode = "fake";

/**
 * Contract fake adapter: the unified surface with the fake-only
 * mode. The fake class lives under `tests/contract/` only. Its
 * behavior (seeded state, in-memory execution) is owned by the
 * contract suite, which V3-41 re-points at the unified types after
 * the V3-14 merge; no production code imports the fake.
 */
export interface ReconciledFakeSqlAdapter
  extends Omit<ReconciledSqlAdapter, "mode"> {
  readonly mode: SqlFakeMode;
}

// ---------------------------------------------------------------------------
// Legacy contract-mirror mapping: what dies, what maps, what never maps
// ---------------------------------------------------------------------------

/**
 * The 30 kinds of the contract mirror
 * (`tests/contract/contract-types.ts`, lines 236-344). Listed here
 * by name only so the mapping below can be checked; the mirror
 * member shapes are NOT restated and must not be copied anywhere.
 */
export type ContractMirrorKind =
  | "marks.list"
  | "marks.get"
  | "marks.listByTag"
  | "tags.list"
  | "tags.get"
  | "knowledge.listSources"
  | "knowledge.getSource"
  | "knowledge.stats"
  | "vector.summaries"
  | "canvases.list"
  | "canvases.get"
  | "wiki.getSourceState"
  | "marks.create"
  | "marks.update"
  | "marks.softDelete"
  | "marks.restore"
  | "marks.deletePermanent"
  | "marks.updateTags"
  | "marks.saveTagIds"
  | "tags.create"
  | "tags.delete"
  | "knowledge.registerSource"
  | "knowledge.claimSource"
  | "knowledge.completeSource"
  | "knowledge.failSource"
  | "knowledge.retrySource"
  | "vector.insertChunk"
  | "vector.replaceChunks"
  | "canvases.save"
  | "wiki.commitRevision";

/**
 * The six ghost kinds: present in the mirror, absent from the
 * catalog and from design 3.4, and never to be implemented (D/G
 * lock-in section 6.3). The knowledge status machine keeps using
 * `knowledge.upsertSource` / `knowledge.updateStatus` /
 * `knowledge.removeSource`; chunk work uses `vector.replaceChunks`
 * on the server only.
 */
export type ContractMirrorGhostKind =
  | "knowledge.registerSource"
  | "knowledge.claimSource"
  | "knowledge.completeSource"
  | "knowledge.failSource"
  | "knowledge.retrySource"
  | "vector.insertChunk";

/** Mirror kinds that survive, by name, into the unified form. */
export type ContractMirrorLiveKind = Exclude<
  ContractMirrorKind,
  ContractMirrorGhostKind
>;

/**
 * Mirror kind to unified kind. Live mirror kinds map to the same
 * name, but the MEMBER SHAPE is always the catalog shape: every
 * divergent mirror parameter (flat `expectedVersion`, `tagId?` on
 * `marks.list`, `(sourceType, sourceId)` on `knowledge.getSource`,
 * and the rest listed in the design doc) is discarded, not
 * carried. Ghost kinds map to `never`: there is no unified
 * operation for them, and any code mentioning one fails the
 * checks below and the contract-suite remap.
 */
export type ReconciledKindForMirror<K extends ContractMirrorKind> =
  K extends ContractMirrorGhostKind ? never : K & ReconciledOpKind;

// ---------------------------------------------------------------------------
// Type-level conformance checks (a mismatch fails typecheck)
// ---------------------------------------------------------------------------

type ReconciledTypesEqual<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

type ReconciledAssertTrue<T extends true> = T;

/** The unified read kinds are exactly the catalog reads. */
type ReconciledReadKindsCheck = ReconciledAssertTrue<
  ReconciledTypesEqual<ReconciledReadOpKind, SqlReadOpKind>
>;

/** The unified write kinds are exactly the catalog writes. */
type ReconciledWriteKindsCheck = ReconciledAssertTrue<
  ReconciledTypesEqual<ReconciledWriteOpKind, SqlWriteOpKind>
>;

/**
 * History: a tripwire check here asserted the catalog did not yet
 * carry `messages.get`. The V3-14 catalog amendment landed, so the
 * check was removed with the extra member; the kind is defined
 * once, in the catalog.
 */

/** The unified read row map covers exactly the unified read kinds. */
type ReconciledReadRowsCheck = ReconciledAssertTrue<
  ReconciledTypesEqual<keyof ReconciledReadRowByKind, ReconciledReadOpKind>
>;

/** The unified write result map covers exactly the unified write kinds. */
type ReconciledWriteResultsCheck = ReconciledAssertTrue<
  ReconciledTypesEqual<
    keyof ReconciledWriteResultByKind,
    ReconciledWriteOpKind
  >
>;

/** Read and write kind sets do not overlap. */
type ReconciledKindsDisjointCheck = ReconciledAssertTrue<
  ReconciledTypesEqual<
    Extract<ReconciledReadOpKind, ReconciledWriteOpKind>,
    never
  >
>;

/** The server-only kind is a catalog write kind, and only that one. */
type ReconciledServerOnlyCheck = ReconciledAssertTrue<
  ReconciledTypesEqual<
    Extract<SqlOpKind, ReconciledServerOnlyKind>,
    ReconciledServerOnlyKind
  >
>;

/** Client operations exclude the server-only kind. */
type ReconciledClientExcludesServerOnlyCheck = ReconciledAssertTrue<
  ReconciledTypesEqual<
    Extract<ReconciledClientOperation["kind"], ReconciledServerOnlyKind>,
    never
  >
>;

/** `WriteResult` is exactly the catalog shape: no duplicate/committed. */
type ReconciledWriteResultCheck = ReconciledAssertTrue<
  ReconciledTypesEqual<keyof WriteResult, "affected" | "id" | "version">
>;

/** Production modes exclude "fake". */
type ReconciledModesCheck = ReconciledAssertTrue<
  ReconciledTypesEqual<Extract<SqlMode, "fake">, never>
>;

/** Ghost kinds have no unified operation. */
type ReconciledGhostKindsCheck = ReconciledAssertTrue<
  ReconciledTypesEqual<
    Extract<ContractMirrorGhostKind, ReconciledOpKind>,
    never
  >
>;

/** Every live mirror kind exists in the unified form. */
type ReconciledLiveMirrorKindsCheck = ReconciledAssertTrue<
  ReconciledTypesEqual<
    Exclude<ContractMirrorLiveKind, ReconciledOpKind>,
    never
  >
>;

/**
 * No unified operation member carries a forbidden key: no SQL, no
 * table or column names, no workspace id, in any member of either
 * union. The check is distributive over the union, so one bad
 * member fails it. Nested payload keys (patch, input objects) are
 * pinned by the runtime key scan in `reconciled-forms.spec.ts`,
 * because nested object types cannot be enumerated this way.
 */
type ReconciledForbiddenOperationKeys =
  | "sql"
  | "query"
  | "statement"
  | "table"
  | "columns"
  | "raw"
  | "workspaceId"
  | "workspace_id";

type ReconciledMemberHasNoForbiddenKeys<T> = T extends unknown
  ? ReconciledTypesEqual<
      Extract<keyof T, ReconciledForbiddenOperationKeys>,
      never
    >
  : never;

type ReconciledNoForbiddenKeysCheck = ReconciledAssertTrue<
  false extends ReconciledMemberHasNoForbiddenKeys<ReconciledOperation>
    ? false
    : true
>;

/**
 * Combined conformance proof for this file. Referenced so every
 * check above participates in typechecking.
 */
export type ReconciledFormsConformanceChecks =
  | ReconciledReadKindsCheck
  | ReconciledWriteKindsCheck
  | ReconciledReadRowsCheck
  | ReconciledWriteResultsCheck
  | ReconciledKindsDisjointCheck
  | ReconciledServerOnlyCheck
  | ReconciledClientExcludesServerOnlyCheck
  | ReconciledWriteResultCheck
  | ReconciledModesCheck
  | ReconciledGhostKindsCheck
  | ReconciledLiveMirrorKindsCheck
  | ReconciledNoForbiddenKeysCheck;
