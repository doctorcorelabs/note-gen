// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Web column factory for the SQL contract suite (F6).
 *
 * `webSqlFactory` runs the REAL web adapter (`createWebSqlAdapter`)
 * over the REAL transport (`createSqlDbClient`) with a fake DB
 * endpoint behind the `fetchImpl` seam. The fake endpoint speaks
 * the canonical envelope (kontrak-api-kanonis.md section 3.4):
 * POST /api/transactions runs the operations through a fresh
 * `FakeSqlAdapter` transaction and answers
 * `{ok: true, data: {transactionId, results}}`; POST /api/db/batch
 * runs `queryMany` and answers `{ok: true, data: {results}}`.
 * Errors answer the error envelope with the HTTP status the
 * adapter maps back to the fake's `SqlErrorCode` and the wire code
 * the fake recorded in `details.wireCode`, so the full chain
 * (adapter validation, transport chunking, envelope parsing, wire
 * code mapping, message rebuilding) is exercised end to end while
 * the data behavior stays the fake's.
 *
 * The CSRF header is required on both endpoints with the dummy
 * test token, following the Store web column precedent, so a
 * wiring regression that drops the provider fails loudly instead
 * of passing silently. The `Idempotency-Key` header passes
 * through to the fake's idempotency store; the shim keeps no
 * separate store. The health probe answers healthy with current
 * migrations: liveness probing belongs to the wiring, not to the
 * data contract.
 *
 * Each `create()` builds a fresh fake plus a fresh fetch seam, so
 * no state is shared between cases. The fake's mode is "web", the
 * same mode the real adapter reports.
 *
 * Import note: this factory imports the adapter and transport
 * modules directly instead of going through the registry. The
 * registry is global and freezes, so it cannot serve isolated
 * per-case instances with an injected fake transport; the direct
 * import follows the adapter specs' precedent and the Store web
 * column's precedent, and stays inside `src/lib/platform/`.
 */

import { randomUUID } from "node:crypto";
import {
  createSqlDbClient,
  SQL_DB_BATCH_PATH,
  SQL_TRANSACTIONS_PATH,
  type SqlDbFetchLike,
  type SqlDbFetchResponseLike,
} from "../../../src/lib/platform/sql/db-client";
import { createWebSqlAdapter } from "../../../src/lib/platform/sql/sql.web";
import { createFakeSqlAdapter } from "../../fakes/fake-sql";
import type { ContractFactory } from "../contract-harness";
import { SqlAdapterError } from "../contract-types";
import type {
  DbReadOperation,
  DbWriteOperation,
  SqlAdapter,
  SqlErrorCode,
} from "../contract-types";

/** Synthetic CSRF token for the contract column; never a real secret. */
const CSRF_TEST_TOKEN = "contract-csrf-token";
const CSRF_HEADER = "X-CSRF-Token";
const IDEMPOTENCY_HEADER = "Idempotency-Key";

function jsonResponse(
  status: number,
  body: unknown,
): SqlDbFetchResponseLike {
  return {
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

function httpStatusFor(code: SqlErrorCode): number {
  switch (code) {
    case "VALIDATION":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "UNAVAILABLE":
      return 410;
    case "UNKNOWN":
      return 500;
  }
}

function fallbackWireCode(code: SqlErrorCode): string {
  switch (code) {
    case "VALIDATION":
      return "validation_failed";
    case "NOT_FOUND":
      return "not_found";
    case "CONFLICT":
      return "conflict";
    case "UNAUTHORIZED":
      return "unauthorized";
    case "FORBIDDEN":
      return "forbidden";
    case "UNAVAILABLE":
      return "capability_unavailable";
    case "UNKNOWN":
      return "internal_error";
  }
}

function errorResponse(error: SqlAdapterError): SqlDbFetchResponseLike {
  const details = (error.details ?? {}) as Record<string, unknown>;
  const wireCode =
    typeof details.wireCode === "string" && details.wireCode !== ""
      ? details.wireCode
      : fallbackWireCode(error.code);
  return jsonResponse(httpStatusFor(error.code), {
    ok: false,
    error: {
      code: wireCode,
      message: error.message,
      requestId: "contract-shim",
      retryable: false,
      details,
    },
  });
}

function requireCsrfToken(headers: Record<string, string>): void {
  if (headers[CSRF_HEADER] !== CSRF_TEST_TOKEN) {
    throw new Error(
      "contract fake server: request without the expected CSRF token",
    );
  }
}

function parseOperations(body: string | undefined): unknown[] {
  const parsed = JSON.parse(body ?? "{}") as { operations?: unknown };
  if (!Array.isArray(parsed.operations)) {
    throw new Error("contract fake server: request body has no operations array");
  }
  return parsed.operations;
}

function createFakeDbFetch(
  fake: ReturnType<typeof createFakeSqlAdapter>,
): SqlDbFetchLike {
  return async (url, init = {}) => {
    const headers = init.headers ?? {};
    requireCsrfToken(headers);
    if (url === SQL_TRANSACTIONS_PATH && init.method === "POST") {
      const operations = parseOperations(init.body) as DbWriteOperation[];
      const key = headers[IDEMPOTENCY_HEADER];
      try {
        const results = await fake.transaction(operations, {
          ...(key === undefined ? {} : { idempotencyKey: key }),
        });
        const entries = results.map((result, index) => ({
          kind: operations[index].kind,
          affected: result.affected,
          ...(result.id === undefined ? {} : { id: result.id }),
          ...(result.version === undefined ? {} : { version: result.version }),
          ...("committed" in result && result.committed !== undefined
            ? { committed: result.committed }
            : {}),
        }));
        return jsonResponse(200, {
          ok: true,
          data: { transactionId: randomUUID(), results: entries },
        });
      } catch (error) {
        if (error instanceof SqlAdapterError) {
          return errorResponse(error);
        }
        throw error;
      }
    }
    if (url === SQL_DB_BATCH_PATH && init.method === "POST") {
      const operations = parseOperations(init.body) as DbReadOperation[];
      try {
        const batches = await fake.queryMany(operations);
        const results = batches.map((rows, index) => ({
          kind: operations[index].kind,
          rows,
        }));
        return jsonResponse(200, { ok: true, data: { results } });
      } catch (error) {
        if (error instanceof SqlAdapterError) {
          return errorResponse(error);
        }
        throw error;
      }
    }
    return jsonResponse(404, {
      ok: false,
      error: {
        code: "not_found",
        message: `contract fake server: unknown endpoint ${url}`,
        requestId: "contract-shim",
        retryable: false,
      },
    });
  };
}

export const webSqlFactory: ContractFactory<SqlAdapter> = {
  name: "web",
  create: () => {
    const fake = createFakeSqlAdapter();
    const port = createSqlDbClient({
      fetchImpl: createFakeDbFetch(fake),
      getCsrfToken: () => CSRF_TEST_TOKEN,
      delayImpl: () => Promise.resolve(),
    });
    return createWebSqlAdapter({
      port,
      health: () =>
        Promise.resolve({ ok: true, migrationsCurrent: true }),
    });
  },
  teardown: async (impl) => {
    await impl.close();
  },
};
