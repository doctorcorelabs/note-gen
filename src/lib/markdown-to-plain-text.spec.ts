// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for markdownToPlainText (STAT-11): the source-mode
// character basis must reconstruct the same text the visual basis
// (doc.textBetween + editorLeafText) counts, so the footer number
// does not change when switching modes. Covers the residual classes
// STAT-03 (empty-paragraph placeholders; surplus blank lines
// collapse, STAT2/AD-962), STAT-04 (task list checkbox syntax),
// STAT-05 (empty trailing table cells), plus the classes that
// already had parity (fence contents, image alt, hardbreak).
//
// Run: `pnpm vitest run --project unit src/lib/markdown-to-plain-text.spec.ts`
// from the repo root.

import { describe, expect, it } from "vitest";
import { markdownToPlainText } from "./markdown-to-plain-text";
import { getEditorStatistics } from "./editor-statistics";

const characters = (markdown: string) =>
  getEditorStatistics(markdownToPlainText(markdown)).characters;

describe("markdownToPlainText", () => {
  it("plain paragraphs, headings and lists", () => {
    expect(markdownToPlainText("halo dunia")).toBe("halo dunia");
    expect(markdownToPlainText("# Judul\n\nisi")).toBe("Judul\nisi");
    expect(markdownToPlainText("- satu\n- dua")).toBe("satu\ndua");
  });

  it("hardbreak and softbreak become newlines", () => {
    expect(markdownToPlainText("a  \nb")).toBe("a\nb");
    expect(markdownToPlainText("a\nb")).toBe("a\nb");
  });

  it("fence contents stay verbatim, including internal blank lines", () => {
    expect(markdownToPlainText("teks\n\n```\nkode\n\nakhir\n```\n\npenutup")).toBe(
      "teks\nkode\n\nakhir\npenutup",
    );
  });

  it("image alt text counts (markdown and HTML)", () => {
    expect(markdownToPlainText("![diagram](x.png)")).toBe("diagram");
    expect(markdownToPlainText('<img alt="diagram" src="x.png">')).toBe("diagram");
  });

  it("HTML <br> becomes a newline", () => {
    expect(markdownToPlainText("a<br>b")).toBe("a\nb");
  });

  it("surplus blank lines collapse like the visual parser (STAT2)", () => {
    // Blank surplus produces no empty-paragraph node when loaded,
    // so the source basis must not reconstruct separators for it.
    expect(markdownToPlainText("a\n\n\nb")).toBe("a\nb");
    expect(markdownToPlainText("a\n\nb")).toBe("a\nb");
    expect(markdownToPlainText("a\n\n\n\nb")).toBe("a\nb");
  });

  it("surplus blank lines around headings, lists and fences (STAT2)", () => {
    expect(markdownToPlainText("# Judul\n\n\nisi")).toBe("Judul\nisi");
    expect(markdownToPlainText("- satu\n- dua\n\n\npenutup")).toBe(
      "satu\ndua\npenutup",
    );
    expect(markdownToPlainText("> kutip\n\n\npenutup")).toBe(
      "kutip\npenutup",
    );
    // Fence gaps from serializer wrapping must not add newlines
    // (the final newline below is the fence content's own).
    expect(
      markdownToPlainText("```\nkode\n```\n\n\n\n```\nlain\n```"),
    ).toBe("kode\nlain\n");
    expect(
      characters("```\nkode\n```\n\n\n\n```\nlain\n```"),
    ).toBe(characters("kode\nlain"));
  });

  it("empty-paragraph placeholders count as separators only (STAT2)", () => {
    // Visual [a, empty, b] counts "a\n\nb" (4). The placeholder
    // character itself must not be counted.
    expect(markdownToPlainText("a\n\n&nbsp;\n\nb")).toBe("a\n\nb");
    expect(characters("a\n\n&nbsp;\n\nb")).toBe(4);
    expect(markdownToPlainText("a\n\n&nbsp;\n\n&nbsp;\n\nb")).toBe(
      "a\n\n\nb",
    );
    expect(characters("a\n\n&nbsp;\n\n&nbsp;\n\nb")).toBe(5);
    expect(markdownToPlainText("a\n\n&#32;\n\nb")).toBe("a\n\nb");
  });

  it("placeholders at the document edges trim like the visual basis (STAT2)", () => {
    expect(characters("&nbsp;\n\na")).toBe(1);
    expect(characters("a\n\n&nbsp;")).toBe(1);
    expect(characters("&nbsp;")).toBe(0);
  });

  it("a non-breaking space inside real text still counts (STAT2)", () => {
    expect(characters("a&nbsp;b")).toBe(3);
    expect(characters("a\u00A0b")).toBe(3);
  });

  it("no surplus newline after a full table (STAT2 regression)", () => {
    // The removed surplus reconstruction counted table rows as
    // blank lines because table cell inline tokens carry no map.
    const markdown =
      "```\nkode\n```\n\n| a | b |\n| --- | --- |\n| c | d |\n\n![alt](x.png)";
    expect(markdownToPlainText(markdown)).toBe("kode\na\tb\nc\td\nalt");
  });

  it("task list checkbox syntax is not content (STAT-04)", () => {
    expect(markdownToPlainText("- [ ] tugas\n- [x] selesai")).toBe(
      "tugas\nselesai",
    );
    expect(markdownToPlainText("- [X] selesai")).toBe("selesai");
  });

  it("a literal [ ] at the start of a plain paragraph is kept (STAT-04)", () => {
    expect(markdownToPlainText("[ ] bukan task")).toBe("[ ] bukan task");
  });

  it("nested task items strip per item (STAT-04)", () => {
    expect(markdownToPlainText("- [ ] luar\n  - [x] dalam")).toBe(
      "luar\ndalam",
    );
  });

  it("full table cells keep one separator per cell boundary", () => {
    expect(
      markdownToPlainText("| a | b |\n| --- | --- |\n| c | d |"),
    ).toBe("a\tb\nc\td");
  });

  it("empty trailing table cells keep their separator (STAT-05)", () => {
    const markdown = "| a |  |\n| --- | --- |\n|  | d |";
    // Visual basis for cells [a, "", "", d] is 5 characters
    // (two cell texts + three separators).
    expect(characters(markdown)).toBe(5);
    expect(markdownToPlainText(markdown)).toBe("a\t\n\td");
  });

  it("single-cell rows gain no extra tab (STAT-05)", () => {
    expect(markdownToPlainText("| a |\n| --- |\n| b |")).toBe("a\nb");
  });

  it("table at the end of the document (STAT-05)", () => {
    const markdown = "awal\n\n| a |  |\n| --- | --- |";
    expect(characters(markdown)).toBe(characters("awal\n\na\t"));
  });
});
