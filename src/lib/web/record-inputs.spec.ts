// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Vitest-style suite for the inbox input builders
// (record-inputs.ts). Runs in the Vitest leg of `pnpm test:unit`
// and is listed in VITEST_SPECS in scripts/run-adapter-tests.mjs.

import { describe, expect, it } from "vitest";

import {
  buildFileCreateBody,
  buildImageCreateBody,
  buildLinkCreateBody,
  buildListQuery,
  buildTextCreateBody,
  buildTodoContent,
  buildTodoCreateBody,
  createBodyMatchesRecord,
  hasNoExtractedContent,
  makeSourceId,
  normalizeLinkUrl,
  parseTodoContent,
  recordAssetUrl,
  recordDisplayTitle,
  resolveCreateTags,
  timePresetToRange,
} from "./record-inputs";

describe("todo content", () => {
  it("parses the four-field JSON object", () => {
    expect(
      parseTodoContent(
        JSON.stringify({
          title: "Buy milk",
          description: "Oat milk",
          priority: "high",
          completed: true,
        }),
        "fallback",
      ),
    ).toEqual({
      title: "Buy milk",
      description: "Oat milk",
      priority: "high",
      completed: true,
    });
  });

  it("falls back tolerantly on invalid JSON", () => {
    expect(parseTodoContent("not json", "From desc")).toEqual({
      title: "From desc",
      description: "",
      priority: "medium",
      completed: false,
    });
    expect(parseTodoContent("", "")).toEqual({
      title: "",
      description: "",
      priority: "medium",
      completed: false,
    });
  });

  it("defaults missing todo fields", () => {
    expect(
      parseTodoContent(JSON.stringify({ title: "  T  " }), ""),
    ).toEqual({
      title: "T",
      description: "",
      priority: "medium",
      completed: false,
    });
  });

  it("builds exactly the four contract keys", () => {
    const parsed = JSON.parse(buildTodoContent({ title: "T" })) as Record<
      string,
      unknown
    >;
    expect(Object.keys(parsed).sort()).toEqual([
      "completed",
      "description",
      "priority",
      "title",
    ]);
    expect(parsed).toEqual({
      title: "T",
      description: "",
      priority: "medium",
      completed: false,
    });
  });

  it("rejects an empty todo title", () => {
    expect(() => buildTodoContent({ title: "   " })).toThrow();
  });
});

describe("create bodies", () => {
  it("builds a text record with content equal to desc and no url", () => {
    const body = buildTextCreateBody("hello", {}, "web:paste:1");
    expect(body).toEqual({
      type: "text",
      content: "hello",
      desc: "hello",
      sourceId: "web:paste:1",
    });
    expect(buildTextCreateBody("x", {})).not.toHaveProperty("url");
    expect(() => buildTextCreateBody("  ", {})).toThrow();
  });

  it("builds a link record saved as entered, without fetching", () => {
    const body = buildLinkCreateBody("https://example.com/a", {});
    expect(body.content).toBe("");
    expect(body.desc).toBe("https://example.com/a");
    expect(body.url).toBe("https://example.com/a");
  });

  it("adds only a missing scheme to a link URL", () => {
    expect(normalizeLinkUrl("example.com/a")).toBe(
      "https://example.com/a",
    );
    expect(normalizeLinkUrl("http://example.com")).toBe(
      "http://example.com",
    );
    expect(() => normalizeLinkUrl("ftp://example.com")).toThrow();
    expect(() => normalizeLinkUrl("not a url with spaces")).toThrow();
    expect(() => normalizeLinkUrl("")).toThrow();
  });

  it("builds image and file records around an asset key", () => {
    expect(buildImageCreateBody("assets/k1", "cap", {})).toEqual({
      type: "image",
      content: "",
      desc: "cap",
      url: "assets/k1",
    });
    expect(
      buildFileCreateBody("assets/k2", "report.pdf", undefined, {}),
    ).toEqual({
      type: "file",
      content: "",
      desc: "report.pdf",
      url: "assets/k2",
    });
    expect(
      buildFileCreateBody("assets/k2", "report.pdf", "Q3 report", {}).desc,
    ).toBe("Q3 report");
    expect(() => buildImageCreateBody("", "", {})).toThrow();
    expect(() => buildFileCreateBody("", "f", undefined, {})).toThrow();
  });

  it("builds a todo record with desc equal to the title", () => {
    const body = buildTodoCreateBody(
      { title: "Ship it", description: "d", priority: "low" },
      {},
    );
    expect(body.type).toBe("todo");
    expect(body.desc).toBe("Ship it");
    expect(body).not.toHaveProperty("url");
    expect(parseTodoContent(body.content, "")).toEqual({
      title: "Ship it",
      description: "d",
      priority: "low",
      completed: false,
    });
  });

  it("resolves tags with the first tag primary, or none at all", () => {
    expect(resolveCreateTags({})).toEqual({});
    expect(resolveCreateTags({ tagIds: [] })).toEqual({});
    expect(resolveCreateTags({ tagIds: [3, 7, 3] })).toEqual({
      tagId: 3,
      tagIds: [3, 7],
    });
  });

  it("builds prefixed sourceIds that differ per action", () => {
    const a = makeSourceId("paste", "same text");
    const b = makeSourceId("paste", "same text");
    expect(a.startsWith("web:paste:")).toBe(true);
    expect(b.startsWith("web:paste:")).toBe(true);
    expect(a).not.toBe(b);
    expect(makeSourceId("upload", "x").startsWith("web:upload:")).toBe(
      true,
    );
  });
});

