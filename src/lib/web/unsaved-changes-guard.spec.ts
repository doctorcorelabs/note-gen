// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for src/lib/web/unsaved-changes-guard.ts (G28, S-P0-18).
//
// Runner: Vitest, unit project (vitest run --project unit). The suite
// exercises only the probe/flush registry and its failure semantics;
// no test touches the DOM, navigation, or any storage API, and the
// unload installer is only proven to be a safe no-op without a
// window (the Vitest node environment has none).

import { describe, expect, it } from "vitest";

import {
  flushUnsavedChanges,
  hasUnsavedChanges,
  installUnsavedChangesUnloadGuard,
  registerUnsavedChangesFlush,
  registerUnsavedChangesProbe,
} from "./unsaved-changes-guard";

describe("hasUnsavedChanges", () => {
  it("reports clean when no probe is registered", () => {
    expect(hasUnsavedChanges()).toBe(false);
  });

  it("reports dirty when any probe reports dirty", () => {
    const unregisterClean = registerUnsavedChangesProbe(
      "spec-clean",
      () => false,
    );
    const unregisterDirty = registerUnsavedChangesProbe(
      "spec-dirty",
      () => true,
    );
    try {
      expect(hasUnsavedChanges()).toBe(true);
    } finally {
      unregisterClean();
      unregisterDirty();
    }
    expect(hasUnsavedChanges()).toBe(false);
  });

  it("fails closed when a probe throws", () => {
    const unregister = registerUnsavedChangesProbe("spec-throwing", () => {
      throw new Error("probe boom");
    });
    try {
      expect(hasUnsavedChanges()).toBe(true);
    } finally {
      unregister();
    }
  });

  it("re-registering an id replaces the previous probe", () => {
    const unregisterFirst = registerUnsavedChangesProbe(
      "spec-replaced",
      () => true,
    );
    const unregisterSecond = registerUnsavedChangesProbe(
      "spec-replaced",
      () => false,
    );
    try {
      expect(hasUnsavedChanges()).toBe(false);
      // The stale unregister must not remove the replacement.
      unregisterFirst();
      expect(hasUnsavedChanges()).toBe(false);
    } finally {
      unregisterSecond();
    }
  });
});

describe("flushUnsavedChanges", () => {
  it("succeeds with no flusher registered", async () => {
    await expect(flushUnsavedChanges()).resolves.toBe(true);
  });

  it("runs flushers in registration order and awaits each one", async () => {
    const order: string[] = [];
    const unregisterFirst = registerUnsavedChangesFlush("spec-first", async () => {
      order.push("first");
    });
    const unregisterSecond = registerUnsavedChangesFlush("spec-second", () => {
      order.push("second");
    });
    try {
      await expect(flushUnsavedChanges()).resolves.toBe(true);
      expect(order).toEqual(["first", "second"]);
    } finally {
      unregisterFirst();
      unregisterSecond();
    }
  });

  it("still runs later flushers when an earlier one fails, and reports failure", async () => {
    const order: string[] = [];
    const unregisterFailing = registerUnsavedChangesFlush("spec-failing", () => {
      order.push("failing");
      throw new Error("flush boom");
    });
    const unregisterLater = registerUnsavedChangesFlush("spec-later", () => {
      order.push("later");
    });
    try {
      await expect(flushUnsavedChanges()).resolves.toBe(false);
      expect(order).toEqual(["failing", "later"]);
    } finally {
      unregisterFailing();
      unregisterLater();
    }
  });
});

describe("installUnsavedChangesUnloadGuard", () => {
  it("is a safe no-op without a window", () => {
    expect(typeof window).toBe("undefined");
    const uninstall = installUnsavedChangesUnloadGuard();
    expect(typeof uninstall).toBe("function");
    expect(() => uninstall()).not.toThrow();
  });
});
