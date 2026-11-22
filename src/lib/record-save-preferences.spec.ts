// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Vitest-style suite for resolveRecordSaveTargetId
// (record-save-preferences.ts), including the F02-02 zero-tag
// rule: a workspace with no tags resolves to null, never to the
// stale currentTagId. Runs in the Vitest leg of `pnpm test:unit`.

import { describe, expect, it } from "vitest";

import { resolveRecordSaveTargetId } from "./record-save-preferences";

describe("resolveRecordSaveTargetId", () => {
  it("returns null when the workspace has no tags, for every mode", () => {
    for (const mode of ["current", "last", "fixed"] as const) {
      expect(
        resolveRecordSaveTargetId({
          mode,
          currentTagId: 7,
          lastTagId: 7,
          fixedTagId: 7,
          availableTagIds: [],
        }),
      ).toBeNull();
    }
  });

  it("keeps the current tag when it is still available", () => {
    expect(
      resolveRecordSaveTargetId({
        mode: "current",
        currentTagId: 3,
        lastTagId: null,
        fixedTagId: null,
        availableTagIds: [1, 3, 5],
      }),
    ).toBe(3);
  });

  it("falls back to the first available tag when current is gone", () => {
    expect(
      resolveRecordSaveTargetId({
        mode: "current",
        currentTagId: 99,
        lastTagId: null,
        fixedTagId: null,
        availableTagIds: [2, 4],
      }),
    ).toBe(2);
  });

  it("prefers the last tag in last mode when it is available", () => {
    expect(
      resolveRecordSaveTargetId({
        mode: "last",
        currentTagId: 1,
        lastTagId: 4,
        fixedTagId: null,
        availableTagIds: [1, 4],
      }),
    ).toBe(4);
  });

  it("falls back in last mode when the last tag is gone", () => {
    expect(
      resolveRecordSaveTargetId({
        mode: "last",
        currentTagId: 1,
        lastTagId: 99,
        fixedTagId: null,
        availableTagIds: [1, 4],
      }),
    ).toBe(1);
  });

  it("prefers the fixed tag in fixed mode when it is available", () => {
    expect(
      resolveRecordSaveTargetId({
        mode: "fixed",
        currentTagId: 1,
        lastTagId: null,
        fixedTagId: 4,
        availableTagIds: [1, 4],
      }),
    ).toBe(4);
  });

  it("falls back in fixed mode when the fixed tag is gone", () => {
    expect(
      resolveRecordSaveTargetId({
        mode: "fixed",
        currentTagId: 99,
        lastTagId: null,
        fixedTagId: 98,
        availableTagIds: [2, 4],
      }),
    ).toBe(2);
  });
});
