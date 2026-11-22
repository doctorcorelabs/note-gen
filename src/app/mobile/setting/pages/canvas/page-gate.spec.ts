// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-4 (CANVAS-02) static pins for the mobile canvas settings
// gate: the mobile route must render the disabled notice in web
// mode instead of working canvas controls. The core direct route
// is pinned by gated-pages.spec.ts (A30-01).
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const SOURCE = readFileSync(join(HERE, "page.tsx"), "utf8");

describe("DA-4 CANVAS-02 mobile canvas settings gate", () => {
  it("renders the disabled notice in web mode", () => {
    expect(SOURCE).toContain("if (!isTauri())");
    expect(SOURCE).toContain('data-disabled-setting-section="canvas"');
  });

  it("mounts the upstream page only behind the gate", () => {
    expect(SOURCE).toContain("<CanvasSettingPage mobile />");
    expect(SOURCE.indexOf("if (!isTauri())")).toBeLessThan(SOURCE.indexOf("<CanvasSettingPage mobile />"));
  });
});
