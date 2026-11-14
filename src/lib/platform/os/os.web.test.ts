// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the web OsAdapter (V2-14).
 *
 * No test runner is configured in package.json. Run with esbuild plus
 * the Node test runner (Node 24):
 *
 *   node_modules/.bin/esbuild src/lib/platform/os/os.web.test.ts \
 *     --bundle --platform=node --format=cjs --outfile=/tmp/v2-14-os-web.test.cjs \
 *     && node --test /tmp/v2-14-os-web.test.cjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlatformCapabilityError } from "../errors";
import type { OsAdapter } from "./interface";
import { createWebOsAdapter } from "./os.web";

function capabilityDetails(error: unknown) {
  assert.ok(error instanceof PlatformCapabilityError, `expected PlatformCapabilityError, got ${String(error)}`);
  return {
    code: error.code,
    capability: error.capability,
    adapter: error.adapter,
    mode: error.mode,
  };
}

describe("web OsAdapter platform", () => {
  it("platform() returns web with no options", () => {
    const adapter: OsAdapter = createWebOsAdapter();
    assert.equal(adapter.platform(), "web");
  });

  it("platform() returns web regardless of the locale override", () => {
    assert.equal(createWebOsAdapter({ language: "id-ID" }).platform(), "web");
    assert.equal(createWebOsAdapter({ language: null }).platform(), "web");
    assert.equal(createWebOsAdapter({ language: "" }).platform(), "web");
  });
});

describe("web OsAdapter unavailable capabilities", () => {
  it("version() throws PlatformCapabilityError with os.version", () => {
    const adapter = createWebOsAdapter({ language: null });
    let caught: unknown;
    try {
      adapter.version();
    } catch (error) {
      caught = error;
    }
    assert.deepEqual(capabilityDetails(caught), {
      code: "unavailable",
      capability: "os.version",
      adapter: "os",
      mode: "web",
    });
  });

  it("arch() throws PlatformCapabilityError with os.arch", () => {
    const adapter = createWebOsAdapter({ language: null });
    let caught: unknown;
    try {
      adapter.arch();
    } catch (error) {
      caught = error;
    }
    assert.deepEqual(capabilityDetails(caught), {
      code: "unavailable",
      capability: "os.arch",
      adapter: "os",
      mode: "web",
    });
  });
});

describe("web OsAdapter locale and app version", () => {
  it("locale() returns the language override", async () => {
    const adapter = createWebOsAdapter({ language: "id-ID" });
    assert.equal(await adapter.locale(), "id-ID");
  });

  it("locale() returns null when the language is null or empty", async () => {
    assert.equal(await createWebOsAdapter({ language: null }).locale(), null);
    assert.equal(await createWebOsAdapter({ language: "" }).locale(), null);
  });

  it("locale() without an override reads the global navigator language", async () => {
    const nav = (globalThis as { navigator?: { language?: unknown } }).navigator;
    const expected = typeof nav?.language === "string" && nav.language ? nav.language : null;
    assert.equal(await createWebOsAdapter().locale(), expected);
  });

  it("getAppVersion() returns the upstream base version constant", async () => {
    const adapter = createWebOsAdapter({ language: null });
    assert.equal(await adapter.getAppVersion(), "0.39.2");
  });

  it("getAppVersion() honors the factory override", async () => {
    const adapter = createWebOsAdapter({ language: null, appVersion: "9.9.9-test" });
    assert.equal(await adapter.getAppVersion(), "9.9.9-test");
  });
});
