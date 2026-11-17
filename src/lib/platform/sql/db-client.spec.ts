// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Behavior specs for the batch/transaction HTTP client (db-client.ts,
// V3-14 part 3).
//
// The client is tested against a fake fetch: no server, no database.
// The fake records every call (URL, headers, body), so chunking,
// idempotency-key stability, retry counts, and CSRF attachment are
// all observable, and the 409 no-retry rule is proved by counting
// fetch invocations. Operation payloads beyond `kind` are never
// inspected by the client (the server is the final authority), so
// invalid operations are built through casts and only the client's
// own checks (shape, kind, forbidden fields, group, exposure) are
// asserted here.
//
// Run: `pnpm vitest run --project unit src/lib/platform/sql/db-client.spec.ts`
// from the repo root. The file uses vitest (the `unit` project in
// vitest.config.ts), following the sql.web.ts spec precedent.

import { describe, expect, it } from "vitest";
import {
  DB_CLIENT_DEFAULT_RETRY_DELAY_MS,
  DB_CLIENT_MAX_OPERATIONS_PER_REQUEST,
  DB_CLIENT_RETRY_AFTER_MAX_MS,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  SQL_DB_BATCH_PATH,
  SQL_TRANSACTIONS_PATH,
  chunkOperations,
  createIdempotencyKey,
  createSqlDbClient,
  deriveChunkIdempotencyKey,
  deriveSqlDbRetryable,
  mapWireCodeToLocalCode,
  parseSqlDbEnvelope,
  retryDelayMsForResponse,
  sqlDbErrorFromWire,
  validateDbClientOperations,
  validateIdempotencyKeyValue,
  SqlDbClientError,
  type SqlDbClient,
  type SqlDbFetchInitLike,
  type SqlDbFetchLike,
  type SqlDbFetchResponseLike,
  type SqlDbLocalCode,
} from "./db-client";
import {
  SQL_OP_KINDS,
  SQL_READ_OP_KINDS,
  SQL_WRITE_OP_KINDS,
  type DbReadOperation,
  type DbWriteOperation,
} from "./ops-catalog";

// ---------------------------------------------------------------------------
// Fakes and helpers
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  init: SqlDbFetchInitLike | undefined;
}

function fakeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): SqlDbFetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => body,
  };
}

function successBody(data: unknown): string {
  return JSON.stringify({ ok: true, data });
}

function errorBody(
  code: string,
  options: {
    requestId?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  } = {},
): string {
  return JSON.stringify({
    ok: false,
    error: {
      code,
      message: "failure from the fake server",
      requestId: options.requestId ?? "req-1",
      retryable: options.retryable ?? false,
      details: options.details ?? {},
    },
  });
}

type FetchHandler = (
  call: RecordedCall,
) => SqlDbFetchResponseLike | Promise<SqlDbFetchResponseLike>;

function recordingFetch(handler: FetchHandler): {
  fetchImpl: SqlDbFetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: SqlDbFetchLike = async (url, init) => {
    const call: RecordedCall = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

/**
 * Auto-success handler: answers each chunk from its own request
 * body, echoing kinds back in request order with distinct
 * transaction ids per call. This is the fake the chunking specs
 * use; it proves reassembly without a real server.
 */
function autoSuccessHandler(): FetchHandler {
  let callIndex = 0;
  return (call) => {
    callIndex += 1;
    const body = JSON.parse(call.init?.body ?? "{}") as {
      operations: Array<{ kind: string }>;
    };
    if (call.url === SQL_TRANSACTIONS_PATH) {
      return fakeResponse(
        200,
        successBody({
          transactionId: `tx-${callIndex}`,
          results: body.operations.map((op) => ({ kind: op.kind, affected: 1 })),
        }),
      );
    }
    return fakeResponse(
      200,
      successBody({
        results: body.operations.map((op) => ({ kind: op.kind, rows: [{ kind: op.kind }] })),
      }),
    );
  };
}

function headerOf(call: RecordedCall, name: string): string | undefined {
  return call.init?.headers?.[name];
}

function bodyOf(call: RecordedCall): { operations: Array<{ kind: string }> } {
  return JSON.parse(call.init?.body ?? "{}") as { operations: Array<{ kind: string }> };
}

async function expectClientError(promise: Promise<unknown>): Promise<SqlDbClientError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SqlDbClientError);
    return error as SqlDbClientError;
  }
  throw new Error("expected the call to reject with SqlDbClientError");
}

function readOp(index: number): DbReadOperation {
  // Alternating kinds so request order is observable across chunks.
  if (index % 3 === 0) {
    return { kind: "tags.list" };
  }
  if (index % 3 === 1) {
    return { kind: "policy.get" };
  }
  return { kind: "marks.get", id: index };
}

function writeOp(index: number): DbWriteOperation {
  if (index % 2 === 0) {
    return { kind: "tags.create", name: `tag-${index}` };
  }
  return { kind: "marks.softDelete", id: index };
}

function readOps(count: number): DbReadOperation[] {
  return Array.from({ length: count }, (_, index) => readOp(index));
}

function writeOps(count: number): DbWriteOperation[] {
  return Array.from({ length: count }, (_, index) => writeOp(index));
}

function asWriteOps(value: unknown): DbWriteOperation[] {
  return value as DbWriteOperation[];
}

