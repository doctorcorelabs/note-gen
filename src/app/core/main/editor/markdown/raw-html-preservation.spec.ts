// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Tokenizer-level preservation specs for S-P0-19 / DA10-F01 (generic
// frontmatter) and DA10-F02 (raw HTML blocks and comments). These specs
// run in Node without a DOM: they cover the block tokenizers only, not
// the editor view or the full MarkdownManager round trip.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { describe, expect, it } from "vitest";

import {
  matchRawHtmlBlock,
  RAW_HTML_NODE_NAME,
  rawHtmlTokenizer,
} from "./raw-html-tokenizer";
import {
  WIKI_METADATA_NODE_NAME,
  wikiMetadataTokenizer,
} from "./wiki-metadata-tokenizer";

const HELPERS = {
  inlineTokens: () => [],
  blockTokens: () => [],
};

function tokenizeWiki(source: string) {
  return wikiMetadataTokenizer.tokenize(source, [], HELPERS);
}

function tokenizeRawHtml(source: string) {
  return rawHtmlTokenizer.tokenize(source, [], HELPERS);
}

function wikiMarker(): string {
  return `<!-- notegen-wiki:${"a".repeat(64)}:section-a:start -->`;
}

describe("generic frontmatter preservation (S-P0-19 / DA10-F01)", () => {
  it("preserves generic YAML frontmatter as one opaque token", () => {
    const token = tokenizeWiki("---\ntitle: Catatan\ntags: [a, b]\n---\n\n# Hello\n");
    expect(token?.type).toBe(WIKI_METADATA_NODE_NAME);
    expect(token?.raw).toBe("---\ntitle: Catatan\ntags: [a, b]\n---");
  });

  it("preserves a YAML comment line inside frontmatter", () => {
    const token = tokenizeWiki("---\ntitle: Catatan\n# komentar yaml\n---\n\nText\n");
    expect(token?.raw).toBe("---\ntitle: Catatan\n# komentar yaml\n---");
  });

  it("preserves a multi-line YAML value", () => {
    const token = tokenizeWiki("---\ndescription: |\n  baris satu\n  baris dua\n---\n\nText\n");
    expect(token?.raw).toBe("---\ndescription: |\n  baris satu\n  baris dua\n---");
  });

  it("still preserves a wiki-origin header", () => {
    const token = tokenizeWiki("---\nnotegen-wiki-origin: abc123\n---\n\nText\n");
    expect(token?.raw).toBe("---\nnotegen-wiki-origin: abc123\n---");
  });

  it("does not claim a leading fence without a closing fence", () => {
    expect(tokenizeWiki("---\ntitle: Catatan\n\n# Hello\n")).toBeUndefined();
  });

  it("does not claim a plain document", () => {
    expect(tokenizeWiki("# Hello\n\nText\n")).toBeUndefined();
  });

  it("still preserves a wiki section marker", () => {
    const marker = wikiMarker();
    const token = tokenizeWiki(`${marker}\n`);
    expect(token?.raw).toBe(marker);
  });

  it("does not claim frontmatter that is not at the document start", () => {
    expect(tokenizeWiki("# Title\n---\ntitle: x\n---\n")).toBeUndefined();
  });

  it("preserves CRLF frontmatter byte for byte", () => {
    const token = tokenizeWiki("---\r\ntitle: Catatan\r\n---\r\n\r\nText\r\n");
    expect(token?.raw).toBe("---\r\ntitle: Catatan\r\n---");
  });

  it("preserves BOM frontmatter byte for byte", () => {
    const token = tokenizeWiki("\uFEFF---\ntitle: x\n---\n\nText\n");
    expect(token?.raw).toBe("\uFEFF---\ntitle: x\n---");
  });
});

