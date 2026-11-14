// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PlatformCapabilityError } from "../errors";
import type { UpdaterAdapter, UpdaterUpdate } from "./interface";
import { createDisabledUpdaterUpdate, createWebUpdaterAdapter } from "./updater.web";

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
  it("exposes isDisabled true for UI gating", () => {
    const adapter: UpdaterAdapter = createWebUpdaterAdapter();
    assert.equal(adapter.isDisabled, true);
  });

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

describe("disabled updater update handle", () => {
  function makeHandle(): UpdaterUpdate {
    return createDisabledUpdaterUpdate("0.40.0", "0.39.2", "2026-11-14", "Release notes");
  }

  it("exposes read-only metadata properties", () => {
    const handle = makeHandle();
    assert.equal(handle.version, "0.40.0");
    assert.equal(handle.currentVersion, "0.39.2");
    assert.equal(handle.date, "2026-11-14");
    assert.equal(handle.body, "Release notes");
  });

  it("rejects download() with a typed unsupported error", async () => {
    await rejectsUnsupported(makeHandle().download(), "updater", "download");
  });

  it("rejects download(onEvent, options) with a typed unsupported error", async () => {
    await rejectsUnsupported(
      makeHandle().download(() => undefined, { timeout: 5000 }),
      "updater",
      "download",
    );
  });

  it("rejects install() with a typed unsupported error", async () => {
    await rejectsUnsupported(makeHandle().install(), "updater", "install");
  });

  it("rejects downloadAndInstall() with a typed unsupported error", async () => {
    await rejectsUnsupported(makeHandle().downloadAndInstall(), "updater", "downloadAndInstall");
  });

  it("rejects close() with a typed unsupported error", async () => {
    await rejectsUnsupported(makeHandle().close(), "updater", "close");
  });

  it("returns a fresh handle per factory call", () => {
    assert.notEqual(makeHandle(), makeHandle());
  });
});
