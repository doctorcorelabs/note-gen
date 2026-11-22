// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-4 (A30-06) static pins for the quick-record effect gate:
// the desktop window setup must not run in web mode, where the
// render is already gated. Runtime proof (marker plus clean
// console) belongs to the post-deploy browser rerun.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const SOURCE = readFileSync(join(HERE, "page.tsx"), "utf8");

describe("DA-4 A30-06 quick-record effect gate", () => {
  it("the setup effect returns early in web mode before any window call", () => {
    const effect = SOURCE.slice(SOURCE.indexOf("useEffect(() => {"));
    expect(effect).toContain("if (isEditorFeatureDisabled('quickRecordWindow')) return");
    expect(effect.indexOf("isEditorFeatureDisabled('quickRecordWindow')"))
      .toBeLessThan(effect.indexOf("window.onCloseRequested(event"));
  });

  it("the render gate stays", () => {
    expect(SOURCE).toContain('EditorDisabledNotice feature="quickRecordWindow"');
  });
});
