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

import { rewriteFolderScopes, updateWikiSettings } from "./settings";
import type { WikiScope } from "@/types/wiki";

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


describe("rewriteFolderScopes (F-07)", () => {
  const scope = (kind: WikiScope["kind"], id: string): WikiScope => ({
    key: `${kind}:${id}`,
    kind,
    id,
    label: id,
    enabled: true,
    effect: "include",
    clock: { "device-1": 3 },
  });

  it("rewrites the exact folder scope and descendant article scopes", () => {
    const scopes = [
      scope("article-folder", "docs"),
      scope("article", "docs/note.md"),
      scope("article-folder", "docs/sub"),
    ];

    const next = rewriteFolderScopes(scopes, "docs", "guides", "device-1");

    expect(next.map((item) => item.id)).toEqual([
      "guides",
      "guides/note.md",
      "guides/sub",
    ]);
    expect(next.map((item) => item.key)).toEqual([
      "article-folder:guides",
      "article:guides/note.md",
      "article-folder:guides/sub",
    ]);
    expect(next.map((item) => item.label)).toEqual([
      "guides",
      "guides/note.md",
      "guides/sub",
    ]);
    expect(next[0].clock["device-1"]).toBe(4);
    expect(next[0].effect).toBe("include");
  });

  it("does not touch sibling prefixes or non-path scopes", () => {
    const scopes = [
      scope("article-folder", "docs2"),
      scope("article", "docs2/note.md"),
      scope("record-tag", "docs"),
    ];

    const next = rewriteFolderScopes(scopes, "docs", "guides", "device-1");

    expect(next).toBe(scopes);
  });

  it("is a no-op for empty or unchanged paths", () => {
    const scopes = [scope("article-folder", "docs")];
    expect(rewriteFolderScopes(scopes, "docs", "docs", "device-1")).toBe(scopes);
    expect(rewriteFolderScopes(scopes, "", "guides", "device-1")).toBe(scopes);
  });
});
