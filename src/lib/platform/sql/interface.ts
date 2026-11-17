// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * SqlAdapter interface: typed catalog operations (V3-14, 3E fold).
 *
 * This file replaces the AD-26 marker stub (merge M5) with the real
 * surface. The stub existed only to keep the registry shape
 * typechecking until V3-14; the raw-SQL form it replaced (an
 * adapter taking SQL strings) stays rejected and must never return
 * in any form, including "only for Tauri", "only for debug", or
 * "only temporarily". No raw SQL from the client, no table names,
 * no column names, no workspace id in any operation (AD-26, AD-05).
 *
 * The surface itself is defined once, in
 * `./reconciled-forms.ts` (the V3-14 reconciliation design, W23):
 * kind-indexed `query`, `queryOne`, and `execute`, heterogeneous
 * `queryMany`, all-or-nothing `transaction`, `ready`, and `close`,
 * over the 74 catalog kinds in `./ops-catalog.ts` (34 reads + 40
 * writes, including `messages.get`, kind 74, AD-44). This file
 * re-exports that surface under the canonical `SqlAdapter` name
 * (the fold the reconciliation design allows: fold into this file
 * or re-export from it, one barrel export) and owns the one
 * runtime value on the surface, the `SqlAdapterError` class, whose
 * fields are pinned by the reconciled error-shape interface. Do
 * not define a second adapter surface, a second error type, or a
 * second mode/health/options shape anywhere else: the web adapter
 * (`sql.web.ts`) imports all of them from here (D-5 closed), and
 * the Tauri adapter (`sql.tauri.ts`) does the same.
 *
 * Semantics (design 3.2, reconciliation section 3.3):
 * - `query` returns rows; `queryOne` returns the first row or
 *   null and never throws over an empty set.
 * - `queryMany` runs all reads in request order; one invalid
 *   operation fails the whole batch before any execution.
 * - `execute` is a one-operation transaction; `transaction` is
 *   all-or-nothing. No begin/commit/rollback is exposed, and no
 *   row cache lives in the adapter.
 * - A W2 kind answers UNAVAILABLE naming the capability and the
 *   phase, never fake success and never an empty list. The one
 *   server-only kind is rejected locally with UNAVAILABLE before
 *   any transport use. `close()` is a resolving no-op on web.
 * - Error messages and details never carry SQL text, secrets,
 *   row data, or absolute paths.
 *
 * Implementations live beside this file (`sql.web.ts`,
 * `sql.tauri.ts`); registration is owned by wiring (AD-33), never
 * by this module. Callers reach the adapter through the platform
 * registry (`platform.sql`), never by importing an implementation.
 */

import type {
  SqlAdapterError as SqlAdapterErrorShape,
  ReconciledSqlAdapter,
  SqlErrorCode,
} from "./reconciled-forms";

export type {
  SqlErrorCode,
  SqlHealth,
  SqlMode,
  SqlTransactionOptions,
  WriteResult,
} from "./reconciled-forms";

/**
 * The canonical SqlAdapter: exactly the reconciled surface. There
 * is one definition (in `./reconciled-forms.ts`); this alias is
 * the name the registry, the barrel, and the implementations use.
 */
export type SqlAdapter = ReconciledSqlAdapter;

/**
 * The single error type thrown by SqlAdapter implementations.
 * Fields match the reconciled error-shape interface: a code, a
 * retryable flag, and optional details that never carry SQL text,
 * secrets, or absolute paths. `details` for transport failures
 * carries the envelope details plus correlation keys (`wireCode`,
 * `status`, `requestId`); for local validation failures it
 * carries the wire code the server would answer plus the failing
 * operation identity, in the same shapes the server uses.
 */
export class SqlAdapterError extends Error implements SqlAdapterErrorShape {
  readonly code: SqlErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: SqlErrorCode,
    message: string,
    options?: { retryable?: boolean; details?: unknown },
  ) {
    super(message);
    this.name = "SqlAdapterError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}
