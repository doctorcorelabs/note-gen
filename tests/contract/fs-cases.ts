// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Filesystem contract cases (parameterized over implementations).
//
// Case IDs: C-FS-01 to C-FS-11, fase1/desain-pengujian.md section 2.2,
// reconciled by AD-17 (rename rewrites Markdown links and image
// references by default) and AD-09 (events carry a monotonic seq).
//
// Two design points are only partly testable through the scaffold
// mirror interface and are recorded in tests/contract/README.md:
// - C-FS-03 names four observation paths (watcher, tree, scanner,
//   import). The mirror has no dedicated import operation, so the
//   import path is exercised as write-then-observe through the scanner
//   and the tree.
// - C-FS-06 names a resolve-then-toMarkdownImagePath round-trip. The
//   mirror has no toMarkdownImagePath operation (that round-trip is
//   covered by unit test U-IMG-05 over the pure function); the contract
//   case asserts resolution through the adapter only.
// Symlink traversal (C-FS-09) has no fake equivalent and is recorded as
// deferred for the web implementation.
//
// C-FS-10 uses factory.writeExternally(), which writes a file without
// going through the adapter under test (an outside process). The fake
// factory implements it with simulateExternalWrite; the web factory
// must implement it with a direct write that bypasses the adapter.

import { expect, it } from "vitest";
import { ContractError, isContractError } from "./contract-errors";
import type { ContractFactory } from "./contract-harness";
import { WATCHER_MAX_LATENCY_MS } from "./contract-types";
import type { FsAdapter, FsEvent } from "./contract-types";

export interface FsContractFactory extends ContractFactory<FsAdapter> {
  writeExternally: (
    impl: FsAdapter,
    path: string,
    content: string,
  ) => Promise<void>;
}

function requireWriteExternally(
  factory: ContractFactory<FsAdapter>,
): FsContractFactory["writeExternally"] {
  const fn = (factory as FsContractFactory).writeExternally;
  if (typeof fn !== "function") {
    throw new Error(
      "Filesystem contract factory must provide writeExternally() for watcher cases",
    );
  }
  return fn;
}

async function seedTree(fs: FsAdapter): Promise<void> {
  await fs.writeText("notes/a.md", "# A\n");
  await fs.writeText("notes/b.MD", "# B uppercase\n");
  await fs.writeText("notes/img.png", "PNGDATA");
  await fs.writeText("notes/daily/c.md", "# C\n");
  await fs.writeText("notes/daily/a.md", "# Daily A\n");
  await fs.writeText("notes/assets/x.png", "PNGDATA");
  await fs.writeText(".DS_Store", "junk");
  await fs.writeText(".hidden.md", "# Hidden\n");
  await fs.writeText(".git/inner.md", "# Git inner\n");
}

function hasDotSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

