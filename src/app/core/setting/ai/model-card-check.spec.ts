// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-07) static pins for the connection-check deadline
// landed in DA-2: a hanging provider must stop spinning within
// the deadline, an abort must reset the state, and a stale
// check result must not overwrite a newer check. The component
// graph is too heavy to mount here, so these pins follow the
// setting-funnel.spec.ts precedent. Runtime proof (spinner
// stops against a hanging provider) belongs to the post-deploy
// browser rerun.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "model-card.tsx"), "utf8");

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = SOURCE.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf(endMarker, start + startMarker.length);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("DA-3 SET-07 connection check deadline pins", () => {
  it("handleCheck arms a 30 second deadline that aborts the check", () => {
    const fn = sliceBetween("const handleCheck", "\n  const checkModelStatus");
    expect(fn).toContain("setTimeout");
    expect(fn).toContain("30000");
    expect(fn).toContain("controller.abort()");
  });

  it("an abort resets the check state instead of sticking on checking", () => {
    const fn = sliceBetween("const handleCheck", "\n  const checkModelStatus");
    expect(fn).toContain("setCheckState(timedOut ? 'error' : 'init')");
  });

  it("a stale check result cannot overwrite a newer check", () => {
    const fn = sliceBetween("const handleCheck", "\n  const checkModelStatus");
    expect(fn).toContain("abortControllerRef.current !== controller");
  });

  it("the chat path forwards the abort signal", () => {
    const fn = sliceBetween("const checkModelStatus", "\n  const renderCheckIcon");
    expect(fn).toContain("{ signal }");
  });

  it("the STT path only passes on a format rejection (SET-08)", () => {
    const fn = sliceBetween("const checkModelStatus", "\n  const renderCheckIcon");
    expect(fn).toContain("isSttFormatRejection");
  });
});
