// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the web AssetUrlAdapter (V2-14).
 *
 * No test runner is configured in package.json. Run with esbuild plus
 * the Node test runner (Node 24):
 *
 *   node_modules/.bin/esbuild src/lib/platform/asset/asset.web.test.ts \
 *     --bundle --platform=node --format=cjs --outfile=/tmp/v2-14-asset-web.test.cjs \
 *     && node --test /tmp/v2-14-asset-web.test.cjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlatformCapabilityError } from "../errors";
import type { AssetUrlAdapter } from "./interface";
import { createWebAssetUrlAdapter } from "./asset.web";

const adapter: AssetUrlAdapter = createWebAssetUrlAdapter();

function expectInvalidPath(input: unknown, protocol?: string): void {
  assert.throws(
    () => adapter.convertFileSrc(input as string, protocol),
    (error: unknown) => {
      assert.ok(error instanceof PlatformCapabilityError, `expected PlatformCapabilityError, got ${String(error)}`);
      assert.equal(error.code, "invalid_argument");
      assert.equal(error.capability, "assetUrl.convertFileSrc");
      assert.equal(error.adapter, "assetUrl");
      assert.equal(error.mode, "web");
      // The echo check needs an input longer than the ".." token itself:
      // the traversal reason legitimately names the ".." segment.
      if (typeof input === "string" && input.length > 2) {
        assert.ok(!error.reason?.includes(input), "error reason must never echo the supplied path");
        assert.ok(!error.message.includes(input), "error message must never echo the supplied path");
      }
      return true;
    },
  );
}

describe("web AssetUrlAdapter media URL building", () => {
  it("builds a media URL from a workspace-relative path", () => {
    assert.equal(adapter.convertFileSrc("article/image.png"), "/api/workspace/media/article/image.png");
    assert.equal(adapter.convertFileSrc("image.png"), "/api/workspace/media/image.png");
  });

  it("encodes each segment separately and keeps slashes as separators", () => {
    assert.equal(
      adapter.convertFileSrc("my folder/a b.png"),
      "/api/workspace/media/my%20folder/a%20b.png",
    );
    assert.equal(
      adapter.convertFileSrc("a#b/c?d.png"),
      "/api/workspace/media/a%23b/c%3Fd.png",
    );
    assert.equal(
      adapter.convertFileSrc("100%/done.png"),
      "/api/workspace/media/100%25/done.png",
    );
  });

  it("encodes non-ASCII segments as UTF-8 percent sequences", () => {
    assert.equal(
      adapter.convertFileSrc("foto/gunung berapi.png"),
      "/api/workspace/media/foto/gunung%20berapi.png",
    );
    assert.equal(adapter.convertFileSrc("a/b-c_d.png"), "/api/workspace/media/a/b-c_d.png");
  });

  it("normalizes backslashes, double slashes, and dot segments", () => {
    assert.equal(adapter.convertFileSrc("article\\image.png"), "/api/workspace/media/article/image.png");
    assert.equal(adapter.convertFileSrc("article//image.png"), "/api/workspace/media/article/image.png");
    assert.equal(adapter.convertFileSrc("./article/./image.png"), "/api/workspace/media/article/image.png");
    assert.equal(adapter.convertFileSrc("article/./image.png"), "/api/workspace/media/article/image.png");
  });

  it("treats percent-encoded traversal literally, never as a separator", () => {
    assert.equal(
      adapter.convertFileSrc("a/%2e%2e/b.png"),
      "/api/workspace/media/a/%252e%252e/b.png",
    );
  });

  it("keeps a caller-appended cache-busting query working on the built URL", () => {
    const url = `${adapter.convertFileSrc("canvas/thumb.png")}?v=1700000000000`;
    assert.equal(url, "/api/workspace/media/canvas/thumb.png?v=1700000000000");
  });
});