function asReadOps(value: unknown): DbReadOperation[] {
  return value as DbReadOperation[];
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

describe("chunkOperations", () => {
  it("returns no chunks for an empty input", () => {
    expect(chunkOperations([])).toEqual([]);
  });

  it("keeps 1 and 50 operations in a single chunk", () => {
    expect(chunkOperations(readOps(1))).toHaveLength(1);
    expect(chunkOperations(readOps(50))).toHaveLength(1);
    expect(chunkOperations(readOps(50))[0]).toHaveLength(50);
  });

  it("splits 51 operations into 50 + 1", () => {
    const chunks = chunkOperations(readOps(51));
    expect(chunks.map((chunk) => chunk.length)).toEqual([50, 1]);
  });

  it("splits 101 operations into 50 + 50 + 1, preserving order", () => {
    const ops = readOps(101);
    const chunks = chunkOperations(ops);
    expect(chunks.map((chunk) => chunk.length)).toEqual([50, 50, 1]);
    expect(chunks.flat()).toEqual(ops);
  });

  it("rejects a non-positive chunk size as validation_failed", () => {
    expect(() => chunkOperations(readOps(1), 0)).toThrow(SqlDbClientError);
    try {
      chunkOperations(readOps(1), 0);
    } catch (error) {
      expect((error as SqlDbClientError).code).toBe("validation_failed");
    }
  });

  it("uses the contract maximum of 50 operations per request", () => {
    expect(DB_CLIENT_MAX_OPERATIONS_PER_REQUEST).toBe(50);
  });
});

describe("executeBatch chunking", () => {
  it("sends 1 operation in one request to the batch path", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const result = await client.executeBatch(readOps(1));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(SQL_DB_BATCH_PATH);
    expect(calls[0].url).toBe("/api/db/batch");
    expect(bodyOf(calls[0]).operations).toHaveLength(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].kind).toBe("tags.list");
  });

  it("sends 50 operations in one request", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const result = await client.executeBatch(readOps(50));
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]).operations).toHaveLength(50);
    expect(result.results).toHaveLength(50);
  });

  it("sends 51 operations as 50 + 1 and reassembles in request order", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const ops = readOps(51);
    const result = await client.executeBatch(ops);
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[0]).operations).toHaveLength(50);
    expect(bodyOf(calls[1]).operations).toHaveLength(1);
    expect(result.results.map((entry) => entry.kind)).toEqual(
      ops.map((op) => op.kind),
    );
  });

  it("sends 101 operations as 50 + 50 + 1 and reassembles in request order", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const ops = readOps(101);
    const result = await client.executeBatch(ops);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => bodyOf(call).operations.length)).toEqual([50, 50, 1]);
    expect(result.results.map((entry) => entry.kind)).toEqual(
      ops.map((op) => op.kind),
    );
  });

  it("sends an empty batch as exactly one request with an empty array", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const result = await client.executeBatch([]);
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]).operations).toEqual([]);
    expect(result.results).toEqual([]);
  });
});

