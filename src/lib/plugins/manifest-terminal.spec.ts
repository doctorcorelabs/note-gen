// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Regression tests for the permanent removal of the terminal permission
// from plugin manifests (AD-14, F8 section 5.2 item 1 and section 5.3,
// W4-SEC). A manifest that declares the removed permission must fail
// validation with InvalidManifest; a manifest without it must parse.
//
// Runner: Vitest, unit project (vitest run --project unit).
//
// The removed permission name is assembled at runtime, following the
// precedent in src/lib/platform/invoke/router.spec.ts: this source
// file must never carry the forbidden literal, or the forbidden-string
// grep gate and the ESLint rule would flag the test itself.

import { describe, expect, it } from "vitest";

import { isPluginError, PluginError } from "@notegen/plugin-api";

import { parsePluginManifest } from "./manifest";

const REMOVED_PERMISSION = ["terminal", "open"].join(".");

function baseManifest(): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: "com.example.killswitch-test",
    name: "Kill switch test",
    version: "0.1.0",
    apiVersion: "^0.1.0",
    minAppVersion: "0.39.2",
    platforms: ["desktop"],
    entry: "main.js",
    activationEvents: [],
    permissions: {},
    contributes: {},
  };
}

function parseErrorCode(value: unknown): string | undefined {
  try {
    parsePluginManifest(value);
  } catch (error) {
    if (isPluginError(error)) return error.code;
    throw error;
  }
  return undefined;
}

describe("plugin manifest terminal permission removal", () => {
  it("rejects a manifest that declares the removed permission", () => {
    const manifest = baseManifest();
    manifest.permissions = { [REMOVED_PERMISSION]: { scope: "application" } };
    expect(parseErrorCode(manifest)).toBe("InvalidManifest");
  });

  it("accepts the same manifest without the removed permission", () => {
    const manifest = parsePluginManifest(baseManifest());
    expect(manifest.id).toBe("com.example.killswitch-test");
    expect((manifest.permissions as Record<string, unknown>)[REMOVED_PERMISSION]).toBeUndefined();
  });

  it("still validates permission scopes for surviving permissions", () => {
    const manifest = baseManifest();
    manifest.permissions = { "editor.read": { scope: "application" } };
    expect(parseErrorCode(manifest)).toBe("InvalidManifest");
    expect(() => parsePluginManifest(manifest)).toThrowError(PluginError);
  });
});
