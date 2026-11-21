// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for the root drop write (root-drop.ts, IMP-01): a
// file dropped on the file manager root must never overwrite an
// existing root file. The write picks the first free name with the
// DA-12-11 " (n)" suffix and uses createNew so a file appearing
// between the exists check and the write collides and advances to
// the next suffix instead of being overwritten.
//
// Run: `pnpm vitest run --project unit src/app/core/main/file/root-drop.spec.ts`

import { describe, expect, it } from "vitest";
import { writeDroppedFileToRoot } from "./root-drop";

function alreadyExistsError() {
  return Object.assign(new Error("already exists"), {
    code: "already_exists",
  });
}

function makeDeps(taken: Set<string>) {
  const writes: Array<{ path: string; createNew?: boolean }> = [];
  return {
    writes,
    deps: {
      fileName: "note.md",
      getFilePathOptions: async (relativePath: string) => ({
        path: relativePath,
      }),
      exists: async (path: string) => taken.has(path),
      writeTextFile: async (
        path: string,
        _content: string,
        options?: { createNew?: boolean },
      ) => {
        writes.push({ path, createNew: options?.createNew });
        if (options?.createNew && taken.has(path)) {
          throw alreadyExistsError();
        }
        taken.add(path);
      },
      writeFile: async (
        path: string,
        _content: Uint8Array,
        options?: { createNew?: boolean },
      ) => {
        writes.push({ path, createNew: options?.createNew });
        if (options?.createNew && taken.has(path)) {
          throw alreadyExistsError();
        }
        taken.add(path);
      },
    },
  };
}

describe("writeDroppedFileToRoot (IMP-01)", () => {
  it("writes the original name with createNew when free", async () => {
    const { deps, writes } = makeDeps(new Set());
    const name = await writeDroppedFileToRoot(deps, {
      kind: "text",
      content: "hello",
    });
    expect(name).toBe("note.md");
    expect(writes).toEqual([{ path: "note.md", createNew: true }]);
  });

  it("suffixes instead of overwriting an existing file", async () => {
    const { deps, writes } = makeDeps(new Set(["note.md"]));
    const name = await writeDroppedFileToRoot(deps, {
      kind: "text",
      content: "hello",
    });
    expect(name).toBe("note (1).md");
    expect(writes).toEqual([{ path: "note (1).md", createNew: true }]);
  });

  it("advances past multiple taken names", async () => {
    const { deps } = makeDeps(new Set(["note.md", "note (1).md"]));
    const name = await writeDroppedFileToRoot(deps, {
      kind: "text",
      content: "hello",
    });
    expect(name).toBe("note (2).md");
  });

  it("retries with the next suffix when createNew collides", async () => {
    const taken = new Set<string>();
    const { deps, writes } = makeDeps(taken);
    // Simulate the race: exists says free, but the file appears
    // before the write lands.
    let first = true;
    const racingWrite = deps.writeTextFile;
    deps.writeTextFile = async (path, content, options) => {
      if (first) {
        first = false;
        taken.add(path);
      }
      return racingWrite(path, content, options);
    };
    const name = await writeDroppedFileToRoot(deps, {
      kind: "text",
      content: "hello",
    });
    expect(name).toBe("note (1).md");
    expect(writes.map((w) => w.path)).toEqual(["note.md", "note (1).md"]);
  });

  it("uses the binary writer for binary payloads", async () => {
    const { deps, writes } = makeDeps(new Set(["note.md"]));
    deps.fileName = "image.png";
    const name = await writeDroppedFileToRoot(deps, {
      kind: "binary",
      content: new Uint8Array([1, 2, 3]),
    });
    expect(name).toBe("image.png");
    expect(writes).toEqual([{ path: "image.png", createNew: true }]);
  });

  it("propagates non-collision write errors", async () => {
    const { deps } = makeDeps(new Set());
    deps.writeTextFile = async () => {
      throw new Error("disk full");
    };
    await expect(
      writeDroppedFileToRoot(deps, { kind: "text", content: "hello" }),
    ).rejects.toThrow("disk full");
  });
});
