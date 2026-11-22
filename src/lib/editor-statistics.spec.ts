// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Behavior specs for editorLeafText (UTANG-UJI-08 putaran 2): the
// visual-mode character basis must count the same leaf text the
// source basis (markdownToPlainText) counts - mermaid code and
// image alt - so the footer number no longer changes when
// switching modes. Measured on the hipospadia note the missing
// components were exactly 421 (two mermaid fences) + 36 (image
// alt) + 1 separator = 458 characters.
//
// Run: `pnpm vitest run --project unit src/lib/editor-statistics.spec.ts`
// from the repo root.

import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { editorLeafText, getEditorStatistics, markdownToPlainText } from "./editor-statistics";

describe("editorLeafText", () => {
  it("counts mermaid code from attrs.code", () => {
    expect(
      editorLeafText({
        type: { name: "mermaidDiagram" },
        attrs: { code: "graph TD; A-->B" },
      }),
    ).toBe("graph TD; A-->B");
  });

  it("counts image alt from attrs.alt", () => {
    expect(
      editorLeafText({
        type: { name: "image" },
        attrs: { alt: "diagram hipospadia" },
      }),
    ).toBe("diagram hipospadia");
  });

  it("counts every other leaf as empty", () => {
    expect(editorLeafText({ type: { name: "horizontalRule" }, attrs: {} })).toBe("");
  });

  it("counts inline math with its $ delimiters (STAT-01)", () => {
    expect(
      editorLeafText({
        type: { name: "inlineMath" },
        attrs: { latex: "x^2" },
      }),
    ).toBe("$x^2$");
  });

  it("counts block math with its $$ delimiters (STAT-01)", () => {
    expect(
      editorLeafText({
        type: { name: "blockMath" },
        attrs: { latex: "x^2" },
      }),
    ).toBe("$$\nx^2\n$$");
  });

  it("counts hardBreak as a newline (STAT-02)", () => {
    expect(editorLeafText({ type: { name: "hardBreak" } })).toBe("\n");
  });

  it("tolerates missing or non-string attributes", () => {
    expect(editorLeafText({ type: { name: "mermaidDiagram" } })).toBe("");
    expect(
      editorLeafText({ type: { name: "image" }, attrs: { alt: 42 } }),
    ).toBe("");
    expect(editorLeafText({ type: { name: "inlineMath" } })).toBe("");
    expect(
      editorLeafText({ type: { name: "blockMath" }, attrs: { latex: 42 } }),
    ).toBe("");
  });

  it("feeds textBetween so the visual basis includes leaf text", () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        text: { group: "inline" },
        image: {
          group: "inline",
          inline: true,
          atom: true,
          attrs: { alt: { default: "" } },
        },
        mermaidDiagram: {
          group: "block",
          atom: true,
          attrs: { code: { default: "" } },
        },
      },
    });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("halo "),
        schema.node("image", { alt: "gambar" }),
      ]),
      schema.node("mermaidDiagram", { code: "graph TD" }),
    ]);

    const withoutLeafText = doc.textBetween(0, doc.content.size, "\n");
    const withLeafText = doc.textBetween(
      0,
      doc.content.size,
      "\n",
      editorLeafText,
    );

    expect(withoutLeafText).toBe("halo ");
    expect(withLeafText).toBe("halo gambar\ngraph TD");
    expect(getEditorStatistics(withLeafText).characters).toBe(
      getEditorStatistics("halo gambar\ngraph TD").characters,
    );
  });
});

describe("getEditorStatistics", () => {
  it("trims before counting", () => {
    expect(getEditorStatistics("  halo  ").characters).toBe(4);
    expect(getEditorStatistics("   ").characters).toBe(0);
    expect(getEditorStatistics("").characters).toBe(0);
  });

  it("counts code points, not UTF-16 units", () => {
    expect(getEditorStatistics("a\u{1F600}b").characters).toBe(3);
  });

  it("readingMinutes has a floor of 1 for non-empty text", () => {
    expect(getEditorStatistics("halo").readingMinutes).toBe(1);
    expect(getEditorStatistics("").readingMinutes).toBe(0);
  });
});

// Basis parity (STAT-11): for each residual class of STAT-01..03 the
// visual basis (textBetween + editorLeafText) and the source basis
// (markdownToPlainText) must produce the same character count, so the
// footer number does not change when switching modes.
describe("visual/source basis parity", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "inline*" },
      text: { group: "inline" },
      hardBreak: { group: "inline", inline: true, atom: true },
      inlineMath: {
        group: "inline",
        inline: true,
        atom: true,
        attrs: { latex: { default: "" } },
      },
      blockMath: {
        group: "block",
        atom: true,
        attrs: { latex: { default: "" } },
      },
    },
  });

  const visualCharacters = (doc: ReturnType<typeof schema.node>) =>
    getEditorStatistics(
      doc.textBetween(0, doc.content.size, "\n", editorLeafText),
    ).characters;
  const sourceCharacters = (markdown: string) =>
    getEditorStatistics(markdownToPlainText(markdown)).characters;

  it("inline math (STAT-01)", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("rumus "),
        schema.node("inlineMath", { latex: "x^2" }),
        schema.text(" selesai"),
      ]),
    ]);
    expect(visualCharacters(doc)).toBe(sourceCharacters("rumus $x^2$ selesai"));
  });

  it("block math (STAT-01)", () => {
    const doc = schema.node("doc", null, [
      schema.node("blockMath", { latex: "x^2" }),
    ]);
    expect(visualCharacters(doc)).toBe(sourceCharacters("$$\nx^2\n$$"));
  });

  it("hardBreak (STAT-02)", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("a"),
        schema.node("hardBreak"),
        schema.text("b"),
      ]),
    ]);
    expect(visualCharacters(doc)).toBe(sourceCharacters("a  \nb"));
  });

  it("extra empty paragraph (STAT-03)", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("a")]),
      schema.node("paragraph", null, []),
      schema.node("paragraph", null, [schema.text("b")]),
    ]);
    expect(visualCharacters(doc)).toBe(sourceCharacters("a\n\n\nb"));
  });
});