describe("raw HTML preservation (DA10-F02)", () => {
  it("uses the rawHtml node name", () => {
    expect(RAW_HTML_NODE_NAME).toBe("rawHtml");
  });

  it("preserves an HTML comment as one opaque token", () => {
    const token = tokenizeRawHtml("<!-- TODO -->\n\nText\n");
    expect(token?.type).toBe(RAW_HTML_NODE_NAME);
    expect(token?.raw).toBe("<!-- TODO -->");
  });

  it("preserves a multi-line HTML comment", () => {
    const token = tokenizeRawHtml("<!--\nline one\nline two\n-->\n\nText\n");
    expect(token?.raw).toBe("<!--\nline one\nline two\n-->");
  });

  it("does not claim an unclosed comment", () => {
    expect(tokenizeRawHtml("<!-- TODO\n\nText\n")).toBeUndefined();
  });

  it("preserves a div block until the blank line", () => {
    const token = tokenizeRawHtml('<div class="note">\nhello\n</div>\n\nText\n');
    expect(token?.raw).toBe('<div class="note">\nhello\n</div>');
  });

  it("preserves a details block", () => {
    const token = tokenizeRawHtml("<details>\n<summary>Info</summary>\nBody\n</details>\n\nText\n");
    expect(token?.raw).toBe("<details>\n<summary>Info</summary>\nBody\n</details>");
  });

  it("defers a wiki section marker to the wiki tokenizer", () => {
    const marker = wikiMarker();
    expect(tokenizeRawHtml(`${marker}\n`)).toBeUndefined();
    expect(tokenizeWiki(`${marker}\n`)?.raw).toBe(marker);
  });

  it("defers frontmatter to the wiki tokenizer", () => {
    const source = "---\ntitle: x\n---\n\nText\n";
    expect(tokenizeRawHtml(source)).toBeUndefined();
    expect(tokenizeWiki(source)?.raw).toBe("---\ntitle: x\n---");
  });

  it("does not claim a paragraph starting with inline kbd markup", () => {
    expect(tokenizeRawHtml("<kbd>Ctrl</kbd> + C saves\n")).toBeUndefined();
  });

  it("does not claim a paragraph starting with an inline span", () => {
    expect(tokenizeRawHtml('<span class="x">hi</span> text\n')).toBeUndefined();
  });

  it("does not claim a plain paragraph", () => {
    expect(tokenizeRawHtml("Just some text\n")).toBeUndefined();
  });

  it("preserves a script block across blank lines until its closing tag", () => {
    const token = tokenizeRawHtml("<script>\nconst a = 1\n\nconst b = 2\n</script>\n\nText\n");
    expect(token?.raw).toBe("<script>\nconst a = 1\n\nconst b = 2\n</script>");
  });

  it("falls back to the blank line for an unclosed script block", () => {
    const token = tokenizeRawHtml("<script>\nconst a = 1\n\nText\n");
    expect(token?.raw).toBe("<script>\nconst a = 1");
  });

  it("preserves a doctype declaration", () => {
    expect(tokenizeRawHtml("<!DOCTYPE html>\n\nText\n")?.raw).toBe("<!DOCTYPE html>");
  });

  it("preserves a CDATA section", () => {
    expect(tokenizeRawHtml("<![CDATA[some <b> data]]>\n\nText\n")?.raw).toBe("<![CDATA[some <b> data]]>");
  });

  it("preserves a processing instruction", () => {
    expect(tokenizeRawHtml("<?php echo 1; ?>\n\nText\n")?.raw).toBe("<?php echo 1; ?>");
  });

  it("preserves a stray closing tag", () => {
    expect(tokenizeRawHtml("</div>\n\nText\n")?.raw).toBe("</div>");
  });

  it("preserves a CRLF div block byte for byte", () => {
    const token = tokenizeRawHtml("<div>\r\nhello\r\n</div>\r\n\r\nText\r\n");
    expect(token?.raw).toBe("<div>\r\nhello\r\n</div>");
  });

  it("does not claim a lone br tag", () => {
    expect(matchRawHtmlBlock("<br/>\n\nText")).toBeUndefined();
  });

  it("preserves a lone hr tag", () => {
    expect(tokenizeRawHtml("<hr>\n\nText\n")?.raw).toBe("<hr>");
  });

  it("finds block HTML at a later line via start", () => {
    const start = rawHtmlTokenizer.start;
    expect(typeof start).toBe("function");
    if (typeof start !== "function") return;
    expect(start("# Title\n\n<!-- note -->\n")).toBeGreaterThan(0);
    expect(start("<div>\n")).toBe(0);
    expect(start("plain text\n")).toBe(-1);
  });
});
