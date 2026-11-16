// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for the revision-guard conflict flow (V1-09 section 3.9,
// AD-17). Runner: Vitest, unit project (vitest run --project unit).
// Every case runs against an in-memory fake filesystem adapter that
// honors the same guard semantics the web adapter sends: expected
// revision as If-Match, create-new as If-None-Match, force as
// If-Match star. No test touches the DOM, the network, or the store.

import { describe, expect, it } from "vitest";

import type {
  FileInfo,
  FsTextFileResult,
  WriteFileOptions,
} from "@/lib/platform";
import type { FsConflictPayload } from "@/lib/platform/fs/errors";

import {
  applyRevisionConflictChoice,
  DEFAULT_REVISION_CONFLICT_CHOICE,
  deriveCopyPath,
  extractConflictPayload,
  isAlreadyExistsLike,
  isRevisionConflictLike,
  nextCopyPath,
  toRevisionConflictInfo,
  type RevisionConflictFs,
  type RevisionConflictPathOptions,
} from "./revision-conflict";

function fileInfo(revision: string | null, size: number): FileInfo {
  return {
    isFile: true,
    isDirectory: false,
    isSymlink: false,
    size,
    mtime: null,
    atime: null,
    birthtime: null,
    readonly: false,
    fileAttributes: null,
    dev: null,
    ino: null,
    mode: null,
    nlink: null,
    uid: null,
    gid: null,
    rdev: null,
    blksize: null,
    blocks: null,
    revision,
    version: 1,
  };
}

interface FakeFile {
  content: string;
  revision: string;
  version: number;
}

class FakeFs implements RevisionConflictFs {
  readonly files = new Map<string, FakeFile>();
  readonly writes: Array<{ path: string; options?: WriteFileOptions }> = [];
  failWritesWith: unknown = null;
  private counter = 0;

  constructor(entries: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(entries)) {
      this.files.set(path, {
        content,
        revision: this.nextRevision(),
        version: 1,
      });
    }
  }

  private nextRevision(): string {
    this.counter += 1;
    return `sha256:rev-${this.counter}`;
  }

  private conflictPayload(path: string, current: FakeFile): FsConflictPayload {
    return {
      path,
      serverRevision: current.revision,
      serverVersion: current.version,
      serverModifiedAt: "2026-11-16T10:00:00.000Z",
      serverSize: current.content.length,
      currentPreview: current.content.slice(0, 200),
      previewTruncated: current.content.length > 200,
      suggestedCopyPath: deriveCopyPath(path, null),
      actions: ["reload", "save-copy", "force-overwrite"],
    };
  }

  async readTextFileDetailed(
    path: string | URL,
  ): Promise<FsTextFileResult> {
    const key = String(path);
    const current = this.files.get(key);
    if (!current) {
      throw {
        code: "not_found",
        status: 404,
        message: `File not found: ${key}`,
      };
    }
    return {
      content: current.content,
      revision: current.revision,
      version: current.version,
      size: current.content.length,
      modifiedAt: "2026-11-16T10:00:00.000Z",
    };
  }

  async writeTextFile(
    path: string | URL,
    data: string,
    options?: WriteFileOptions,
  ): Promise<void> {
    const key = String(path);
    this.writes.push({ path: key, options });
    if (this.failWritesWith !== null) {
      throw this.failWritesWith;
    }
    const current = this.files.get(key);
    if (options?.force === true) {
      this.files.set(key, {
        content: data,
        revision: this.nextRevision(),
        version: (current?.version ?? 0) + 1,
      });
      return;
    }
    if (options?.createNew === true && current) {
      throw {
        code: "already_exists",
        status: 409,
        message: `File already exists: ${key}`,
      };
    }
    if (
      options?.expectedRevision !== undefined &&
      current &&
      current.revision !== options.expectedRevision
    ) {
      throw {
        code: "revision_conflict",
        status: 412,
        message: `Revision conflict: ${key}`,
        conflict: this.conflictPayload(key, current),
      };
    }
    this.files.set(key, {
      content: data,
      revision: this.nextRevision(),
      version: (current?.version ?? 0) + 1,
    });
  }

  async stat(path: string | URL): Promise<FileInfo> {
    const current = this.files.get(String(path));
    if (!current) {
      throw {
        code: "not_found",
        status: 404,
        message: `File not found: ${String(path)}`,
      };
    }
    return fileInfo(current.revision, current.content.length);
  }
}

function pathOptions(path: string): RevisionConflictPathOptions {
  return { path };
}

const SERVER_CONTENT = "# Server version\n\nEdited elsewhere.\n";
const LOCAL_CONTENT = "# Local version\n\nEdited in this tab.\n";

