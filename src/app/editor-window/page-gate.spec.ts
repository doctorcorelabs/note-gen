// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-4 (A30-06) static pins for the editor-window effect gates:
// no session read, file read, store mutation, or close-handler
// registration in web mode, where the render is already gated.
// The onCloseRequested registration was the one real unhandled
// rejection of this cluster. Runtime proof belongs to the
// post-deploy browser rerun.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const SOURCE = readFileSync(join(HERE, "page.tsx"), "utf8");

describe("DA-4 A30-06 editor-window effect gates", () => {
  it("every effect returns early in web mode", () => {
    const gates = SOURCE.match(/if \(isEditorFeatureDisabled\('editorWindow'\)\) return/g) ?? [];
    expect(gates.length).toBeGreaterThanOrEqual(4);
  });

  it("the session effect is gated before any session or store work", () => {
    const effect = SOURCE.slice(SOURCE.indexOf("const id = new URLSearchParams"));
    const gated = SOURCE.slice(0, SOURCE.indexOf("const id = new URLSearchParams"));
    expect(gated).toContain("if (isEditorFeatureDisabled('editorWindow')) return");
    expect(effect).toContain("loadEditorWindowSession");
  });

  it("the render gate stays", () => {
    expect(SOURCE).toContain('EditorDisabledNotice feature="editorWindow"');
  });
});
