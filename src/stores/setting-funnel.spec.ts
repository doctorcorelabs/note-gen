// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// F122-Q2 (W4-F122Q): the two generic funnels in setting.ts must guard
// against a future undefined assignment without deleting the key and
// without throwing mid-batch. The setting store graph is too heavy to
// import in a unit test (it pulls the app config, sync queue, editor,
// and theme modules, and its subscription needs window/document), so
// the guards are pinned by reading the source, following the static-pin
// precedent of no-platform-shadowing.spec.ts. The guard logic itself is
// a plain undefined check in front of store.set(); what must not regress
// is its presence and its position before the write.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const SOURCE = readFileSync(join(REPO_ROOT, "src", "stores", "setting.ts"), "utf8");

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = SOURCE.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf(endMarker, start + startMarker.length);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("F122-Q2 setting funnels", () => {
  it("persistChangedSettings skips undefined values before store.set, without deleting", () => {
    const fn = sliceBetween(
      "async function persistChangedSettings(",
      "\n}\n",
    );
    expect(fn).toContain("const value = stateRecord[key]");
    const guardAt = fn.indexOf("if (value === undefined)");
    const writeAt = fn.indexOf("await store.set(key, value)");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeGreaterThan(guardAt);
    expect(fn.slice(guardAt, writeAt)).toContain("continue");
    expect(fn).not.toContain("store.delete");
  });

  it("the hydration loop skips undefined defaults before store.set, without deleting", () => {
    const loop = sliceBetween(
      "await Promise.all(Object.entries(get())",
      "await store.save()",
    );
    const guardAt = loop.indexOf("if (value === undefined) return");
    const writeAt = loop.indexOf("await store.set(key, value)");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeGreaterThan(guardAt);
    expect(loop).not.toContain("store.delete");
  });

  it("both funnels keep their existing key exclusions", () => {
    const fn = sliceBetween(
      "async function persistChangedSettings(",
      "\n}\n",
    );
    expect(fn).toContain(
      "if (key === 'primaryBackupMethod' || key === 'platformSwitchRecovery') continue",
    );
  });

  // W4-DEMO B6: the hydration loop must not abort when the store
  // rejects a default it cannot hold (server-side secret keys such
  // as `accessToken` in web mode). Only capability rejections for
  // that key are skipped; any other failure still aborts init.
  it("the hydration loop skips capability rejections on default persist, rethrowing the rest", () => {
    const loop = sliceBetween(
      "await Promise.all(Object.entries(get())",
      "await store.save()",
    );
    const writeAt = loop.indexOf("await store.set(key, value)");
    expect(writeAt).toBeGreaterThanOrEqual(0);
    const tryAt = loop.lastIndexOf("try {", writeAt);
    expect(tryAt).toBeGreaterThanOrEqual(0);
    const catchAt = loop.indexOf("} catch (error) {", writeAt);
    expect(catchAt).toBeGreaterThan(writeAt);
    const handler = loop.slice(catchAt, catchAt + 200);
    expect(handler).toContain("if (error instanceof PlatformCapabilityError) return");
    expect(handler).toContain("throw error");
    expect(SOURCE).toContain("PlatformCapabilityError } from '@/lib/platform'");
  });
});
