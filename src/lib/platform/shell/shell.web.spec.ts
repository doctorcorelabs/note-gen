// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PlatformCapabilityError } from "../errors";
import type { ShellAdapter } from "./interface";
import { createWebShellAdapter } from "./shell.web";

function assertUnsupported(error: unknown, adapter: string, capability: string): void {
  assert.ok(
    error instanceof PlatformCapabilityError,
    `expected PlatformCapabilityError, got ${String(error)}`,
  );
  assert.equal(error.code, "unsupported");
  assert.equal(error.adapter, adapter);
  assert.equal(error.capability, capability);
  assert.equal(error.mode, "web");
  assert.equal(error.name, "PlatformCapabilityError");
  assert.ok(
    typeof error.reason === "string" && error.reason.length > 0,
    "expected a non-empty string reason",
  );
  assert.match(error.message, new RegExp(`${adapter}\\.${capability}`));
}

async function rejectsUnsupported(
  promise: Promise<unknown>,
  adapter: string,
  capability: string,
): Promise<void> {
  let rejected = false;
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    caught = error;
  }
  assert.equal(rejected, true, `expected ${adapter}.${capability} to reject`);
  assertUnsupported(caught, adapter, capability);
}

describe("disabled web shell adapter", () => {
  it("rejects open(url) with a typed unsupported error", async () => {
    const adapter: ShellAdapter = createWebShellAdapter();
    await rejectsUnsupported(adapter.open("https://example.com"), "shell", "open");
  });

  it("rejects open(path, openWith) with a typed unsupported error", async () => {
    const adapter: ShellAdapter = createWebShellAdapter();
    await rejectsUnsupported(adapter.open("/path/to/file", "firefox"), "shell", "open");
  });

  it("returns a fresh adapter instance per factory call", () => {
    assert.notEqual(createWebShellAdapter(), createWebShellAdapter());
  });
});
