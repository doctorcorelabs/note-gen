// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for local-only skill recommendations (AD-15, gelombang 4).
// The loader reads only the pinned bundle config/recommended-skills.json;
// there is no Config Center fetch, no cache, and no network.
//
// Runner: Vitest, unit project (vitest run --project unit). Pure
// functions plus a pinned JSON import; no DOM, no network.

import { describe, expect, it } from "vitest";

import { getRecommendedSkillText, loadRecommendedSkills } from "./recommendations";

const EXPECTED_SKILL_IDS = [
  "humanizer-zh",
  "doc-coauthoring",
  "pdf",
  "docx",
  "article-writing",
  "professional-communication",
  "meeting-insights-analyzer",
  "copywriting",
];

describe("loadRecommendedSkills", () => {
  it("returns exactly the 8 pinned skills", async () => {
    const skills = await loadRecommendedSkills();
    expect(skills.map((skill) => skill.id).sort()).toEqual([...EXPECTED_SKILL_IDS].sort());
  });

  it("every skill is a validated record with an HTTPS source URL", async () => {
    const skills = await loadRecommendedSkills();
    for (const skill of skills) {
      expect(skill.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(skill.name.en).toBeTruthy();
      expect(skill.description.en).toBeTruthy();
      expect(skill.author.trim()).toBeTruthy();
      const url = new URL(skill.sourceUrl);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("github.com");
      expect(url.username).toBe("");
      expect(url.password).toBe("");
    }
  });
});

describe("getRecommendedSkillText", () => {
  it("prefers the exact locale, then the base locale, then English", () => {
    const text = { en: "English", zh: "Chinese", "zh-CN": "Simplified" };
    expect(getRecommendedSkillText(text, "zh-CN")).toBe("Simplified");
    expect(getRecommendedSkillText(text, "zh-TW")).toBe("Chinese");
    expect(getRecommendedSkillText(text, "fr")).toBe("English");
  });

  it("falls back to the first value, then to an empty string", () => {
    expect(getRecommendedSkillText({ de: "Deutsch" }, "fr")).toBe("Deutsch");
    expect(getRecommendedSkillText({}, "en")).toBe("");
  });
});
