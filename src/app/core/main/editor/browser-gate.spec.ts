// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-4 (A30-02) static pins for the browser tab gates: no New
// Browser menu entry, no programmatic tab creation, and no dead
// BrowserPanel render in web mode; a restored browser tab shows
// the disabled marker instead. The catalog entries themselves
// are pinned by editor-disabled.spec.ts.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const LAYOUT = readFileSync(join(HERE, "editor-layout.tsx"), "utf8");
const TAB_BAR = readFileSync(join(HERE, "tab-bar.tsx"), "utf8");

describe("DA-4 A30-02 browser tab gates", () => {
  it("editor-layout renders the marker for browser tabs in web mode", () => {
    expect(LAYOUT).toContain("const browserPanelDisabled = isEditorFeatureDisabled('browserPanel')");
    expect(LAYOUT).toContain('EditorDisabledNotice feature="browserPanel"');
  });

  it("handleNewBrowser returns early in web mode", () => {
    const start = LAYOUT.indexOf("const handleNewBrowser");
    expect(start).toBeGreaterThanOrEqual(0);
    const fn = LAYOUT.slice(start, LAYOUT.indexOf("const handleNewBrowserRef", start));
    expect(fn).toContain("if (browserPanelDisabled) return");
    expect(fn.indexOf("if (browserPanelDisabled) return")).toBeLessThan(fn.indexOf("addTab(tab)"));
  });

  it("tab-bar hides the New Browser entry in web mode", () => {
    expect(TAB_BAR).toContain("const browserPanelDisabled = isEditorFeatureDisabled('browserPanel')");
    expect(TAB_BAR).toContain("{browserPanelDisabled ? null : <DropdownMenuItem onClick={onNewBrowser}>");
  });
});