describe("web AssetUrlAdapter passthrough", () => {
  it("returns already-resolved sources unchanged", () => {
    const sources = [
      "https://example.com/image.png",
      "http://example.com/image.png",
      "data:image/png;base64,AAAA",
      "blob:https://app.example/1234",
      "asset://localhost/image.png",
      "tauri://localhost/image.png",
      "file:///tmp/image.png",
    ];
    for (const source of sources) {
      assert.equal(adapter.convertFileSrc(source), source);
    }
  });

  it("returns already-built media URLs unchanged (idempotent)", () => {
    assert.equal(
      adapter.convertFileSrc("/api/workspace/media/article/image.png"),
      "/api/workspace/media/article/image.png",
    );
    assert.equal(
      adapter.convertFileSrc("/api/workspace/media/article/image.png?v=abc"),
      "/api/workspace/media/article/image.png?v=abc",
    );
    assert.equal(adapter.convertFileSrc("/api/workspace/media"), "/api/workspace/media");
  });
});

describe("web AssetUrlAdapter protocol argument", () => {
  it("accepts an absent protocol and the default asset protocol", () => {
    assert.equal(adapter.convertFileSrc("a/b.png"), "/api/workspace/media/a/b.png");
    assert.equal(adapter.convertFileSrc("a/b.png", "asset"), "/api/workspace/media/a/b.png");
    assert.equal(adapter.convertFileSrc("a/b.png", "ASSET"), "/api/workspace/media/a/b.png");
    assert.equal(adapter.convertFileSrc("a/b.png", ""), "/api/workspace/media/a/b.png");
  });

  it("rejects a custom protocol with an unsupported capability error", () => {
    assert.throws(
      () => adapter.convertFileSrc("a/b.png", "stream"),
      (error: unknown) => {
        assert.ok(error instanceof PlatformCapabilityError);
        assert.equal(error.code, "unsupported");
        assert.equal(error.capability, "assetUrl.convertFileSrc");
        assert.equal(error.adapter, "assetUrl");
        assert.equal(error.mode, "web");
        return true;
      },
    );
  });

  it("rejects a non-string protocol with TypeError", () => {
    assert.throws(() => adapter.convertFileSrc("a/b.png", 42 as unknown as string), TypeError);
  });
});

describe("web AssetUrlAdapter path rejection", () => {
  it("rejects empty and dot-only paths", () => {
    expectInvalidPath("");
    expectInvalidPath(".");
    expectInvalidPath("./");
    expectInvalidPath("///");
  });

  it("rejects absolute paths and Windows drive paths", () => {
    expectInvalidPath("/etc/passwd");
    expectInvalidPath("/article/image.png");
    expectInvalidPath("C:/Users/user/image.png");
    expectInvalidPath("C:image.png");
    expectInvalidPath("\\\\server\\share\\image.png");
    expectInvalidPath("\\article\\image.png");
  });

  it("rejects parent segments anywhere in the path", () => {
    expectInvalidPath("..");
    expectInvalidPath("../secret.txt");
    expectInvalidPath("article/../../etc/passwd");
    expectInvalidPath("article/..\\..\\secret.txt");
    expectInvalidPath("../../../../etc/passwd");
  });

  it("rejects dot-leading hidden segments", () => {
    expectInvalidPath(".git/config");
    expectInvalidPath(".notegen/thumb.png");
    expectInvalidPath("article/.hidden.png");
    expectInvalidPath(".DS_Store");
  });

  it("rejects NUL and control characters", () => {
    expectInvalidPath("a/b\u0000.png");
    expectInvalidPath("a/b\u0007.png");
    expectInvalidPath("a/b\u007f.png");
  });

  it("rejects paths over 1024 UTF-8 bytes and over 50 segments", () => {
    expectInvalidPath(`${"a".repeat(1025)}.png`);
    expectInvalidPath(Array.from({ length: 51 }, (_, i) => `seg${i}`).join("/") + "/f.png");
  });

  it("accepts paths exactly at the segment limit", () => {
    const path = Array.from({ length: 50 }, (_, i) => `s${i}`).join("/");
    assert.equal(adapter.convertFileSrc(path), `/api/workspace/media/${path}`);
  });

  it("rejects a non-string path with an invalid-argument error", () => {
    expectInvalidPath(42);
    expectInvalidPath(null);
  });
});