describe("executeTransaction chunking", () => {
  it("sends 1 operation in one request to the transactions path", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({
      fetchImpl,
      generateIdempotencyKey: () => "key-1",
    });
    const result = await client.executeTransaction(writeOps(1));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(SQL_TRANSACTIONS_PATH);
    expect(calls[0].url).toBe("/api/transactions");
    expect(result.transactionIds).toEqual(["tx-1"]);
    expect(result.results).toHaveLength(1);
  });

  it("sends 50 operations in one request with one transaction id", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const result = await client.executeTransaction(writeOps(50));
    expect(calls).toHaveLength(1);
    expect(result.transactionIds).toHaveLength(1);
    expect(result.results).toHaveLength(50);
  });

  it("sends 51 operations as 50 + 1 with one id per chunk, in order", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const ops = writeOps(51);
    const result = await client.executeTransaction(ops);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => bodyOf(call).operations.length)).toEqual([50, 1]);
    expect(result.transactionIds).toEqual(["tx-1", "tx-2"]);
    expect(result.results.map((entry) => entry.kind)).toEqual(
      ops.map((op) => op.kind),
    );
  });

  it("sends 101 operations as 50 + 50 + 1 with three ids, in order", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const result = await client.executeTransaction(writeOps(101));
    expect(calls).toHaveLength(3);
    expect(result.transactionIds).toEqual(["tx-1", "tx-2", "tx-3"]);
    expect(result.results).toHaveLength(101);
  });

  it("sends an empty transaction as exactly one request", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const result = await client.executeTransaction([]);
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]).operations).toEqual([]);
    expect(result.transactionIds).toEqual(["tx-1"]);
    expect(result.results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

describe("idempotency keys", () => {
  it("generates one key per call and sends it verbatim for a single chunk", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({
      fetchImpl,
      generateIdempotencyKey: () => "generated-key",
    });
    await client.executeTransaction(writeOps(3));
    expect(headerOf(calls[0], "Idempotency-Key")).toBe("generated-key");
  });

  it("derives a distinct stable key per chunk of a multi-chunk call", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({
      fetchImpl,
      generateIdempotencyKey: () => "base-key",
    });
    await client.executeTransaction(writeOps(51));
    expect(calls.map((call) => headerOf(call, "Idempotency-Key"))).toEqual([
      "base-key-chunk-1-of-2",
      "base-key-chunk-2-of-2",
    ]);
  });

  it("passes a caller-supplied key through verbatim for a single chunk", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    await client.executeTransaction(writeOps(1), { idempotencyKey: "caller-key" });
    expect(headerOf(calls[0], "Idempotency-Key")).toBe("caller-key");
  });

  it("sends no key for an explicit null or empty-string key", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    await client.executeTransaction(writeOps(1), { idempotencyKey: null });
    await client.executeTransaction(writeOps(1), { idempotencyKey: "" });
    expect(headerOf(calls[0], "Idempotency-Key")).toBeUndefined();
    expect(headerOf(calls[1], "Idempotency-Key")).toBeUndefined();
  });

  it("reuses the same key and body when the identical chunk is retried", async () => {
    let attempts = 0;
    const { fetchImpl, calls } = recordingFetch((call) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("network down");
      }
      return autoSuccessHandler()(call);
    });
    const delays: number[] = [];
    const client = createSqlDbClient({
      fetchImpl,
      generateIdempotencyKey: () => "stable-key",
      delayImpl: async (ms) => {
        delays.push(ms);
      },
    });
    await client.executeTransaction(writeOps(1));
    expect(calls).toHaveLength(2);
    expect(headerOf(calls[0], "Idempotency-Key")).toBe("stable-key");
    expect(headerOf(calls[1], "Idempotency-Key")).toBe("stable-key");
    expect(calls[1].init?.body).toBe(calls[0].init?.body);
    expect(delays).toEqual([DB_CLIENT_DEFAULT_RETRY_DELAY_MS]);
  });

  it("never sends an idempotency key on batch reads", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    await client.executeBatch(readOps(51));
    for (const call of calls) {
      expect(headerOf(call, "Idempotency-Key")).toBeUndefined();
    }
  });

  it("rejects an overlong caller key before any HTTP", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(
      client.executeTransaction(writeOps(1), {
        idempotencyKey: "k".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1),
      }),
    );
    expect(error.code).toBe("validation_failed");
    expect(calls).toHaveLength(0);
  });

  it("createIdempotencyKey returns unique keys within the length bound", () => {
    const keys = new Set(Array.from({ length: 50 }, () => createIdempotencyKey()));
    expect(keys.size).toBe(50);
    for (const key of keys) {
      expect(key.length).toBeGreaterThan(0);
      expect(key.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX_LENGTH);
    }
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(128);
  });

  it("deriveChunkIdempotencyKey keeps a single chunk unchanged", () => {
    expect(deriveChunkIdempotencyKey("base", 0, 1)).toBe("base");
  });

  it("deriveChunkIdempotencyKey truncates a long base key to fit the suffix", () => {
    const base = "k".repeat(128);
    const derived = deriveChunkIdempotencyKey(base, 0, 2);
    expect(derived.length).toBe(128);
    expect(derived.endsWith("-chunk-1-of-2")).toBe(true);
    expect(deriveChunkIdempotencyKey(base, 1, 2)).not.toBe(derived);
  });

  it("validateIdempotencyKeyValue treats null, undefined, and empty as no key", () => {
    expect(validateIdempotencyKeyValue(null)).toBeNull();
    expect(validateIdempotencyKeyValue(undefined)).toBeNull();
    expect(validateIdempotencyKeyValue("")).toBeNull();
    expect(validateIdempotencyKeyValue("ok")).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 409 conflicts are never retried
// ---------------------------------------------------------------------------

describe("409 conflicts are never retried", () => {
  it("calls fetch exactly once for 409 revision_conflict", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      fakeResponse(
        409,
        errorBody("revision_conflict", {
          details: { operationIndex: 0, kind: "tags.create" },
        }),
      ),
    );
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(client.executeTransaction(writeOps(1)));
    expect(calls).toHaveLength(1);
    expect(error.code).toBe("revision_conflict");
    expect(error.localCode).toBe("CONFLICT");
    expect(error.status).toBe(409);
    expect(error.retryable).toBe(false);
    expect(error.operationIndex).toBe(0);
    expect(error.kind).toBe("tags.create");
  });

  it("calls fetch exactly once even when a 409 envelope claims retryable", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      fakeResponse(409, errorBody("revision_conflict", { retryable: true })),
    );
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(client.executeTransaction(writeOps(1)));
    expect(calls).toHaveLength(1);
    expect(error.retryable).toBe(true);
  });

  it("calls fetch exactly once for 409 record_tags_changed and idempotency_key_reused", async () => {
    for (const code of ["record_tags_changed", "idempotency_key_reused"]) {
      const { fetchImpl, calls } = recordingFetch(() =>
        fakeResponse(409, errorBody(code)),
      );
      const client = createSqlDbClient({ fetchImpl });
      const error = await expectClientError(client.executeTransaction(writeOps(1)));
      expect(calls).toHaveLength(1);
      expect(error.code).toBe(code);
      expect(error.localCode).toBe("CONFLICT");
      expect(error.retryable).toBe(false);
    }
  });

  it("maps 412 revision_conflict to CONFLICT by code, with one call", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      fakeResponse(412, errorBody("revision_conflict")),
    );
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(client.executeTransaction(writeOps(1)));
    expect(calls).toHaveLength(1);
    expect(error.localCode).toBe("CONFLICT");
  });

  it("calls fetch exactly once for 400, 401, 403, 404, 410, 413, 500, and 501", async () => {
    const cases: Array<[number, string]> = [
      [400, "validation_failed"],
      [401, "unauthenticated"],
      [403, "csrf_invalid"],
      [404, "not_found"],
      [410, "capability_unavailable"],
      [413, "payload_too_large"],
      [500, "internal_error"],
      [501, "fuzzy_search_unavailable"],
    ];
    for (const [status, code] of cases) {
      const { fetchImpl, calls } = recordingFetch(() =>
        fakeResponse(status, errorBody(code)),
      );
      const client = createSqlDbClient({ fetchImpl });
      const error = await expectClientError(client.executeTransaction(writeOps(1)));
      expect(calls).toHaveLength(1);
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
    }
  });
});

// ---------------------------------------------------------------------------
// Retry: only network failures and retryable 429/503, at most once
// ---------------------------------------------------------------------------

