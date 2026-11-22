// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-5 (STAT-07) static pin: the source-mode statistics initializer
// must count synchronously at mount instead of starting from an
// empty state, so a note opened directly in source mode never
// flashes "0 characters" while the debounced effect is pending.
// The component graph is too heavy to mount here, so this pin
// follows the model-card-check.spec.ts precedent. Runtime proof
// belongs to the post-deploy browser rerun.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "word-count.tsx"), "utf8");

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = SOURCE.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf(endMarker, start + startMarker.length);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("DA-5 STAT-07 source statistics initializer pin", () => {
  it("the useState initializer counts source markdown synchronously", () => {
    const initializer = sliceBetween(
      "useState<EditorStatistics>(() => (",
      "\n  useEffect",
    );
    expect(initializer).toContain(
      "getEditorStatistics(markdownToPlainText(sourceMarkdown))",
    );
    expect(initializer).not.toContain("EMPTY_STATISTICS");
  });
});