export function defineFsCases(
  getImpl: () => FsAdapter,
  factory: ContractFactory<FsAdapter>,
): void {
  it("C-FS-01: recursive readDir filters dot files and dot folders", async () => {
    const fs = getImpl();
    await seedTree(fs);
    const entries = await fs.listDir("", true);
    const names = entries.map((entry) => entry.name);
    expect(names).not.toContain(".DS_Store");
    expect(names).not.toContain(".hidden.md");
    expect(names).not.toContain(".git");
    for (const entry of entries) {
      expect(hasDotSegment(entry.path)).toBe(false);
    }
    const paths = entries.map((entry) => entry.path);
    expect(paths).not.toContain(".git/inner.md");
    expect(paths).toContain("notes/a.md");
  });

  it("C-FS-02: the scanner collects only lowercase .md; the tree keeps images", async () => {
    const fs = getImpl();
    await seedTree(fs);
    const scanned = await fs.scanMarkdown();
    expect(scanned).toContain("notes/a.md");
    expect(scanned).not.toContain("notes/b.MD");
    expect(scanned).not.toContain(".hidden.md");
    const treeNames = (await fs.listDir("notes")).map((entry) => entry.name);
    expect(treeNames).toContain("img.png");
    expect(treeNames).toContain("a.md");
  });

  it("C-FS-03: the dot-segment filter holds on watcher, tree, scanner, and import paths", async () => {
    const fs = getImpl();
    await seedTree(fs);
    const events: FsEvent[] = [];
    await fs.onEvent((event) => {
      events.push(event);
    });

    await fs.writeText(".imported-hidden.md", "# Imported hidden\n");
    await fs.writeText("notes/visible.md", "# Visible\n");

    for (const event of events) {
      expect(hasDotSegment(event.path)).toBe(false);
    }
    const tree = await fs.listDir("", true);
    expect(tree.map((entry) => entry.path)).toContain("notes/visible.md");
    for (const entry of tree) {
      expect(hasDotSegment(entry.path)).toBe(false);
    }
    const scanned = await fs.scanMarkdown();
    expect(scanned).toContain("notes/visible.md");
    expect(scanned).not.toContain(".imported-hidden.md");
    for (const path of scanned) {
      expect(hasDotSegment(path)).toBe(false);
    }
  });

  it("C-FS-04: atomic write, readers only ever see OLD or NEW, one changed event", async () => {
    const fs = getImpl();
    const OLD = "O".repeat(256 * 1024);
    const NEW = "N".repeat(256 * 1024);
    await fs.writeText("notes/big.md", OLD);
    const changed: FsEvent[] = [];
    await fs.onEvent((event) => {
      if (event.type === "changed" && event.path === "notes/big.md") {
        changed.push(event);
      }
    });

    const observed = new Set<string>();
    let done = false;
    const reader = (async () => {
      while (!done) {
        observed.add(await fs.readText("notes/big.md"));
        if (observed.has(NEW)) {
          return;
        }
      }
    })();
    await fs.writeText("notes/big.md", NEW);
    done = true;
    await reader;

    for (const content of observed) {
      expect([OLD, NEW]).toContain(content);
    }
    await expect(fs.readText("notes/big.md")).resolves.toBe(NEW);
    expect(changed).toHaveLength(1);
    const dirNames = (await fs.listDir("notes")).map((entry) => entry.name);
    expect(dirNames).toEqual(["big.md"]);
  });

  it("C-FS-05a: rename rewrites Markdown links and image references by default (AD-17)", async () => {
    const fs = getImpl();
    await fs.writeText("notes/a.md", "# A\n");
    await fs.writeText(
      "notes/linker.md",
      "# L\n\n[target](a.md)\n\n![pic](a.png)\n",
    );
    await fs.writeText("notes/a.png", "PNGDATA");

    const result = await fs.rename("notes/a.md", "notes/b.md");
    expect(result.rewrittenFiles).toEqual(["notes/linker.md"]);
    const tree = await fs.listDir("notes");
    expect(tree.map((entry) => entry.name)).not.toContain("a.md");
    expect(tree.map((entry) => entry.name)).toContain("b.md");
    const afterFirst = await fs.readText("notes/linker.md");
    expect(afterFirst).toContain("(b.md)");
    expect(afterFirst).toContain("(a.png)");

    await fs.rename("notes/a.png", "notes/b.png");
    const afterSecond = await fs.readText("notes/linker.md");
    expect(afterSecond).toContain("![pic](b.png)");
  });

  it("C-FS-05b: rename with rewriteLinks false leaves referrers untouched", async () => {
    const fs = getImpl();
    await fs.writeText("notes/a.md", "# A\n");
    const before = "# L\n\n[target](a.md)\n";
    await fs.writeText("notes/linker.md", before);

    const result = await fs.rename("notes/a.md", "notes/b.md", {
      rewriteLinks: false,
    });
    expect(result.rewrittenFiles).toEqual([]);
    await expect(fs.readText("notes/linker.md")).resolves.toBe(before);
    await expect(fs.exists("notes/b.md")).resolves.toBe(true);
  });

  it("C-FS-06: image resolution is relative to the Markdown file directory", async () => {
    const fs = getImpl();
    await seedTree(fs);
    await expect(
      fs.resolveImage("notes/daily/a.md", "../assets/x.png"),
    ).resolves.toBe("notes/assets/x.png");
    await expect(fs.resolveImage("notes/a.md", "x.png")).resolves.toBe(
      "notes/x.png",
    );
    await expect(fs.resolveImage("notes/a.md", "./x.png")).resolves.toBe(
      "notes/x.png",
    );
    await expect(
      fs.resolveImage("notes/a.md", "my%20image.png"),
    ).resolves.toBe("notes/my image.png");
  });

  it("C-FS-07: absolute and slash-led paths are not local media", async () => {
    const fs = getImpl();
    await fs.writeText("notes/doc.md", "# Doc\n");
    await expect(fs.resolveImage("notes/doc.md", "/assets/x.png")).resolves.toBe(
      null,
    );
    await expect(
      fs.resolveImage("notes/doc.md", "C:/assets/x.png"),
    ).resolves.toBe(null);
    await expect(
      fs.resolveImage("notes/doc.md", "https://example.com/x.png"),
    ).resolves.toBe(null);
    await expect(fs.readText("notes/doc.md")).resolves.toBe("# Doc\n");
  });

  it("C-FS-08: a missing image does not block the document", async () => {
    const fs = getImpl();
    await fs.writeText("notes/doc.md", "# Doc\n\n![gone](gone.png)\n");
    await expect(fs.readText("notes/doc.md")).resolves.toContain("![gone]");
    await expect(fs.resolveImage("notes/doc.md", "gone.png")).resolves.toBe(
      "notes/gone.png",
    );
    await expect(fs.exists("notes/gone.png")).resolves.toBe(false);
  });

  it("C-FS-09: traversal outside the root is rejected with a typed error", async () => {
    const fs = getImpl();
    await seedTree(fs);
    const before = await fs.listDir("", true);

    await expect(fs.readText("../../etc/passwd")).rejects.toThrowError(
      ContractError,
    );
    await expect(
      fs.writeText("../../etc/passwd", "x"),
    ).rejects.toThrowError(ContractError);
    await expect(fs.readText("/etc/passwd")).rejects.toThrowError(
      ContractError,
    );
    let thrown: unknown;
    try {
      await fs.writeText("/abs/outside.md", "x");
    } catch (error) {
      thrown = error;
    }
    expect(isContractError(thrown, "VALIDATION")).toBe(true);

    const after = await fs.listDir("", true);
    expect(after).toEqual(before);
    await expect(fs.exists("etc/passwd")).resolves.toBe(false);
  });

  it("C-FS-10: an external write surfaces through events within the latency bound", async () => {
    const fs = getImpl();
    const writeExternally = requireWriteExternally(factory);
    const events: FsEvent[] = [];
    await fs.onEvent((event) => {
      events.push(event);
    });

    const started = Date.now();
    await writeExternally(fs, "notes/outside.md", "# Outside\n");
    while (
      Date.now() - started < WATCHER_MAX_LATENCY_MS &&
      !events.some((event) => event.path === "notes/outside.md")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThanOrEqual(WATCHER_MAX_LATENCY_MS);
    const seen = events.filter((event) => event.path === "notes/outside.md");
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0].type).toBe("created");

    const seqs = events.map((event) => event.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    const tree = await fs.listDir("notes");
    expect(tree.map((entry) => entry.name)).toContain("outside.md");
  });

  it("C-FS-11: delete moves to trash, restore returns content, purge removes permanently", async () => {
    const fs = getImpl();
    await fs.writeText("notes/doomed.md", "# Doomed\n");
    await fs.removeToTrash("notes/doomed.md");
    await expect(fs.exists("notes/doomed.md")).resolves.toBe(false);
    await expect(fs.listTrash()).resolves.toEqual(["notes/doomed.md"]);

    await fs.restoreFromTrash("notes/doomed.md");
    await expect(fs.readText("notes/doomed.md")).resolves.toBe("# Doomed\n");
    await expect(fs.listTrash()).resolves.toEqual([]);

    await fs.removeToTrash("notes/doomed.md");
    await fs.purgeFromTrash("notes/doomed.md");
    await expect(fs.listTrash()).resolves.toEqual([]);
    await expect(fs.restoreFromTrash("notes/doomed.md")).rejects.toThrowError(
      ContractError,
    );
  });
}
