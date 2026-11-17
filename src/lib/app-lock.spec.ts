// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// F122-Q4 (W4-F122Q): runtime verification of the saveAppLock rollback
// migration from F1-22, at the StoreHandle level.
//
// The migration (guard `previous === undefined` then delete(), else
// set(previous)) can only run end to end on the desktop plugin path:
// the web adapter rejects app-lock.json fail-closed, and no Tauri
// harness exists in this VM or on muse-2 (AD-106 step 2 postponed).
// What this suite proves, without a desktop harness, is the portable
// part: the rollback control flow against a fake handle that enforces
// the H3 rule (set(key, undefined) throws invalid_argument). If the
// rollback ever regressed to set(key, undefined), the fake would throw
// the H3 error and mask the original save failure; these tests assert
// the original error survives and absence is restored with delete().
//
// The desktop plugin runtime itself remains unverified; see the slot
// report. The password path (PBKDF2 derive, 600k iterations) is not
// exercised: derivation happens before any write, so rollback behavior
// is password-independent, and all cases use password null.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityError } from "./platform/errors";

const harness = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  saveError: null as Error | null,
  saveCalls: 0,
  deleteCalls: [] as string[],
  setCalls: [] as Array<[string, unknown]>,
}));

function makeH3Handle() {
  return {
    path: "app-lock.json",
    get: async <T>(key: string): Promise<T | undefined> => {
      return harness.data.get(key) as T | undefined;
    },
    set: async (key: string, value: unknown): Promise<void> => {
      harness.setCalls.push([key, value]);
      if (value === undefined) {
        throw capabilityError(
          "invalid_argument",
          "store",
          "store.set",
          "web",
          `set() does not accept undefined for key "${key}"`,
        );
      }
      harness.data.set(key, value);
    },
    delete: async (key: string): Promise<boolean> => {
      harness.deleteCalls.push(key);
      return harness.data.delete(key);
    },
    save: async (): Promise<void> => {
      harness.saveCalls += 1;
      if (harness.saveError !== null) {
        throw harness.saveError;
      }
    },
    reload: async (): Promise<void> => {},
  };
}

vi.mock("@/lib/platform", () => ({
  BaseDirectory: { AppData: "AppData" },
  platform: {
    store: {
      load: async () => makeH3Handle(),
    },
    fs: {
      exists: async () => false,
    },
  },
}));

// Imported after vi.mock so app-lock binds the mocked platform.
import {
  readAppLock,
  saveAppLock,
  setAppLockRemembered,
} from "./app-lock";

const VALID_CREDENTIAL = {
  version: 1 as const,
  salt: "a".repeat(32),
  hash: "b".repeat(64),
};

describe("app-lock rollback under H3 (F122-Q4)", () => {
  beforeEach(() => {
    harness.data.clear();
    harness.saveError = null;
    harness.saveCalls = 0;
    harness.deleteCalls = [];
    harness.setCalls = [];
  });

  it("saveAppLock(null) stores a null credential on success", async () => {
    await saveAppLock(null);
    expect(harness.saveCalls).toBe(1);
    expect(harness.data.get("credential")).toBeNull();
    expect(harness.data.get("rememberUntil")).toBeNull();
    expect(harness.deleteCalls).toEqual([]);
    await expect(readAppLock()).resolves.toBeNull();
  });

  it("a failed save with absent previous keys restores absence with delete() and keeps the original error", async () => {
    harness.saveError = new Error("save failed");
    await expect(saveAppLock(null)).rejects.toThrow("save failed");
    expect(harness.data.has("credential")).toBe(false);
    expect(harness.data.has("rememberUntil")).toBe(false);
    expect(harness.deleteCalls).toEqual(["credential", "rememberUntil"]);
    expect(
      harness.setCalls.some(([, value]) => value === undefined),
    ).toBe(false);
  });

  it("a failed save with present previous keys restores them with set()", async () => {
    harness.data.set("credential", VALID_CREDENTIAL);
    harness.data.set("rememberUntil", 12345);
    harness.saveError = new Error("save failed");
    await expect(saveAppLock(null)).rejects.toThrow("save failed");
    expect(harness.data.get("credential")).toEqual(VALID_CREDENTIAL);
    expect(harness.data.get("rememberUntil")).toBe(12345);
    expect(harness.deleteCalls).toEqual([]);
    await expect(readAppLock()).resolves.toEqual(VALID_CREDENTIAL);
  });

  it("setAppLockRemembered restores null on a failed save without touching undefined", async () => {
    harness.saveError = new Error("save failed");
    await expect(setAppLockRemembered(true)).rejects.toThrow("save failed");
    expect(harness.data.get("rememberUntil")).toBeNull();
    expect(
      harness.setCalls.some(([, value]) => value === undefined),
    ).toBe(false);
  });

  it("readAppLock rejects a malformed stored credential", async () => {
    harness.data.set("credential", { version: 1, salt: "zz", hash: "zz" });
    await expect(readAppLock()).rejects.toThrow(
      "Invalid app lock configuration",
    );
  });
});