describe("isRevisionConflictLike", () => {
  it("accepts the 412 guard code and the raw 409 body code", () => {
    expect(isRevisionConflictLike({ code: "revision_conflict" })).toBe(true);
    expect(isRevisionConflictLike({ code: "version_conflict" })).toBe(true);
  });

  it("rejects other codes and non-objects", () => {
    expect(isRevisionConflictLike({ code: "not_found" })).toBe(false);
    expect(isRevisionConflictLike({ code: "already_exists" })).toBe(false);
    expect(isRevisionConflictLike(new Error("boom"))).toBe(false);
    expect(isRevisionConflictLike(null)).toBe(false);
    expect(isRevisionConflictLike("revision_conflict")).toBe(false);
  });
});

describe("isAlreadyExistsLike", () => {
  it("accepts only the create-new collision code", () => {
    expect(isAlreadyExistsLike({ code: "already_exists" })).toBe(true);
    expect(isAlreadyExistsLike({ code: "revision_conflict" })).toBe(false);
    expect(isAlreadyExistsLike(new Error("boom"))).toBe(false);
    expect(isAlreadyExistsLike(null)).toBe(false);
  });
});

describe("extractConflictPayload", () => {
  it("passes a full payload through", () => {
    const payload: FsConflictPayload = {
      path: "notes/a.md",
      serverRevision: "sha256:abc",
      serverVersion: 3,
      serverModifiedAt: "2026-11-16T10:00:00.000Z",
      serverSize: 42,
      currentPreview: "hello",
      previewTruncated: false,
      suggestedCopyPath: "notes/a (copy).md",
      actions: ["reload"],
    };
    expect(extractConflictPayload({ code: "revision_conflict", conflict: payload })).toEqual(
      payload,
    );
  });

  it("returns null when no payload is carried", () => {
    expect(extractConflictPayload({ code: "revision_conflict" })).toBeNull();
    expect(extractConflictPayload(null)).toBeNull();
  });

  it("fills defaults for a partial payload", () => {
    const payload = extractConflictPayload({
      conflict: { serverRevision: "sha256:abc" },
    });
    expect(payload).not.toBeNull();
    expect(payload?.serverRevision).toBe("sha256:abc");
    expect(payload?.serverVersion).toBeNull();
    expect(payload?.serverSize).toBe(0);
    expect(payload?.currentPreview).toBeNull();
    expect(payload?.actions).toEqual([]);
  });
});

describe("toRevisionConflictInfo", () => {
  it("tolerates a missing payload", () => {
    const info = toRevisionConflictInfo("notes/a.md", LOCAL_CONTENT, null);
    expect(info.path).toBe("notes/a.md");
    expect(info.localContent).toBe(LOCAL_CONTENT);
    expect(info.serverRevision).toBe("");
    expect(info.serverVersion).toBeNull();
    expect(info.suggestedCopyPath).toBeNull();
  });
});

describe("deriveCopyPath and nextCopyPath", () => {
  it("prefers the server suggestion when it names a different path", () => {
    expect(deriveCopyPath("notes/a.md", "notes/a (copy).md")).toBe(
      "notes/a (copy).md",
    );
  });

  it("ignores a suggestion that equals the original path", () => {
    expect(deriveCopyPath("notes/a.md", "notes/a.md")).toBe(
      "notes/a (copy).md",
    );
  });

  it("inserts the copy suffix before the extension", () => {
    expect(deriveCopyPath("notes/a.md", null)).toBe("notes/a (copy).md");
    expect(deriveCopyPath("a.md", undefined)).toBe("a (copy).md");
    expect(deriveCopyPath("notes/noext", null)).toBe("notes/noext (copy)");
    expect(deriveCopyPath("notes/.hidden", null)).toBe("notes/.hidden (copy)");
  });

  it("increments the copy counter", () => {
    expect(nextCopyPath("notes/a (copy).md")).toBe("notes/a (copy 2).md");
    expect(nextCopyPath("notes/a (copy 2).md")).toBe("notes/a (copy 3).md");
    expect(nextCopyPath("notes/a (copy 12).md")).toBe("notes/a (copy 13).md");
    expect(nextCopyPath("notes/a.md")).toBe("notes/a (copy).md");
  });
});

describe("default choice", () => {
  it("is reload, never force-overwrite", () => {
    expect(DEFAULT_REVISION_CONFLICT_CHOICE).toBe("reload");
    expect(DEFAULT_REVISION_CONFLICT_CHOICE).not.toBe("force-overwrite");
  });
});