describe("retry policy", () => {
  it("retries a 429 once, honoring Retry-After, then succeeds", async () => {
    let attempts = 0;
    const { fetchImpl, calls } = recordingFetch((call) => {
      attempts += 1;
      if (attempts === 1) {
        return fakeResponse(
          429,
          errorBody("rate_limited", { retryable: true }),
          { "retry-after": "2" },
        );
      }
      return autoSuccessHandler()(call);
    });
    const delays: number[] = [];
    const client = createSqlDbClient({
      fetchImpl,
      generateIdempotencyKey: () => "retry-key",
      delayImpl: async (ms) => {
        delays.push(ms);
      },
    });
    const result = await client.executeTransaction(writeOps(1));
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([2000]);
    expect(calls[1].init?.body).toBe(calls[0].init?.body);
    expect(headerOf(calls[1], "Idempotency-Key")).toBe("retry-key");
    expect(result.results).toHaveLength(1);
  });

  it("retries a 503 with the default delay when no Retry-After is sent", async () => {
    let attempts = 0;
    const { fetchImpl, calls } = recordingFetch((call) => {
      attempts += 1;
      if (attempts === 1) {
        return fakeResponse(503, errorBody("service_unavailable", { retryable: true }));
      }
      return autoSuccessHandler()(call);
    });
    const delays: number[] = [];
    const client = createSqlDbClient({
      fetchImpl,
      delayImpl: async (ms) => {
        delays.push(ms);
      },
    });
    await client.executeBatch(readOps(1));
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([DB_CLIENT_DEFAULT_RETRY_DELAY_MS]);
  });

  it("gives up after the single retry when the second 429 also fails", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      fakeResponse(429, errorBody("rate_limited", { retryable: true })),
    );
    const client = createSqlDbClient({
      fetchImpl,
      delayImpl: async () => {},
    });
    const error = await expectClientError(client.executeTransaction(writeOps(1)));
    expect(calls).toHaveLength(2);
    expect(error.code).toBe("rate_limited");
    expect(error.localCode).toBe("RATE_LIMITED");
    expect(error.retryable).toBe(true);
  });

  it("does not retry a 429 whose envelope says retryable false", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      fakeResponse(429, errorBody("rate_limited", { retryable: false })),
    );
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(client.executeTransaction(writeOps(1)));
    expect(calls).toHaveLength(1);
    expect(error.retryable).toBe(false);
  });

  it("retries a rejected fetch once and succeeds", async () => {
    let attempts = 0;
    const { fetchImpl, calls } = recordingFetch((call) => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError("fetch failed");
      }
      return autoSuccessHandler()(call);
    });
    const client = createSqlDbClient({
      fetchImpl,
      delayImpl: async () => {},
    });
    const result = await client.executeBatch(readOps(2));
    expect(calls).toHaveLength(2);
    expect(result.results).toHaveLength(2);
  });

  it("throws NETWORK_ERROR after two rejected fetches", async () => {
    const { fetchImpl, calls } = recordingFetch(() => {
      throw new TypeError("fetch failed");
    });
    const client = createSqlDbClient({
      fetchImpl,
      delayImpl: async () => {},
    });
    const error = await expectClientError(client.executeBatch(readOps(1)));
    expect(calls).toHaveLength(2);
    expect(error.code).toBeNull();
    expect(error.localCode).toBe("NETWORK_ERROR");
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(true);
  });

  it("throws TIMEOUT when the fetch rejection is a timeout", async () => {
    const { fetchImpl, calls } = recordingFetch(() => {
      const timeout = new Error("timed out");
      timeout.name = "TimeoutError";
      throw timeout;
    });
    const client = createSqlDbClient({
      fetchImpl,
      delayImpl: async () => {},
    });
    const error = await expectClientError(client.executeBatch(readOps(1)));
    expect(calls).toHaveLength(2);
    expect(error.localCode).toBe("TIMEOUT");
  });

  it("never retries a caller abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(
      client.executeBatch(readOps(1), { signal: controller.signal }),
    );
    expect(calls).toHaveLength(0);
    expect(error.localCode).toBe("TIMEOUT");
    expect(error.retryable).toBe(false);
  });

  it("sends no second attempt when the signal aborts during backoff", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = recordingFetch(() =>
      fakeResponse(429, errorBody("rate_limited", { retryable: true })),
    );
    const client = createSqlDbClient({
      fetchImpl,
      delayImpl: async () => {
        controller.abort();
        const aborted = new Error("aborted during backoff");
        aborted.name = "AbortError";
        throw aborted;
      },
    });
    const error = await expectClientError(
      client.executeBatch(readOps(1), { signal: controller.signal }),
    );
    expect(calls).toHaveLength(1);
    expect(error.localCode).toBe("TIMEOUT");
  });

  it("does not retry a fetch rejection named AbortError", async () => {
    const { fetchImpl, calls } = recordingFetch(() => {
      const aborted = new Error("aborted");
      aborted.name = "AbortError";
      throw aborted;
    });
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(client.executeBatch(readOps(1)));
    expect(calls).toHaveLength(1);
    expect(error.localCode).toBe("TIMEOUT");
  });
});

