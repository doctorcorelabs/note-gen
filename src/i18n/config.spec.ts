// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for toHtmlLangTag in config.ts (Fase 1, V3-23, D-6).
// Export templates follow the active locale; the mapped value must
// always be a safe BCP 47 language tag.
//
// Runner: Vitest, unit project (vitest run --project unit). Pure
// function only; no DOM, no network, no storage.

import { describe, expect, it } from "vitest";

import { toHtmlLangTag } from "./config";

describe("toHtmlLangTag", () => {
  it("maps the fork locales", () => {
    expect(toHtmlLangTag("en")).toBe("en");
    expect(toHtmlLangTag("zh")).toBe("zh-CN");
    expect(toHtmlLangTag("zh-CN")).toBe("zh-CN");
    expect(toHtmlLangTag("zh-cn")).toBe("zh-CN");
  });

  it("passes valid language and language-region tags through", () => {
    expect(toHtmlLangTag("ja")).toBe("ja");
    expect(toHtmlLangTag("de")).toBe("de");
    expect(toHtmlLangTag("pt-BR")).toBe("pt-BR");
    expect(toHtmlLangTag("pt-br")).toBe("pt-BR");
    expect(toHtmlLangTag("zh-TW")).toBe("zh-TW");
    expect(toHtmlLangTag("EN")).toBe("en");
  });

  it("falls back to en for anything that is not a language tag", () => {
    expect(toHtmlLangTag("")).toBe("en");
    expect(toHtmlLangTag(null)).toBe("en");
    expect(toHtmlLangTag(undefined)).toBe("en");
    expect(toHtmlLangTag("  ")).toBe("en");
    expect(toHtmlLangTag("zh-Hant")).toBe("en");
    expect(toHtmlLangTag("e")).toBe("en");
    expect(toHtmlLangTag("english")).toBe("en");
    expect(toHtmlLangTag("en_US")).toBe("en");
    expect(toHtmlLangTag("en-US-x")).toBe("en");
  });

  it("never returns markup or quote-breaking output", () => {
    expect(toHtmlLangTag('en"><script>alert(1)</script>')).toBe("en");
    expect(toHtmlLangTag("en\" onload=\"x")).toBe("en");
  });
});
