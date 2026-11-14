// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PlatformCapabilityError } from "../errors";
import type { UpdateInfo, UpdaterAdapter } from "./interface";
import { createDisabledUpdateInfo, createWebUpdaterAdapter } from "./updater.web";

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

describe("disabled web updater adapter", () => {
  it("rejects check() with a typed unsupported error", async () => {
    const adapter: UpdaterAdapter = createWebUpdaterAdapter();
    await rejectsUnsupported(adapter.check(), "updater", "check");
  });

  it("rejects check({ timeout }) with a typed unsupported error", async () => {
    const adapter: UpdaterAdapter = createWebUpdaterAdapter();
    await rejectsUnsupported(adapter.check({ timeout: 5000 }), "updater", "check");
  });

  it("rejects check({ timeout, target }) with a typed unsupported error", async () => {
    const adapter: UpdaterAdapter = createWebUpdaterAdapter();
    await rejectsUnsupported(
      adapter.check({ timeout: 5000, target: "x86_64-pc-windows-msvc" }),
      "updater",
      "check",
    );
  });

  it("returns a fresh adapter instance per factory call", () => {
    assert.notEqual(createWebUpdaterAdapter(), createWebUpdaterAdapter());
  });
});

describe("disabled updater update info", () => {
  function makeHandle(): UpdateInfo {
    return createDisabledUpdateInfo("0.40.0", "0.39.2", "2026-11-14", "Release notes");
  }

  it("exposes read-only metadata properties", () => {
    const handle = makeHandle();
    assert.equal(handle.available, true);
    assert.equal(handle.version, "0.40.0");
    assert.equal(handle.currentVersion, "0.39.2");
    assert.equal(handle.date, "2026-11-14");
    assert.equal(handle.body, "Release notes");
    assert.deepEqual(handle.rawJson, {});
  });

  it("rejects downloadAndInstall() with a typed unsupported error", async () => {
    await rejectsUnsupported(makeHandle().downloadAndInstall(), "updater", "downloadAndInstall");
  });

  it("rejects downloadAndInstall(onEvent, options) with a typed unsupported error", async () => {
    await rejectsUnsupported(
      makeHandle().downloadAndInstall(() => undefined, { timeout: 5000 }),
      "updater",
      "downloadAndInstall",
    );
  });

  it("returns a fresh handle per factory call", () => {
    assert.notEqual(makeHandle(), makeHandle());
  });
});
