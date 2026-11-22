// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-4 (F1 area 21) static pins for the mobile webSearch gate:
// the mobile route must render the disabled notice in web mode
// instead of the upstream page with its API key fields. The core
// direct route is pinned by gated-pages.spec.ts (A30-01).
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const SOURCE = readFileSync(join(HERE, "page.tsx"), "utf8");

describe("DA-4 F1 area 21 mobile webSearch gate", () => {
  it("renders the disabled notice in web mode", () => {
    expect(SOURCE).toContain("if (!isTauri())");
    expect(SOURCE).toContain('data-disabled-setting-section="webSearch"');
  });

  it("mounts the upstream page only behind the gate", () => {
    expect(SOURCE).toContain("<WebSearchSettingPage mobile />");
    expect(SOURCE.indexOf("if (!isTauri())")).toBeLessThan(SOURCE.indexOf("<WebSearchSettingPage mobile />"));
  });
});