describe("retryDelayMsForResponse", () => {
  it("uses the default delay for a missing, negative, or non-numeric value", () => {
    expect(retryDelayMsForResponse(null)).toBe(DB_CLIENT_DEFAULT_RETRY_DELAY_MS);
    expect(retryDelayMsForResponse("-1")).toBe(DB_CLIENT_DEFAULT_RETRY_DELAY_MS);
    expect(retryDelayMsForResponse("soon")).toBe(DB_CLIENT_DEFAULT_RETRY_DELAY_MS);
    expect(retryDelayMsForResponse("Wed, 21 Oct 2015 07:28:00 GMT")).toBe(
      DB_CLIENT_DEFAULT_RETRY_DELAY_MS,
    );
  });

  it("converts delta-seconds to milliseconds and caps at the maximum", () => {
    expect(retryDelayMsForResponse("3")).toBe(3000);
    expect(retryDelayMsForResponse("3600")).toBe(DB_CLIENT_RETRY_AFTER_MAX_MS);
    expect(DB_CLIENT_RETRY_AFTER_MAX_MS).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// Error mapping (kontrak section 6)
// ---------------------------------------------------------------------------

describe("mapWireCodeToLocalCode", () => {
  it.each([
    ["validation_failed", 400, "VALIDATION_ERROR"],
    ["invalid_operation", 400, "VALIDATION_ERROR"],
    ["not_found", 404, "VALIDATION_ERROR"],
    ["revision_conflict", 409, "CONFLICT"],
    ["revision_conflict", 412, "CONFLICT"],
    ["record_tags_changed", 409, "CONFLICT"],
    ["idempotency_key_reused", 409, "CONFLICT"],
    ["tag_in_use", 409, "CONFLICT"],
    ["unauthenticated", 401, "AUTH_REQUIRED"],
    ["csrf_invalid", 403, "AUTH_REQUIRED"],
    ["origin_rejected", 403, "AUTH_REQUIRED"],
    ["forbidden", 403, "AUTH_REQUIRED"],
    ["capability_unavailable", 410, "CAPABILITY_UNAVAILABLE"],
    ["payload_too_large", 413, "PAYLOAD_TOO_LARGE"],
    ["text_too_large", 413, "PAYLOAD_TOO_LARGE"],
    ["rate_limited", 429, "RATE_LIMITED"],
    ["internal_error", 500, "SERVER_ERROR"],
    ["service_unavailable", 503, "SERVER_ERROR"],
    ["write_queue_timeout", 503, "SERVER_ERROR"],
    ["fuzzy_search_unavailable", 501, "FEATURE_NOT_YET_AVAILABLE"],
    ["document_parse_unavailable", 501, "FEATURE_NOT_YET_AVAILABLE"],
    ["restore_unavailable", 501, "FEATURE_NOT_YET_AVAILABLE"],
    ["precondition_required", 428, "VALIDATION_ERROR"],
    ["method_not_allowed", 405, "VALIDATION_ERROR"],
  ] as Array<[string, number, SqlDbLocalCode]>)(
    "maps %s (%i) to %s",
    (wireCode, status, expected) => {
      expect(mapWireCodeToLocalCode(wireCode, status)).toBe(expected);
    },
  );

  it("falls back to the HTTP status for an unknown wire code", () => {
    expect(mapWireCodeToLocalCode("something_new", 401)).toBe("AUTH_REQUIRED");
    expect(mapWireCodeToLocalCode("something_new", 409)).toBe("CONFLICT");
    expect(mapWireCodeToLocalCode("something_new", 410)).toBe("CAPABILITY_UNAVAILABLE");
    expect(mapWireCodeToLocalCode("something_new", 413)).toBe("PAYLOAD_TOO_LARGE");
    expect(mapWireCodeToLocalCode("something_new", 429)).toBe("RATE_LIMITED");
    expect(mapWireCodeToLocalCode("something_new", 418)).toBe("VALIDATION_ERROR");
    expect(mapWireCodeToLocalCode("something_new", 500)).toBe("SERVER_ERROR");
  });

  it("falls back to SERVER_ERROR with no code and no status", () => {
    expect(mapWireCodeToLocalCode(null, null)).toBe("SERVER_ERROR");
    expect(mapWireCodeToLocalCode(null, 503)).toBe("SERVER_ERROR");
  });
});

describe("deriveSqlDbRetryable", () => {
  it("lets the envelope value win over derivation", () => {
    expect(deriveSqlDbRetryable("revision_conflict", true, 409)).toBe(true);
    expect(deriveSqlDbRetryable("rate_limited", false, 429)).toBe(false);
  });

  it("derives true only for the three retryable catalog codes", () => {
    expect(deriveSqlDbRetryable("rate_limited", null, 429)).toBe(true);
    expect(deriveSqlDbRetryable("service_unavailable", null, 503)).toBe(true);
    expect(deriveSqlDbRetryable("write_queue_timeout", null, 503)).toBe(true);
    expect(deriveSqlDbRetryable("revision_conflict", null, 409)).toBe(false);
    expect(deriveSqlDbRetryable("internal_error", null, 500)).toBe(false);
  });

  it("uses the status for unknown or missing codes", () => {
    expect(deriveSqlDbRetryable(null, null, 429)).toBe(true);
    expect(deriveSqlDbRetryable(null, null, 503)).toBe(true);
    expect(deriveSqlDbRetryable(null, null, 409)).toBe(false);
    expect(deriveSqlDbRetryable("something_new", null, 429)).toBe(true);
    expect(deriveSqlDbRetryable("something_new", null, 500)).toBe(false);
  });
});

describe("sqlDbErrorFromWire and SqlDbClientError", () => {
  it("builds the error from code, status, and envelope fields only", () => {
    const error = sqlDbErrorFromWire({
      status: 409,
      code: "revision_conflict",
      requestId: "req-9",
      retryable: false,
      details: { operationIndex: 2, kind: "tags.create" },
    });
    expect(error.code).toBe("revision_conflict");
    expect(error.wireCode).toBe("revision_conflict");
    expect(error.localCode).toBe("CONFLICT");
    expect(error.status).toBe(409);
    expect(error.retryable).toBe(false);
    expect(error.requestId).toBe("req-9");
    expect(error.operationIndex).toBe(2);
    expect(error.kind).toBe("tags.create");
    expect(error.name).toBe("SqlDbClientError");
    expect(error.message).toContain("revision_conflict");
  });

  it("freezes details and exposes a log-safe summary without details", () => {
    const error = sqlDbErrorFromWire({
      status: 400,
      code: "validation_failed",
      details: { fields: [{ field: "operations[0]", issue: "bad" }] },
    });
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(error.toSafeSummary()).toEqual({
      code: "validation_failed",
      localCode: "VALIDATION_ERROR",
      status: 400,
      retryable: false,
      requestId: null,
      operationIndex: null,
      kind: null,
    });
  });

  it("prefers the envelope requestId and falls back to the response header", async () => {
    const withEnvelopeId = recordingFetch(() =>
      fakeResponse(400, errorBody("validation_failed", { requestId: "req-body" }), {
        "x-request-id": "req-header",
      }),
    );
    const clientA = createSqlDbClient({ fetchImpl: withEnvelopeId.fetchImpl });
    const errorA = await expectClientError(clientA.executeBatch(readOps(1)));
    expect(errorA.requestId).toBe("req-body");

    const headerOnly = recordingFetch(() =>
      fakeResponse(400, "not json", { "x-request-id": "req-header" }),
    );
    const clientB = createSqlDbClient({ fetchImpl: headerOnly.fetchImpl });
    const errorB = await expectClientError(clientB.executeBatch(readOps(1)));
    expect(errorB.requestId).toBe("req-header");
  });
});

// ---------------------------------------------------------------------------
// Envelope parsing and response shape validation
// ---------------------------------------------------------------------------

describe("parseSqlDbEnvelope", () => {
  it("parses a success envelope, including null data", () => {
    expect(parseSqlDbEnvelope('{"ok":true,"data":{"a":1}}')).toEqual({
      kind: "success",
      data: { a: 1 },
    });
    expect(parseSqlDbEnvelope('{"ok":true,"data":null}')).toEqual({
      kind: "success",
      data: null,
    });
  });

  it("parses an error envelope with normalized fields", () => {
    expect(
      parseSqlDbEnvelope(
        '{"ok":false,"error":{"code":"not_found","requestId":"r","retryable":false,"details":{"x":1}}}',
      ),
    ).toEqual({
      kind: "error",
      code: "not_found",
      requestId: "r",
      retryable: false,
      details: { x: 1 },
    });
  });

  it("normalizes a missing retryable and non-object details to null and {}", () => {
    expect(parseSqlDbEnvelope('{"ok":false,"error":{"code":"not_found"}}')).toEqual({
      kind: "error",
      code: "not_found",
      requestId: null,
      retryable: null,
      details: {},
    });
  });

  it("treats empty, non-JSON, and shapeless bodies as malformed", () => {
    expect(parseSqlDbEnvelope("")).toEqual({ kind: "malformed" });
    expect(parseSqlDbEnvelope("not json")).toEqual({ kind: "malformed" });
    expect(parseSqlDbEnvelope("[]")).toEqual({ kind: "malformed" });
    expect(parseSqlDbEnvelope('{"ok":true}')).toEqual({ kind: "malformed" });
    expect(parseSqlDbEnvelope('{"ok":false}')).toEqual({ kind: "malformed" });
    expect(parseSqlDbEnvelope('{"ok":false,"error":{}}')).toEqual({ kind: "malformed" });
    expect(parseSqlDbEnvelope('{"ok":false,"error":{"code":""}}')).toEqual({
      kind: "malformed",
    });
    expect(parseSqlDbEnvelope('{"ok":"yes","data":{}}')).toEqual({ kind: "malformed" });
  });
});

describe("response shape handling", () => {
  it("rejects a success envelope on an error status as internal_error", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      fakeResponse(500, successBody({ transactionId: "tx-1", results: [] })),
    );
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(client.executeTransaction(writeOps(1)));
    expect(calls).toHaveLength(1);
    expect(error.code).toBe("internal_error");
    expect(error.status).toBe(500);
  });

  it("rejects a malformed body on 200 as internal_error without retry", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      fakeResponse(200, "this is not json"),
    );
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(client.executeBatch(readOps(1)));
    expect(calls).toHaveLength(1);
    expect(error.code).toBeNull();
    expect(error.localCode).toBe("SERVER_ERROR");
    expect(error.retryable).toBe(false);
  });

  it("retries a malformed 503 body once by status fallback, then throws", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      fakeResponse(503, "not json"),
    );
    const client = createSqlDbClient({
      fetchImpl,
      delayImpl: async () => {},
    });
    const error = await expectClientError(client.executeBatch(readOps(1)));
    expect(calls).toHaveLength(2);
    expect(error.code).toBeNull();
    expect(error.retryable).toBe(true);
  });

  it("rejects a transaction result whose length does not match the request", async () => {
    const { fetchImpl } = recordingFetch(() =>
      fakeResponse(
        200,
        successBody({ transactionId: "tx-1", results: [{ kind: "tags.create", affected: 1 }] }),
      ),
    );
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(client.executeTransaction(writeOps(2)));
    expect(error.code).toBe("internal_error");
    expect(error.status).toBeNull();
  });

  it("rejects a transaction result whose kind order does not match", async () => {
    const { fetchImpl } = recordingFetch(() =>
      fakeResponse(
        200,
        successBody({
          transactionId: "tx-1",
          results: [{ kind: "marks.softDelete", affected: 1 }],
        }),
      ),
    );
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(
      client.executeTransaction([{ kind: "tags.create", name: "t" }]),
    );
    expect(error.code).toBe("internal_error");
  });

  it("rejects a transaction result with a negative affected count", async () => {
    const { fetchImpl } = recordingFetch(() =>
      fakeResponse(
        200,
        successBody({
          transactionId: "tx-1",
          results: [{ kind: "tags.create", affected: -1 }],
        }),
      ),
    );
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(
      client.executeTransaction([{ kind: "tags.create", name: "t" }]),
    );
    expect(error.code).toBe("internal_error");
  });

  it("passes id, version, and committed fields through on transaction entries", async () => {
    const { fetchImpl } = recordingFetch(() =>
      fakeResponse(
        200,
        successBody({
          transactionId: "tx-1",
          results: [
            { kind: "tags.create", affected: 1, id: 7, version: 3 },
            { kind: "wiki.commitRevision", affected: 0, committed: false },
          ],
        }),
      ),
    );
    const client = createSqlDbClient({ fetchImpl });
    // The client validates kind/group only; per-kind payload shape
    // is the server's authority, so the wiki op is cast here.
    const ops = asWriteOps([
      { kind: "tags.create", name: "t" },
      { kind: "wiki.commitRevision" },
    ]);
    const result = await client.executeTransaction(ops);
    expect(result.results[0]).toEqual({ kind: "tags.create", affected: 1, id: 7, version: 3 });
    expect(result.results[1]).toEqual({
      kind: "wiki.commitRevision",
      affected: 0,
      committed: false,
    });
  });

  it("rejects a batch result whose rows are not an array", async () => {
    const { fetchImpl } = recordingFetch(() =>
      fakeResponse(200, successBody({ results: [{ kind: "tags.list", rows: "nope" }] })),
    );
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(client.executeBatch([{ kind: "tags.list" }]));
    expect(error.code).toBe("internal_error");
  });

  it("rejects a batch result whose kind order does not match", async () => {
    const { fetchImpl } = recordingFetch(() =>
      fakeResponse(200, successBody({ results: [{ kind: "policy.get", rows: [] }] })),
    );
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(client.executeBatch([{ kind: "tags.list" }]));
    expect(error.code).toBe("internal_error");
  });
});

