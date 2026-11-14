// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PlatformCapabilityError } from "../errors";
import type { ProcessAdapter } from "./interface";
import { createWebProcessAdapter } from "./process.web";

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

describe("disabled web process adapter", () => {
  it("rejects exit() with a typed unsupported error", async () => {
    const adapter: ProcessAdapter = createWebProcessAdapter();
    await rejectsUnsupported(adapter.exit(), "process", "exit");
  });

  it("rejects exit(0) with a typed unsupported error", async () => {
    const adapter: ProcessAdapter = createWebProcessAdapter();
    await rejectsUnsupported(adapter.exit(0), "process", "exit");
  });

  it("rejects exit(1) with a typed unsupported error", async () => {
    const adapter: ProcessAdapter = createWebProcessAdapter();
    await rejectsUnsupported(adapter.exit(1), "process", "exit");
  });

  it("rejects relaunch() with a typed unsupported error", async () => {
    const adapter: ProcessAdapter = createWebProcessAdapter();
    await rejectsUnsupported(adapter.relaunch(), "process", "relaunch");
  });

  it("returns a fresh adapter instance per factory call", () => {
    assert.notEqual(createWebProcessAdapter(), createWebProcessAdapter());
  });
});
