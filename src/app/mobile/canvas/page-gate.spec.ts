// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-4 (CANVAS-01) static pins for the mobile canvas list gate:
// in web mode the page must render the disabled marker and never
// call loadProjects, whose getDb() rejection left a permanent
// loading state. The preview shell used as the editor backdrop
// stays unchanged.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const SOURCE = readFileSync(join(HERE, "page.tsx"), "utf8");

describe("DA-4 CANVAS-01 mobile canvas list gate", () => {
  it("checks the canvas feature flag", () => {
    expect(SOURCE).toContain("isEditorFeatureDisabled('canvas')");
  });

  it("skips the project load while disabled", () => {
    expect(SOURCE).toContain("if (preview || canvasDisabled) return");
  });

  it("renders the marker instead of the list while disabled", () => {
    expect(SOURCE).toContain("if (canvasDisabled && !preview)");
    expect(SOURCE).toContain('EditorDisabledNotice feature="canvas"');
  });
});