describe("applyRevisionConflictChoice", () => {
  it("reload returns the server content and writes nothing", async () => {
    const fs = new FakeFs({ "notes/a.md": SERVER_CONTENT });
    const before = fs.files.get("notes/a.md");

    const result = await applyRevisionConflictChoice(fs, {
      choice: "reload",
      sourceOptions: pathOptions("notes/a.md"),
      localContent: LOCAL_CONTENT,
    });

    expect(result).toEqual({
      choice: "reload",
      status: "reloaded",
      content: SERVER_CONTENT,
      revision: before?.revision ?? null,
    });
    expect(fs.writes).toEqual([]);
    expect(fs.files.get("notes/a.md")).toEqual(before);
  });

  it("save-copy writes only the copy with create-new semantics", async () => {
    const fs = new FakeFs({ "notes/a.md": SERVER_CONTENT });
    const serverBefore = fs.files.get("notes/a.md");

    const result = await applyRevisionConflictChoice(fs, {
      choice: "save-copy",
      sourceOptions: pathOptions("notes/a.md"),
      copyOptions: pathOptions("notes/a (copy).md"),
      copyPath: "notes/a (copy).md",
      localContent: LOCAL_CONTENT,
    });

    expect(result.status).toBe("copied");
    if (result.status !== "copied") return;
    expect(result.copyPath).toBe("notes/a (copy).md");
    expect(result.content).toBe(SERVER_CONTENT);
    expect(result.revision).toBe(serverBefore?.revision ?? null);
    expect(fs.files.get("notes/a (copy).md")?.content).toBe(LOCAL_CONTENT);
    expect(fs.files.get("notes/a.md")).toEqual(serverBefore);
    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0].options?.createNew).toBe(true);
    expect(fs.writes[0].options?.force).not.toBe(true);
  });

  it("save-copy never overwrites a taken copy name", async () => {
    const fs = new FakeFs({
      "notes/a.md": SERVER_CONTENT,
      "notes/a (copy).md": "existing copy",
    });
    const copyBefore = fs.files.get("notes/a (copy).md");

    const result = await applyRevisionConflictChoice(fs, {
      choice: "save-copy",
      sourceOptions: pathOptions("notes/a.md"),
      copyOptions: pathOptions("notes/a (copy).md"),
      copyPath: "notes/a (copy).md",
      localContent: LOCAL_CONTENT,
    });

    expect(result).toEqual({
      choice: "save-copy",
      status: "copy-exists",
      copyPath: "notes/a (copy).md",
      suggestedCopyPath: "notes/a (copy 2).md",
    });
    expect(fs.files.get("notes/a (copy).md")).toEqual(copyBefore);
    expect(fs.files.get("notes/a.md")?.content).toBe(SERVER_CONTENT);
  });

  it("save-copy requires a copy path", async () => {
    const fs = new FakeFs({ "notes/a.md": SERVER_CONTENT });
    await expect(
      applyRevisionConflictChoice(fs, {
        choice: "save-copy",
        sourceOptions: pathOptions("notes/a.md"),
        localContent: LOCAL_CONTENT,
      }),
    ).rejects.toThrow("Save-copy choice requires a copy path");
    expect(fs.writes).toEqual([]);
  });

  it("force-overwrite is the only choice that sends force", async () => {
    const fs = new FakeFs({ "notes/a.md": SERVER_CONTENT });
    const before = fs.files.get("notes/a.md");

    const result = await applyRevisionConflictChoice(fs, {
      choice: "force-overwrite",
      sourceOptions: pathOptions("notes/a.md"),
      localContent: LOCAL_CONTENT,
    });

    expect(result.status).toBe("overwritten");
    if (result.status !== "overwritten") return;
    expect(result.revision).not.toBe(before?.revision ?? null);
    expect(result.revision).toBe(fs.files.get("notes/a.md")?.revision ?? null);
    expect(fs.files.get("notes/a.md")?.content).toBe(LOCAL_CONTENT);
    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0].options?.force).toBe(true);
  });

  it("reload propagates a read failure without writing", async () => {
    const fs = new FakeFs({});
    await expect(
      applyRevisionConflictChoice(fs, {
        choice: "reload",
        sourceOptions: pathOptions("notes/gone.md"),
        localContent: LOCAL_CONTENT,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(fs.writes).toEqual([]);
  });

  it("force-overwrite propagates adapter errors", async () => {
    const fs = new FakeFs({ "notes/a.md": SERVER_CONTENT });
    fs.failWritesWith = {
      code: "network_error",
      status: 503,
      message: "offline",
    };
    await expect(
      applyRevisionConflictChoice(fs, {
        choice: "force-overwrite",
        sourceOptions: pathOptions("notes/a.md"),
        localContent: LOCAL_CONTENT,
      }),
    ).rejects.toMatchObject({ code: "network_error" });
    expect(fs.files.get("notes/a.md")?.content).toBe(SERVER_CONTENT);
  });
});
