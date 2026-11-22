// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-4 (WIKI-18-01) static pins for the folder wiki write
// controls: in web mode the source toggle, organize button,
// enabled switch, and pause/resume button must be replaced by
// the disabled marker, because every write kind behind them is a
// Phase 2 stub. Read statistics stay visible. There is no
// component render harness in this repo, so these pins follow
// the model-card-check.spec.ts precedent; runtime proof belongs
// to the post-deploy browser rerun.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const FOLDER_STATS = readFileSync(join(HERE, "folder-stats.tsx"), "utf8");
const WIKI_FOLDER_VIEW = readFileSync(join(HERE, "wiki-folder-view.tsx"), "utf8");

describe("DA-4 WIKI-18-01 folder wiki write gates", () => {
  it("folder-stats replaces the source toggle with the marker in web mode", () => {
    expect(FOLDER_STATS).toContain("const wikiDisabled = isEditorFeatureDisabled('wiki')");
    expect(FOLDER_STATS).toContain('{wikiDisabled ? <EditorDisabledNotice feature="wiki" /> : <ItemGroup>');
  });

  it("folder-stats hides the organize button in web mode but keeps read stats", () => {
    expect(FOLDER_STATS).toContain("{wikiDisabled ? null : <div");
    expect(FOLDER_STATS).toContain("wikiReady");
  });

  it("wiki-folder-view drops the enabled switch and shows the marker in web mode", () => {
    expect(WIKI_FOLDER_VIEW).toContain("const wikiDisabled = isEditorFeatureDisabled('wiki')");
    expect(WIKI_FOLDER_VIEW).toContain("actions={wikiDisabled ? undefined : <Switch");
    expect(WIKI_FOLDER_VIEW).toContain('{wikiDisabled ? <EditorDisabledNotice feature="wiki" /> : data && enabled ? <>');
  });
});
