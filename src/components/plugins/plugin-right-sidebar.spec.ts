// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-4 (A23-01) static pins for the AI chat mount gate: in web
// mode the right sidebar must render the disabled panel instead
// of mounting Chat, whose store init rejects there. Runtime proof
// belongs to the post-deploy browser rerun.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const SOURCE = readFileSync(join(HERE, "plugin-right-sidebar.tsx"), "utf8");

describe("DA-4 A23-01 AI chat mount gate", () => {
  it("gates the Chat mount on the ai-chat feature flag", () => {
    expect(SOURCE).toContain("useFeatureFlag('ai-chat')");
  });

  it("renders the disabled panel at both Chat sites while the flag is off", () => {
    expect(SOURCE).toContain("return aiChatEnabled ? <Chat /> : <AiChatDisabledPanel />");
    expect(SOURCE).toContain("{aiChatEnabled ? <Chat /> : <AiChatDisabledPanel />}");
  });

  it("keeps the Chat import so the surface returns when the flag turns on", () => {
    expect(SOURCE).toContain("import Chat from '@/app/core/main/chat'");
  });
});
