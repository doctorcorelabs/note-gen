// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-4 (A30-03) static pins for the web boot gates: the two
// window.listen registrations and the two desktop bridges must
// not run in web mode, where they only produced an unhandled
// rejection and a console error on every boot. Runtime proof
// (clean boot console) belongs to the post-deploy browser rerun.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const SOURCE = readFileSync(join(HERE, "layout.tsx"), "utf8");

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = SOURCE.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf(endMarker, start + startMarker.length);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("DA-4 A30-03 web boot gates", () => {
  it("the plugin install listener is skipped in web mode", () => {
    const fn = sliceBetween("const registerPluginInstallListener", "void registerPluginInstallListener()");
    expect(fn).toContain("if (!isTauri()) return");
    expect(fn.indexOf("if (!isTauri()) return")).toBeLessThan(fn.indexOf("await window.listen"));
  });

  it("the open-files listener is skipped in web mode", () => {
    const fn = sliceBetween("const registerOpenFileListener", "void registerOpenFileListener()");
    expect(fn).toContain("if (!isTauri()) return");
    expect(fn.indexOf("if (!isTauri()) return")).toBeLessThan(fn.indexOf("await window.listen"));
  });

  it("the desktop bridges are not mounted in web mode", () => {
    expect(SOURCE).toContain("{isTauri() ? <WebClipperBridge /> : null}");
    expect(SOURCE).toContain("{isTauri() ? <DesktopScreenshotBridge ready={pluginsReady} /> : null}");
  });
});
