// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Static pins for F-10: wiki data loads run under a deadline race so
// a hung read reaches the terminal error state instead of loading
// forever. The hook itself needs a React harness the repo does not
// have; runtime proof is owed to the browser rerun.
//
// Run: `pnpm vitest run --project unit src/components/wiki/use-wiki-data.spec.ts`
// from the repo root.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./use-wiki-data.ts", import.meta.url), "utf8");

describe("useWikiData deadline (F-10)", () => {
  it("races the load chain against a deadline", () => {
    expect(source).toContain("Promise.race([load(), wikiDataDeadline()])");
  });

  it("deadline rejects with a named timeout error", () => {
    expect(source).toContain("WIKI_DATA_TIMEOUT");
    expect(source).toContain("WIKI_DATA_DEADLINE_MS");
  });
});
