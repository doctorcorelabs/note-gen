// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for DA-4 (WIKI-18-02): a wiki write-kind stub
// rejection (UNAVAILABLE) must not fail a settings update whose
// local save already succeeded, and must not suppress the change
// events; every other error still rejects. Store, context, and
// db/wiki are mocked; no test touches a database or the network.
//
// Run: `pnpm vitest run --project unit src/lib/wiki/settings.spec.ts`

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storeGet: vi.fn(),
  storeSet: vi.fn(),
  storeSave: vi.fn(),
  setWikiMeta: vi.fn(),
  emitWikiUpdated: vi.fn(),
  notifyWikiChanged: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({
  platform: {
    store: {
      load: vi.fn(async () => ({
        get: mocks.storeGet,
        set: mocks.storeSet,
        save: mocks.storeSave,
      })),
    },
  },
}));

vi.mock("./context", () => ({
  assertWikiContextCurrent: vi.fn(async () => undefined),
  captureWikiWorkspaceGuard: vi.fn(() => () => true),
  getWikiContext: vi.fn(async () => ({ id: "ctx-1" })),
  getWikiDeviceId: vi.fn(async () => "device-1"),
}));

vi.mock("@/db/wiki", () => ({
  emitWikiUpdated: mocks.emitWikiUpdated,
  setWikiMeta: mocks.setWikiMeta,
}));

vi.mock("@/stores/wiki-activity", () => ({
  endWikiActivity: vi.fn(),
  useWikiActivityStore: { getState: () => ({ active: null }) },
}));

vi.mock("./sync", () => ({
  notifyWikiChanged: mocks.notifyWikiChanged,
}));

import { updateWikiSettings } from "./settings";

describe("wiki settings update (WIKI-18-02)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.storeGet.mockImplementation(async (key: string) =>
      key === "wikiSettingsByContext" ? {} : undefined);
    mocks.storeSet.mockResolvedValue(undefined);
    mocks.storeSave.mockResolvedValue(undefined);
    mocks.setWikiMeta.mockResolvedValue(undefined);
  });

  it("resolves and still emits when the dirty-flag write is UNAVAILABLE", async () => {
    mocks.setWikiMeta.mockRejectedValue(
      Object.assign(new Error("capability_unavailable"), { code: "UNAVAILABLE" }));
    await expect(updateWikiSettings({ modelId: "model-x" })).resolves.toBeUndefined();
    expect(mocks.storeSave).toHaveBeenCalled();
    expect(mocks.emitWikiUpdated).toHaveBeenCalled();
  });

  it("still rejects on any other dirty-flag error and does not emit", async () => {
    mocks.setWikiMeta.mockRejectedValue(new Error("boom"));
    await expect(updateWikiSettings({ modelId: "model-x" })).rejects.toThrow("boom");
    expect(mocks.emitWikiUpdated).not.toHaveBeenCalled();
  });

  it("sends the dirty flag and emits on the success path", async () => {
    await expect(updateWikiSettings({ modelId: "model-x" })).resolves.toBeUndefined();
    expect(mocks.setWikiMeta).toHaveBeenCalledWith("ctx-1", "dirty", true);
    expect(mocks.emitWikiUpdated).toHaveBeenCalled();
  });
});