// ---------------------------------------------------------------------------
// Client-side operation validation: no HTTP on the first problem
// ---------------------------------------------------------------------------

describe("operation validation", () => {
  it("rejects an unknown kind as invalid_operation with index and kind", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(
      client.executeBatch(asReadOps([{ kind: "nope.unknown" }])),
    );
    expect(error.code).toBe("invalid_operation");
    expect(error.status).toBeNull();
    expect(error.operationIndex).toBe(0);
    expect(error.kind).toBe("nope.unknown");
    expect(calls).toHaveLength(0);
  });

  it("rejects a read kind in a transaction and a write kind in a batch", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const writeError = await expectClientError(
      client.executeTransaction(asWriteOps([{ kind: "tags.list" }])),
    );
    expect(writeError.code).toBe("invalid_operation");
    const readError = await expectClientError(
      client.executeBatch(asReadOps([{ kind: "tags.create", name: "t" }])),
    );
    expect(readError.code).toBe("invalid_operation");
    expect(calls).toHaveLength(0);
  });

  it("rejects forbidden fields (no raw SQL, no table names, no workspace id)", async () => {
    for (const field of ["sql", "query", "statement", "table", "columns", "raw", "workspaceId"]) {
      const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
      const client = createSqlDbClient({ fetchImpl });
      const error = await expectClientError(
        client.executeBatch(asReadOps([{ kind: "tags.list", [field]: "x" }])),
      );
      expect(error.code).toBe("validation_failed");
      expect(calls).toHaveLength(0);
    }
  });

  it("sends only typed operations: a normal request body carries no SQL field", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    await client.executeBatch([{ kind: "tags.list" }]);
    expect(calls[0].init?.body).not.toContain('"sql"');
    expect(calls[0].init?.body).not.toContain('"table"');
    expect(Object.keys(bodyOf(calls[0]))).toEqual(["operations"]);
  });

  it("rejects a non-object operation and a missing kind", () => {
    expect(() => validateDbClientOperations([null], "read")).toThrow(SqlDbClientError);
    expect(() => validateDbClientOperations(["tags.list"], "read")).toThrow(SqlDbClientError);
    expect(() => validateDbClientOperations([{}], "read")).toThrow(SqlDbClientError);
    expect(() => validateDbClientOperations([{ kind: "" }], "read")).toThrow(SqlDbClientError);
    try {
      validateDbClientOperations([{}], "read");
    } catch (error) {
      expect((error as SqlDbClientError).code).toBe("validation_failed");
    }
  });

  it("throws on the first problem, in index order", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(
      client.executeBatch(
        asReadOps([
          { kind: "tags.list" },
          { kind: "nope.unknown" },
          { kind: "tags.list", sql: "select 1" },
        ]),
      ),
    );
    expect(error.code).toBe("invalid_operation");
    expect(error.operationIndex).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("rejects the server-only kind locally as capability_unavailable", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(
      client.executeTransaction(
        asWriteOps([{ kind: "vector.replaceChunks", sourceId: "s", chunks: [] }]),
      ),
    );
    expect(error.code).toBe("capability_unavailable");
    expect(error.localCode).toBe("CAPABILITY_UNAVAILABLE");
    expect(error.status).toBeNull();
    expect(error.details["capability"]).toBe("vector.replaceChunks");
    expect(error.details["phase"]).toBe("Fase 2");
    expect(calls).toHaveLength(0);
  });

  it("reports the server-only kind as wrong-group invalid_operation in a batch", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(
      client.executeBatch(asReadOps([{ kind: "vector.replaceChunks" }])),
    );
    expect(error.code).toBe("invalid_operation");
    expect(calls).toHaveLength(0);
  });

  it("rejects messages.get while the catalog does not list it (AD-44 delta)", () => {
    if ((SQL_OP_KINDS as readonly string[]).includes("messages.get")) {
      // The catalog amendment landed: the kind is admitted with no
      // code change here, so there is nothing to reject.
      expect(() =>
        validateDbClientOperations([{ kind: "messages.get", id: 1 }], "read"),
      ).not.toThrow();
      return;
    }
    expect(() =>
      validateDbClientOperations([{ kind: "messages.get", id: 1 }], "read"),
    ).toThrow(SqlDbClientError);
  });

  it("admits every catalog kind in its own group, except the server-only kind", () => {
    // The client checks kind/group/exposure only; per-kind payload
    // shape is the server's authority, so bare kind objects suffice.
    for (const kind of SQL_READ_OP_KINDS) {
      expect(() => validateDbClientOperations([{ kind }], "read")).not.toThrow();
    }
    for (const kind of SQL_WRITE_OP_KINDS) {
      if (kind === "vector.replaceChunks") {
        expect(() =>
          validateDbClientOperations([{ kind }], "write"),
        ).toThrow(SqlDbClientError);
      } else {
        expect(() => validateDbClientOperations([{ kind }], "write")).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Transport details: headers, credentials, CSRF seam, chunk error remap
// ---------------------------------------------------------------------------

describe("transport details", () => {
  it("sends JSON headers, same-origin credentials, and relative paths only", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    await client.executeTransaction(writeOps(1));
    await client.executeBatch(readOps(1));
    for (const call of calls) {
      expect(call.init?.method).toBe("POST");
      expect(call.init?.headers?.["Content-Type"]).toBe("application/json");
      expect(call.init?.headers?.["Accept"]).toBe("application/json");
      expect(call.init?.credentials).toBe("same-origin");
      expect(call.url.startsWith("/api/")).toBe(true);
      expect(call.url).not.toContain("://");
    }
  });

  it("attaches the CSRF token from the provider to both endpoints", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({
      fetchImpl,
      getCsrfToken: async () => "csrf-token-1",
    });
    await client.executeTransaction(writeOps(1));
    await client.executeBatch(readOps(1));
    expect(headerOf(calls[0], "X-CSRF-Token")).toBe("csrf-token-1");
    expect(headerOf(calls[1], "X-CSRF-Token")).toBe("csrf-token-1");
  });

  it("omits the CSRF header when the provider returns no token", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl, getCsrfToken: () => null });
    await client.executeBatch(readOps(1));
    expect(headerOf(calls[0], "X-CSRF-Token")).toBeUndefined();
  });

  it("omits the CSRF header when no provider is configured", async () => {
    const { fetchImpl, calls } = recordingFetch(autoSuccessHandler());
    const client = createSqlDbClient({ fetchImpl });
    await client.executeBatch(readOps(1));
    expect(headerOf(calls[0], "X-CSRF-Token")).toBeUndefined();
  });

  it("refreshes once after csrf_invalid and retries with the fresh token", async () => {
    let token = "stale-token";
    let refreshes = 0;
    const success = autoSuccessHandler();
    let attempts = 0;
    const { fetchImpl, calls } = recordingFetch((call) => {
      attempts += 1;
      if (attempts === 1) {
        return fakeResponse(403, errorBody("csrf_invalid"));
      }
      return success(call);
    });
    const client = createSqlDbClient({
      fetchImpl,
      getCsrfToken: () => token,
      refreshCsrfToken: async () => {
        refreshes += 1;
        token = "fresh-token";
      },
      delayImpl: async () => {},
    });
    await client.executeTransaction(writeOps(1));
    expect(refreshes).toBe(1);
    expect(calls).toHaveLength(2);
    expect(headerOf(calls[0], "X-CSRF-Token")).toBe("stale-token");
    expect(headerOf(calls[1], "X-CSRF-Token")).toBe("fresh-token");
    expect(headerOf(calls[0], "Idempotency-Key")).toBe(
      headerOf(calls[1], "Idempotency-Key"),
    );
  });

  it("a second csrf_invalid after refresh throws and consumes the retry budget", async () => {
    let refreshes = 0;
    const { fetchImpl, calls } = recordingFetch(() =>
      fakeResponse(403, errorBody("csrf_invalid")),
    );
    const client = createSqlDbClient({
      fetchImpl,
      getCsrfToken: () => "stale-token",
      refreshCsrfToken: async () => {
        refreshes += 1;
      },
      delayImpl: async () => {},
    });
    const error = await expectClientError(client.executeBatch(readOps(1)));
    expect(error.code).toBe("csrf_invalid");
    expect(refreshes).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("a failed CSRF refresh surfaces the original csrf_invalid error", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      fakeResponse(403, errorBody("csrf_invalid")),
    );
    const client = createSqlDbClient({
      fetchImpl,
      getCsrfToken: () => "stale-token",
      refreshCsrfToken: async () => {
        throw new Error("refresh failed");
      },
      delayImpl: async () => {},
    });
    const error = await expectClientError(client.executeBatch(readOps(1)));
    expect(error.code).toBe("csrf_invalid");
    expect(calls).toHaveLength(1);
  });

  it("without a refresher a csrf_invalid is never retried", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      fakeResponse(403, errorBody("csrf_invalid")),
    );
    const client = createSqlDbClient({
      fetchImpl,
      getCsrfToken: () => "stale-token",
      delayImpl: async () => {},
    });
    const error = await expectClientError(client.executeBatch(readOps(1)));
    expect(error.code).toBe("csrf_invalid");
    expect(calls).toHaveLength(1);
  });

  it("remaps a later-chunk failure to the global operation index", async () => {
    let attempts = 0;
    const { fetchImpl, calls } = recordingFetch((call) => {
      attempts += 1;
      if (attempts === 1) {
        return autoSuccessHandler()(call);
      }
      return fakeResponse(
        409,
        errorBody("revision_conflict", {
          details: { operationIndex: 0, kind: "marks.softDelete" },
        }),
      );
    });
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(client.executeTransaction(writeOps(51)));
    expect(calls).toHaveLength(2);
    expect(error.operationIndex).toBe(50);
    expect(error.details["failedChunkIndex"]).toBe(1);
    expect(error.details["completedOperations"]).toBe(50);
  });

  it("passes a single-chunk failure through without chunk remap fields", async () => {
    const { fetchImpl } = recordingFetch(() =>
      fakeResponse(
        409,
        errorBody("revision_conflict", {
          details: { operationIndex: 0, kind: "tags.create" },
        }),
      ),
    );
    const client = createSqlDbClient({ fetchImpl });
    const error = await expectClientError(client.executeTransaction(writeOps(1)));
    expect(error.operationIndex).toBe(0);
    expect(error.details["failedChunkIndex"]).toBeUndefined();
    expect(error.details["completedOperations"]).toBeUndefined();
  });

  it("stops at the first failing chunk and sends no later chunks", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      fakeResponse(400, errorBody("validation_failed")),
    );
    const client = createSqlDbClient({ fetchImpl });
    await expectClientError(client.executeBatch(readOps(101)));
    expect(calls).toHaveLength(1);
  });

  it("satisfies the adapter port shape: two methods, typed results", () => {
    const client: SqlDbClient = createSqlDbClient({
      fetchImpl: recordingFetch(autoSuccessHandler()).fetchImpl,
    });
    expect(typeof client.executeTransaction).toBe("function");
    expect(typeof client.executeBatch).toBe("function");
  });
});
