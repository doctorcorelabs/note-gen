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
import { editorLeafText, getEditorStatistics } from "./editor-statistics";

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
    expect(editorLeafText({ type: { name: "hardBreak" } })).toBe("");
  });

  it("tolerates missing or non-string attributes", () => {
    expect(editorLeafText({ type: { name: "mermaidDiagram" } })).toBe("");
    expect(
      editorLeafText({ type: { name: "image" }, attrs: { alt: 42 } }),
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
