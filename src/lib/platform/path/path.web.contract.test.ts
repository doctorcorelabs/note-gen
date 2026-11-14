// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Contract tests for the web PathAdapter (node:test).
//
// These tests run without Vitest, which the V2-06 scaffold does not
// provide yet: bundle with esbuild and run under node --test (see the
// V2-11 report for the exact commands). The integrator may move them to
// the contract suite location once the scaffold lands; the cases stay
// the same.
//
// Coverage follows the api/path usage inventory in V1-05 section 1.4:
// the six interface functions, exercised the way the 53 importing
// files use them (appDataDir + join for workspace roots, basename /
// normalize for attachment paths, dirname for parent folders).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  VIRTUAL_APP_CONFIG_DIR,
  VIRTUAL_APP_DATA_DIR,
} from "./interface";
import { createWebPathAdapter } from "./path.web";

describe("web PathAdapter virtual roots", () => {
  it("returns the virtual app-data and app-config prefixes", async () => {
    const path = createWebPathAdapter();
    assert.equal(await path.appDataDir(), "/appdata");
    assert.equal(await path.appConfigDir(), "/appconfig");
    assert.equal(VIRTUAL_APP_DATA_DIR, "/appdata");
    assert.equal(VIRTUAL_APP_CONFIG_DIR, "/appconfig");
  });

  it("builds workspace roots the way call sites do", async () => {
    const path = createWebPathAdapter();
    const root = await path.join(await path.appDataDir(), "article");
    assert.equal(root, "/appdata/article");
    assert.equal(await path.join(root, "sub", "note.md"), "/appdata/article/sub/note.md");
  });

  it("is async like the Tauri functions", async () => {
    const path = createWebPathAdapter();
    assert.ok(path.appDataDir() instanceof Promise);
    assert.ok(path.join("a", "b") instanceof Promise);
    assert.ok(path.dirname("a/b") instanceof Promise);
    assert.ok(path.basename("a/b") instanceof Promise);
    assert.ok(path.normalize("a/b") instanceof Promise);
  });
});

describe("web PathAdapter join", () => {
  it("joins segments with one separator", async () => {
    const path = createWebPathAdapter();
    assert.equal(await path.join("a", "b", "c"), "a/b/c");
    assert.equal(await path.join("a/", "b/"), "a/b");
    assert.equal(await path.join("a/", "/b/"), "/b");
    assert.equal(await path.join("a", "", "b"), "a/b");
    assert.equal(await path.join(""), "");
    assert.equal(await path.join(), "");
  });

  it("resets on a later absolute segment", async () => {
    const path = createWebPathAdapter();
    assert.equal(await path.join("a", "/b"), "/b");
    assert.equal(await path.join("/appdata", "/etc", "x"), "/etc/x");
    assert.equal(await path.join("a", "C:/b"), "C:/b");
  });

  it("normalizes dot segments in the result", async () => {
    const path = createWebPathAdapter();
    assert.equal(await path.join("a", ".", "b"), "a/b");
    assert.equal(await path.join("a", "..", "b"), "b");
    assert.equal(await path.join("/a", "..", "b"), "/b");
  });

  it("accepts backslashes", async () => {
    const path = createWebPathAdapter();
    assert.equal(await path.join("a\\b", "c"), "a/b/c");
    assert.equal(await path.join("C:\\notes", "x.md"), "C:/notes/x.md");
  });
});

describe("web PathAdapter dirname", () => {
  it("returns the parent directory", async () => {
    const path = createWebPathAdapter();
    assert.equal(await path.dirname("a/b/c"), "a/b");
    assert.equal(await path.dirname("/appdata/article/x.md"), "/appdata/article");
    assert.equal(await path.dirname("a/b/"), "a");
    assert.equal(await path.dirname("/a"), "/");
  });

  it("returns empty string when there is no parent", async () => {
    const path = createWebPathAdapter();
    assert.equal(await path.dirname("a"), "");
    assert.equal(await path.dirname(""), "");
    assert.equal(await path.dirname("/"), "");
  });

  it("keeps drive roots", async () => {
    const path = createWebPathAdapter();
    assert.equal(await path.dirname("C:/a"), "C:/");
    assert.equal(await path.dirname("C:/a/b"), "C:/a");
  });
});

describe("web PathAdapter basename", () => {
  it("returns the last portion", async () => {
    const path = createWebPathAdapter();
    assert.equal(await path.basename("path/to/app.conf"), "app.conf");
    assert.equal(await path.basename("a/b/"), "b");
    assert.equal(await path.basename("solo"), "solo");
    assert.equal(await path.basename("/"), "");
    assert.equal(await path.basename(""), "");
  });

  it("strips an extension when asked", async () => {
    const path = createWebPathAdapter();
    assert.equal(await path.basename("file.html", "html"), "file");
    assert.equal(await path.basename("file.html", ".html"), "file");
    assert.equal(await path.basename("archive.tar.gz", "gz"), "archive.tar");
    assert.equal(await path.basename("file.html", "md"), "file.html");
    assert.equal(await path.basename("file.html"), "file.html");
  });
});

describe("web PathAdapter normalize", () => {
  it("resolves dot segments lexically", async () => {
    const path = createWebPathAdapter();
    assert.equal(await path.normalize("a/./b"), "a/b");
    assert.equal(await path.normalize("a/b/../c"), "a/c");
    assert.equal(await path.normalize("a//b"), "a/b");
    assert.equal(await path.normalize("/a/../b"), "/b");
    assert.equal(await path.normalize("/.."), "/");
  });

  it("preserves leading parent segments of relative paths", async () => {
    const path = createWebPathAdapter();
    assert.equal(await path.normalize("../x"), "../x");
    assert.equal(await path.normalize("a/../../b"), "../b");
  });

  it("normalizes separators and drive letters", async () => {
    const path = createWebPathAdapter();
    assert.equal(await path.normalize("a\\b\\..\\c"), "a/c");
    assert.equal(await path.normalize("C:/a/../b"), "C:/b");
  });

  it("supports containment checks like resolveAttachmentChildPath", async () => {
    const path = createWebPathAdapter();
    const root = await path.normalize("/appdata/article");
    const target = await path.normalize(
      await path.join("/appdata/article", "sub/note.md"),
    );
    assert.ok(target.startsWith(`${root}/`));
    const escaping = await path.normalize(
      await path.join("/appdata/article", "../other.md"),
    );
    assert.equal(escaping, "/appdata/other.md");
    assert.ok(!escaping.startsWith(`${root}/`));
  });
});