describe("list query (A-12)", () => {
  it("applies defaults", () => {
    expect(buildListQuery({})).toEqual({
      status: "active",
      sort: "created_desc",
      limit: 50,
    });
  });

  it("rejects tagId combined with tagIds", () => {
    expect(() =>
      buildListQuery({ tagId: 3, tagIds: [3] }),
    ).toThrow();
    expect(buildListQuery({ tagId: "all", tagIds: [3] }).tagIds).toBe(
      "3",
    );
  });

  it("rejects filters combined with trash", () => {
    expect(() => buildListQuery({ status: "trash", q: "x" })).toThrow();
    expect(() =>
      buildListQuery({ status: "trash", types: ["text"] }),
    ).toThrow();
    expect(() =>
      buildListQuery({
        status: "trash",
        tagRules: { include: ["Idea"], exclude: [], match: "all" },
      }),
    ).toThrow();
    expect(
      buildListQuery({ status: "trash", sort: "type" }, "c1"),
    ).toEqual({
      status: "trash",
      sort: "type",
      limit: 50,
      cursor: "c1",
    });
  });

  it("encodes tag rules, types, q, and ranges", () => {
    expect(
      buildListQuery({
        tagRules: {
          include: ["Idea", "Idea/Music", "Idea"],
          exclude: ["Archive"],
          match: "any",
        },
        types: ["text", "todo"],
        q: "  heart  ",
        createdAfter: 10,
        createdBefore: 20,
        sort: "type",
        limit: 500,
      }),
    ).toEqual({
      status: "active",
      tagInclude: "Idea,Idea/Music",
      tagMatch: "any",
      tagExclude: "Archive",
      type: "text,todo",
      q: "heart",
      createdAfter: 10,
      createdBefore: 20,
      sort: "type",
      limit: 200,
    });
  });

  it("omits an empty q and clamps the limit", () => {
    const query = buildListQuery({ q: "   ", limit: 0 });
    expect(query).not.toHaveProperty("q");
    expect(query.limit).toBe(1);
  });
});

describe("time presets", () => {
  it("returns no range for all", () => {
    expect(timePresetToRange("all")).toEqual({});
  });

  it("spans local midnight to midnight for today", () => {
    const now = new Date(2026, 10, 16, 15, 30, 0);
    const range = timePresetToRange("today", now);
    const start = new Date(2026, 10, 16, 0, 0, 0, 0).getTime();
    const end = new Date(2026, 10, 17, 0, 0, 0, 0).getTime();
    expect(range.createdAfter).toBe(start);
    expect(range.createdBefore).toBe(end - 1);
  });

  it("spans back N days for last7Days and last30Days", () => {
    const now = new Date(2026, 10, 16, 12, 0, 0);
    const seven = timePresetToRange("last7Days", now);
    expect(seven.createdBefore).toBe(now.getTime());
    expect(seven.createdAfter).toBe(
      now.getTime() - 7 * 24 * 60 * 60 * 1000,
    );
    const thirty = timePresetToRange("last30Days", now);
    expect(thirty.createdAfter).toBe(
      now.getTime() - 30 * 24 * 60 * 60 * 1000,
    );
  });
});

describe("display helpers", () => {
  it("prefers desc, then content, then file name for the title", () => {
    expect(
      recordDisplayTitle({ desc: "D", content: "C", type: "text" }),
    ).toBe("D");
    expect(
      recordDisplayTitle({ desc: "", content: "C", type: "text" }),
    ).toBe("C");
    expect(
      recordDisplayTitle({
        desc: "",
        content: "",
        fileName: "a.png",
        type: "image",
      }),
    ).toBe("a.png");
  });

  it("flags empty enrichment content only for enrichable types", () => {
    expect(hasNoExtractedContent({ type: "link", content: "" })).toBe(
      true,
    );
    expect(
      hasNoExtractedContent({ type: "image", content: "" }),
    ).toBe(true);
    expect(hasNoExtractedContent({ type: "file", content: "" })).toBe(
      true,
    );
    expect(
      hasNoExtractedContent({ type: "link", content: "x" }),
    ).toBe(false);
    expect(hasNoExtractedContent({ type: "text", content: "" })).toBe(
      false,
    );
    expect(hasNoExtractedContent({ type: "todo", content: "" })).toBe(
      false,
    );
  });

  it("fully encodes asset keys in serve URLs", () => {
    expect(recordAssetUrl("assets/a/b.png")).toBe(
      "/api/assets/assets%2Fa%2Fb.png",
    );
  });
});

describe("createBodyMatchesRecord (F02-09)", () => {
  const record = { content: "first", desc: "first", url: "" };

  it("matches an identical retry payload", () => {
    expect(
      createBodyMatchesRecord({ type: "text", content: "first", desc: "first" }, record),
    ).toBe(true);
  });

  it("rejects edited text after the first save", () => {
    expect(
      createBodyMatchesRecord({ type: "text", content: "edited", desc: "edited" }, record),
    ).toBe(false);
  });

  it("rejects an edited link url", () => {
    expect(
      createBodyMatchesRecord(
        { type: "link", url: "https://example.com/new" },
        { content: "", desc: "", url: "https://example.com/old" },
      ),
    ).toBe(false);
  });

  it("ignores fields the body does not carry", () => {
    expect(createBodyMatchesRecord({ type: "text", content: "first" }, record)).toBe(true);
  });
});
