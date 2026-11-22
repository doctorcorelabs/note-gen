// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-4 (A30-01) static pins for the direct-route settings gates:
// every section the settings dialog gates must also self-gate its
// direct page route in web mode, so the dialog gate cannot be
// bypassed by URL. Runtime proof (marker renders, upstream page
// never mounts) belongs to the post-deploy browser rerun; these
// pins follow the model-card-check.spec.ts precedent.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const GATED_SECTIONS = [
  "canvas", "ai", "webSearch", "rag", "mcp", "skills", "plugins",
  "prompt", "memories", "template", "imageMethod", "audio", "imageHosting",
] as const;

function readPage(section: string): string {
  return readFileSync(join(HERE, section, "page.tsx"), "utf8");
}

describe("DA-4 A30-01 direct-route settings gates", () => {
  it("every gated section self-gates its direct route in web mode", () => {
    for (const section of GATED_SECTIONS) {
      const source = readPage(section);
      const wrapperStart = source.indexOf("export default function Gated");
      expect(wrapperStart, section).toBeGreaterThanOrEqual(0);
      const wrapper = source.slice(wrapperStart);
      expect(wrapper, section).toContain("if (!isTauri())");
      expect(wrapper, section).toContain(`<DisabledSettingSection section="${section}" />`);
    }
  });

  it("the upstream page stays in the tree behind each wrapper", () => {
    for (const section of GATED_SECTIONS) {
      const source = readPage(section);
      expect(source, section).not.toMatch(/export default function (?!Gated)/);
    }
  });

  it("mobile-prop wrappers forward the mobile prop", () => {
    for (const section of ["canvas", "ai", "webSearch", "plugins", "imageHosting"]) {
      const source = readPage(section);
      const wrapper = source.slice(source.indexOf("export default function Gated"));
      expect(wrapper, section).toContain("mobile={mobile}");
    }
  });

  it("sync and backup keep their own gates", () => {
    expect(readPage("sync")).toContain('<DisabledSettingSection section="sync" />');
    expect(readPage("backup")).toContain('<DisabledSettingSection section="backup" />');
  });

  it("the section list matches the dialog gate catalog", () => {
    const notice = readFileSync(join(HERE, "components", "setting-disabled-notice.tsx"), "utf8");
    for (const section of [...GATED_SECTIONS, "sync", "backup"]) {
      expect(notice, section).toContain(`'${section}'`);
    }
  });
});
