// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Behavior specs for moveEntriesToSystemTrash in web mode
// (UTANG-UJI-10): the web branch must send workspace-relative
// paths (the server rejects the virtual absolute paths per item
// as path_escapes_workspace) and must treat any rejected item as
// a failure instead of reporting a silent success. The Tauri
// branch keeps sending absolute paths to the OS trash command.
//
// Run: `pnpm vitest run --project unit src/app/core/main/file/system-trash.spec.ts`
// from the repo root.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  exists: vi.fn(async () => true),
  remove: vi.fn(async () => undefined),
  checkIsTauri: vi.fn(() => false),
  isMobileDevice: vi.fn(() => false),
  deleteSelfHostedWorkspacePath: vi.fn(async () => false),
}));

vi.mock("@/lib/platform", () => ({
  platform: {
    invoke: { invoke: mocks.invoke },
    fs: { exists: mocks.exists, remove: mocks.remove },
    path: { join: async (a: string, b: string) => `${a}/${b}` },
  },
}));

vi.mock("@/lib/workspace", () => ({
  getFilePathOptions: async (relativePath: string) => ({
    path: `article/${relativePath}`,
    baseDir: "AppData",
  }),
  getDefaultArticleAbsolutePath: async (relativePath: string) =>
    `/appdata/article/${relativePath}`,
}));

vi.mock("@/lib/self-hosted-sync/files", () => ({
  deleteSelfHostedWorkspacePath: mocks.deleteSelfHostedWorkspacePath,
}));

vi.mock("@/lib/check", () => ({
  checkIsTauri: mocks.checkIsTauri,
  isMobileDevice: mocks.isMobileDevice,
}));

import {
  moveEntriesToSystemTrash,
  moveEntryToSystemTrash,
} from "./system-trash";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exists.mockResolvedValue(true);
  mocks.checkIsTauri.mockReturnValue(false);
  mocks.isMobileDevice.mockReturnValue(false);
  mocks.deleteSelfHostedWorkspacePath.mockResolvedValue(false);
});

describe("moveEntriesToSystemTrash (web)", () => {
  it("sends workspace-relative paths, not virtual absolute paths", async () => {
    mocks.invoke.mockResolvedValue({
      moved: ["Folder/Catatan.md"],
      notFound: [],
      rejected: [],
    });

    const count = await moveEntriesToSystemTrash(["Folder/Catatan.md"]);

    expect(count).toBe(1);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("move_paths_to_trash", {
      paths: ["Folder/Catatan.md"],
    });
  });

  it("counts notFound as done (the entry is already gone)", async () => {
    mocks.invoke.mockResolvedValue({
      moved: [],
      notFound: ["gone.md"],
      rejected: [],
    });

    await expect(moveEntryToSystemTrash("gone.md")).resolves.toBe(true);
  });

  it("throws when the server rejects any item", async () => {
    mocks.invoke.mockResolvedValue({
      moved: ["ok.md"],
      notFound: [],
      rejected: [{ path: "bad.md", reason: "path_escapes_workspace" }],
    });

    await expect(
      moveEntriesToSystemTrash(["ok.md", "bad.md"]),
    ).rejects.toThrow("Failed to move 1 item(s) to trash.");
  });

  it("propagates invoke failures (no silent success)", async () => {
    mocks.invoke.mockRejectedValue(new Error("501"));

    await expect(moveEntriesToSystemTrash(["a.md"])).rejects.toThrow("501");
  });
});

describe("moveEntriesToSystemTrash (tauri)", () => {
  it("keeps sending absolute paths to the OS trash command", async () => {
    mocks.checkIsTauri.mockReturnValue(true);
    mocks.invoke.mockResolvedValue(undefined);

    const count = await moveEntriesToSystemTrash(["a.md"]);

    expect(count).toBe(1);
    expect(mocks.invoke).toHaveBeenCalledWith("move_paths_to_trash", {
      paths: ["/appdata/article/a.md"],
    });
  });
});
