// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for loadActivityCalendarData (BUG-08): a failed
// load must reject so the UI can render an error state; it must
// never resolve to zeroed data that looks like "no activity".
//
// Run: `pnpm vitest run --project unit src/lib/activity/index.spec.ts`

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAllActivityEvents: vi.fn(),
}));

vi.mock("@/db/activity", () => ({
  getAllActivityEvents: mocks.getAllActivityEvents,
}));

import { loadActivityCalendarData } from "./index";

describe("loadActivityCalendarData (BUG-08)", () => {
  it("rejects when the event load fails", async () => {
    mocks.getAllActivityEvents.mockRejectedValue(new Error("server down"));
    await expect(loadActivityCalendarData()).rejects.toThrow("server down");
  });

  it("resolves with zeroed totals for a genuinely empty history", async () => {
    mocks.getAllActivityEvents.mockResolvedValue([]);
    const data = await loadActivityCalendarData();
    expect(data.totals.totalCount).toBe(0);
    expect(Array.isArray(data.days)).toBe(true);
  });
});
