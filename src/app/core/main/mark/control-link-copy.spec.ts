// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-4 (F2 area 21) static pins for the Record Link dialog copy:
// in web mode the dialog must not promise automatic page crawling
// that cannot happen there. Save behavior is unchanged.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const SOURCE = readFileSync(join(HERE, "control-link.tsx"), "utf8");
const EN = JSON.parse(readFileSync(join(HERE, "..", "..", "..", "..", "..", "messages", "en.json"), "utf8"));
const ZH = JSON.parse(readFileSync(join(HERE, "..", "..", "..", "..", "..", "messages", "zh.json"), "utf8"));

describe("DA-4 F2 area 21 Record Link web copy", () => {
  it("both dialog variants pick the copy by platform mode", () => {
    const picks = SOURCE.match(/isTauri\(\) \? t\('record\.mark\.link\.description'\) : t\('record\.mark\.link\.descriptionWeb'\)/g) ?? [];
    expect(picks).toHaveLength(2);
  });

  it("no crawl promise remains as a literal fallback", () => {
    expect(SOURCE).not.toContain("automatically crawl the page content");
  });

  it("the web copy exists in both catalogs and promises no crawl", () => {
    expect(EN.record.mark.link.descriptionWeb).toBeTruthy();
    expect(ZH.record.mark.link.descriptionWeb).toBeTruthy();
    expect(EN.record.mark.link.descriptionWeb).not.toContain("crawl");
  });
});
