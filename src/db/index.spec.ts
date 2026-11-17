// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Behavior specs for the SQL funnel (src/db/index.ts, V3-14 3E
// fold): the live surface routes through the registered SqlAdapter,
// and every legacy entry point fails loudly with a capability
// error naming the migration.
//
// Run: `pnpm vitest run --project unit src/db/index.spec.ts` from
// the repo root. The file uses vitest (the `unit` project in
// vitest.config.ts).
//
// Ordering note: `initAllDatabases` memoizes at module level, so
// the memoization tests live in the last describe block and are
// the only tests that call it. Earlier blocks exercise
// `initSqlAdapter` directly and never touch the memo.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlatformCapabilityError,
  __resetPlatformForTests,
  registerPlatformAdapter,
  type SqlAdapter,
} from "../lib/platform";
import {
  db,
  executeRecordTransaction,
  getDb,
  getSqlAdapter,
  initAllDatabases,
  initSqlAdapter,
} from "./index";

let readyOk = true;
let readyCalls = 0;
let verifyCalls = 0;
let verifyOps: Array<{ kind: string }> = [];
let verifyFails = false;
let verifyTagRows: Array<Record<string, unknown>> = [{ name: "Idea" }];

const fakeSql: SqlAdapter = {
  mode: "web",
  ready: async () => {
    readyCalls += 1;
    return { ok: readyOk, mode: "web" as const, migrationsCurrent: readyOk };
  },
  query: async () => {
    throw new Error("fake query unused");
  },
  queryOne: async () => {
    throw new Error("fake queryOne unused");
  },
  queryMany: async (ops) => {
    verifyCalls += 1;
    verifyOps = ops.map((op) => ({ kind: op.kind }));
    if (verifyFails) {
      throw new Error("fake verification failure");
    }
    return ops.map((op) => (op.kind === "tags.list" ? verifyTagRows : []));
  },
  execute: async () => {
    throw new Error("fake execute unused");
  },
  transaction: async () => {
    throw new Error("fake transaction unused");
  },
  close: async () => {},
};

beforeEach(() => {
  readyOk = true;
  readyCalls = 0;
  verifyCalls = 0;
  verifyOps = [];
  verifyFails = false;
  verifyTagRows = [{ name: "Idea" }];
  __resetPlatformForTests();
  registerPlatformAdapter("sql", fakeSql, ["web"]);
});

describe("getSqlAdapter", () => {
  it("returns the registered adapter", () => {
    expect(getSqlAdapter()).toBe(fakeSql);
  });

  it("throws the registry error when no adapter is registered", () => {
    __resetPlatformForTests();
    expect(() => getSqlAdapter()).toThrow("not registered");
  });
});

describe("legacy funnel surface", () => {
  it("getDb rejects with a capability error naming the migration", async () => {
    const error = await getDb().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PlatformCapabilityError);
    const capabilityError = error as PlatformCapabilityError;
    expect(capabilityError.code).toBe("unsupported");
    expect(capabilityError.message).toContain("getDb");
    expect(capabilityError.message).toContain("getSqlAdapter()");
  });

  it("db.execute and db.select reject with the migration error", async () => {
    const executeError = await db
      .execute("select 1")
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(executeError).toBeInstanceOf(PlatformCapabilityError);
    expect((executeError as PlatformCapabilityError).message).toContain(
      "getSqlAdapter()",
    );
    const selectError = await db
      .select("select 1")
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(selectError).toBeInstanceOf(PlatformCapabilityError);
    expect((selectError as PlatformCapabilityError).message).toContain(
      "getSqlAdapter()",
    );
  });

  it("db.close resolves false without throwing", async () => {
    await expect(db.close()).resolves.toBe(false);
  });

  it("executeRecordTransaction rejects without reading the statements", async () => {
    const error = await executeRecordTransaction([
      { sql: "select 1", values: [] },
    ]).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PlatformCapabilityError);
    expect((error as PlatformCapabilityError).code).toBe("unsupported");
    expect((error as PlatformCapabilityError).message).toContain(
      "getSqlAdapter()",
    );
  });
});

describe("initSqlAdapter", () => {
  it("resolves when the adapter reports ready", async () => {
    await expect(initSqlAdapter()).resolves.toBeUndefined();
    expect(readyCalls).toBe(1);
  });

  it("throws a capability error when the adapter reports not-ok", async () => {
    readyOk = false;
    const error = await initSqlAdapter().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PlatformCapabilityError);
    expect((error as PlatformCapabilityError).code).toBe("unavailable");
    expect((error as PlatformCapabilityError).message).toContain("readiness");
    expect(verifyCalls).toBe(0);
  });

  it("runs the 13 section 5.4 verifications as one batch of 14 cheap reads", async () => {
    await initSqlAdapter();
    expect(verifyCalls).toBe(1);
    expect(verifyOps.map((op) => op.kind)).toEqual([
      "messages.listByConversation",
      "conversations.list",
      "compactions.listByConversation",
      "imageCache.get",
      "marks.list",
      "notes.latestByTag",
      "tags.list",
      "vector.summaries",
      "memories.list",
      "policy.get",
      "canvases.list",
      "activity.list",
      "knowledge.listSources",
      "wiki.getSourceState",
    ]);
  });

  it("throws a migration-naming capability error when verification fails", async () => {
    verifyFails = true;
    const error = await initSqlAdapter().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PlatformCapabilityError);
    expect((error as PlatformCapabilityError).code).toBe("unavailable");
    expect((error as PlatformCapabilityError).message).toContain("migrations");
  });

  it("warns when the bootstrap tag Idea is absent and stays silent when present", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      verifyTagRows = [];
      await initSqlAdapter();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("Idea");
      warn.mockClear();
      verifyTagRows = [{ name: "Idea" }];
      await initSqlAdapter();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("initAllDatabases memoization", () => {
  it("retries after failure, then reuses one successful initialization", async () => {
    readyOk = false;
    await expect(initAllDatabases()).rejects.toBeInstanceOf(
      PlatformCapabilityError,
    );
    expect(readyCalls).toBe(1);

    readyOk = true;
    await expect(initAllDatabases()).resolves.toBeUndefined();
    expect(readyCalls).toBe(2);

    await expect(initAllDatabases()).resolves.toBeUndefined();
    expect(readyCalls).toBe(2);
  });
});
