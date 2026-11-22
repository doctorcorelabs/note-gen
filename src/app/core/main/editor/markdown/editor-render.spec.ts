// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Render-path regression specs for the web editor core (Fase 1, V3-22
// render slot, 3D-22b). Covers only behavior that runs in Node without
// a DOM: the lexer protocol v4 contract, the fenced code block
// round-trip handlers, the outline heading index, KaTeX and lowlight
// rendering, and static guards for the Mermaid strict setting, the
// root-served lexer worker, and the absence of Tauri imports on the
// render, search, outline, and source paths.
//
// Runner: Vitest, unit project (vitest run --project unit). No test
// sends HTTP, touches the DOM, or constructs an editor view. Mermaid
// rendering itself needs a DOM, so this suite guards its configuration
// statically; the runtime payload proof stays with wave 4 hardening
// (H-17/H-18), which this suite does not claim to close. Runtime lexer
// tokenization is likewise not covered here: the tokenizer module
// chain uses the `@/` alias, which the unit project does not resolve
// (pre-existing Vitest configuration limitation, verified with a
// throwaway probe). The lexer worker build verification in the task
// report covers that the worker bundle builds with all tokenizers.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Schema, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type {
  JSONContent,
  MarkdownParseHelpers,
  MarkdownRendererHelpers,
  MarkdownToken,
} from "@tiptap/core";
import { describe, expect, it } from "vitest";

import {
  fenceLengthForContent,
  longestBacktickRun,
  parseFencedCodeBlockToken,
  renderFencedCodeBlockNode,
} from "./code-block-markdown";
import { getCommonLowlight } from "./code-block-languages";
import {
  isLargeMarkdownDocument,
  LARGE_MARKDOWN_CHARACTER_THRESHOLD,
  LARGE_MARKDOWN_HEAVY_NODE_THRESHOLD,
  LARGE_MARKDOWN_LINE_THRESHOLD,
} from "./large-markdown";
import { MARKDOWN_LEXER_VERSION } from "./markdown-lexer-protocol";
import { normalizeLatexForKatex } from "../../../../../lib/latex";
import { OutlineHeadingIndex } from "./outline-index";

function readRepoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

function readEditorFile(fileName: string): string {
  return readRepoFile(`./${fileName}`);
}

describe("lexer protocol v4", () => {
  it("pins the lexer protocol version to 4", () => {
    expect(MARKDOWN_LEXER_VERSION).toBe(4);
  });

  it("registers nine custom tokenizers in the shared list", () => {
    const source = readEditorFile("markdown-tokenizers.ts");
    const registrations = [
      "requireTokenizer(MarkdownOrderedList)",
      "requireTokenizer(TaskList)",
      "requireTokenizer(ColorHighlight)",
      "requireTokenizer(TextColor)",
      "requireTokenizer(Underline)",
      "inlineMathTokenizer,",
      "blockMathTokenizer,",
      "mermaidTokenizer,",
      "wikiMetadataTokenizer,",
    ];
    for (const registration of registrations) {
      expect(source).toContain(registration);
    }
    expect(source).toContain(
      "MARKDOWN_TOKENIZER_NAMES = markdownTokenizers.map",
    );
    expect(source).toContain("name: 'inline_math'");
    expect(source).toContain("name: 'block_math'");
    expect(source).toContain("name: 'mermaid'");
  });

  it("rejects mismatched protocol versions in the worker", () => {
    const source = readEditorFile("markdown-lexer-worker.ts");
    expect(source).toContain("Markdown lexer version mismatch");
    expect(source).toContain("type: 'ready'");
    expect(source).toContain("createMarkdownLexer");
  });
});

describe("large document thresholds", () => {
  it("keeps the audited thresholds unchanged", () => {
    expect(LARGE_MARKDOWN_CHARACTER_THRESHOLD).toBe(200_000);
    expect(LARGE_MARKDOWN_LINE_THRESHOLD).toBe(4_000);
    expect(LARGE_MARKDOWN_HEAVY_NODE_THRESHOLD).toBe(160);
  });

  it("classifies by character count at the boundary", () => {
    expect(isLargeMarkdownDocument("a".repeat(199_999))).toBe(false);
    expect(isLargeMarkdownDocument("a".repeat(200_000))).toBe(true);
  });

  it("classifies by line count at the boundary", () => {
    expect(isLargeMarkdownDocument("\n".repeat(3_998))).toBe(false);
    expect(isLargeMarkdownDocument("\n".repeat(3_999))).toBe(true);
  });

  it("classifies by heavy node markers at the boundary", () => {
    expect(isLargeMarkdownDocument("$$".repeat(159))).toBe(false);
    expect(isLargeMarkdownDocument("$$".repeat(160))).toBe(true);
  });
});

describe("fenced code block round-trip", () => {
  it("sizes the fence past the longest backtick run in the content", () => {
    expect(longestBacktickRun("a ``` b ```` c")).toBe(4);
    expect(fenceLengthForContent("plain code")).toBe(3);
    expect(fenceLengthForContent("contains ``` fence")).toBe(4);
    expect(fenceLengthForContent("contains ```` fence")).toBe(5);
  });

  it("parses tilde fences instead of dropping them", () => {
    const helpers = {
      createNode: (type: string, attrs: object, content: object[]) => ({
        type,
        attrs,
        content,
      }),
      createTextNode: (text: string) => ({ type: "text", text }),
    } as unknown as MarkdownParseHelpers;
    const token = {
      raw: "~~~ts\nconst x = 1\n~~~\n",
      text: "const x = 1",
      lang: "ts",
      codeBlockStyle: "fenced",
    } as unknown as MarkdownToken;
    const result = parseFencedCodeBlockToken(token, helpers) as unknown as {
      type: string;
      attrs: { language: string | null };
    };
    expect(result.type).toBe("codeBlock");
    expect(result.attrs.language).toBe("ts");
  });

  it("rejects tokens that are neither fenced nor indented", () => {
    const helpers = {
      createNode: () => {
        throw new Error("createNode must not run");
      },
      createTextNode: (text: string) => ({ type: "text", text }),
    } as unknown as MarkdownParseHelpers;
    const token = {
      raw: "plain text",
      text: "plain text",
    } as unknown as MarkdownToken;
    expect(parseFencedCodeBlockToken(token, helpers)).toEqual([]);
  });

  it("renders a fence longer than any backtick run in the content", () => {
    const helpers = {
      renderChildren: (content: JSONContent[]) =>
        content.map((child) => child.text ?? "").join(""),
    } as unknown as MarkdownRendererHelpers;
    const node: JSONContent = {
      type: "codeBlock",
      attrs: { language: "md" },
      content: [{ type: "text", text: "example ``` fence" }],
    };
    expect(renderFencedCodeBlockNode(node, helpers)).toBe(
      "````md\nexample ``` fence\n````",
    );
  });

  it("renders a tilde fence when the language holds a backtick", () => {
    const helpers = {
      renderChildren: (content: JSONContent[]) =>
        content.map((child) => child.text ?? "").join(""),
    } as unknown as MarkdownRendererHelpers;
    const node: JSONContent = {
      type: "codeBlock",
      attrs: { language: "we`ird" },
      content: [{ type: "text", text: "code" }],
    };
    const rendered = renderFencedCodeBlockNode(node, helpers);
    expect(rendered.startsWith("~~~ we`ird\n")).toBe(true);
    expect(rendered.endsWith("\n~~~")).toBe(true);
  });
});

describe("outline heading index", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "inline*" },
      heading: {
        group: "block",
        content: "inline*",
        attrs: { level: { default: 1 } },
      },
      text: { group: "inline" },
    },
    marks: {},
  });

  function buildDoc(): ProseMirrorNode {
    return schema.node("doc", null, [
      schema.node("heading", { level: 1 }, [schema.text("Intro")]),
      schema.node("paragraph", null, [schema.text("Body")]),
      schema.node("heading", { level: 3 }, [schema.text("Detail")]),
      schema.node("heading", { level: 2 }, []),
    ]);
  }

  const untitled = (level: number) => `Untitled ${level}`;

  it("rebuilds headings with levels and text in document order", () => {
    const headings = new OutlineHeadingIndex().rebuild(buildDoc(), untitled);
    expect(headings.map((heading) => heading.level)).toEqual([1, 3, 2]);
    expect(headings.map((heading) => heading.rawText)).toEqual([
      "Intro",
      "Detail",
      "",
    ]);
  });

  it("falls back to the untitled label for empty headings", () => {
    const headings = new OutlineHeadingIndex().rebuild(buildDoc(), untitled);
    expect(headings[2]?.text).toBe("Untitled 2");
  });

  it("keeps heading ids stable across rebuilds of the same document", () => {
    const index = new OutlineHeadingIndex();
    const doc = buildDoc();
    const first = index.rebuild(doc, untitled);
    const second = index.rebuild(doc, untitled);
    expect(second.map((heading) => heading.id)).toEqual(
      first.map((heading) => heading.id),
    );
  });

  it("keeps heading ids after an in-heading text edit", () => {
    const index = new OutlineHeadingIndex();
    const doc = buildDoc();
    const before = index.rebuild(doc, untitled);
    const state = EditorState.create({ doc, schema });
    const tr = state.tr.insertText("!", 2);
    const after = index.update(tr.doc, [tr], untitled);
    expect(after.map((heading) => heading.id)).toEqual(
      before.map((heading) => heading.id),
    );
    expect(after[0]?.rawText).toBe("I!ntro");
  });
});

describe("KaTeX rendering", () => {
  it("renders LaTeX to KaTeX HTML without throwing", async () => {
    const { default: katex } = await import("katex");
    const html = katex.renderToString("x^2 + y", {
      throwOnError: false,
      displayMode: false,
    });
    expect(html).toContain("katex");
    expect(html).toContain("x");
  });

  it("leaves plain LaTeX unchanged during normalization", () => {
    expect(normalizeLatexForKatex("x^2 + \\frac{1}{2}")).toBe(
      "x^2 + \\frac{1}{2}",
    );
  });

  it("expands repeated array column specs for KaTeX", () => {
    expect(
      normalizeLatexForKatex("\\begin{array}{*{3}{c}}a\\end{array}"),
    ).toBe("\\begin{array}{ccc}a\\end{array}");
  });
});

describe("lowlight highlighting", () => {
  // The shared bundle import is slow on a cold transform (the full
  // lowlight/common language set); the long timeout covers the first
  // import only, not the highlight call itself.
  it(
    "highlights JavaScript keywords through the shared bundle",
    async () => {
      const lowlight = await getCommonLowlight();
      expect(lowlight.registered("javascript")).toBe(true);
      const tree = lowlight.highlight("javascript", "const answer = 42");
      expect(JSON.stringify(tree)).toContain("hljs-keyword");
    },
    60_000,
  );
});

describe("render configuration guards", () => {
  it("sets Mermaid securityLevel strict exactly once", () => {
    const source = readEditorFile("mermaid-extension.tsx");
    expect(source.match(/securityLevel/g)).toHaveLength(1);
    expect(source).toContain("securityLevel: 'strict'");
    expect(source).not.toContain("securityLevel: 'loose'");
  });

  it("loads the lexer worker as a module from the site root with v4", () => {
    const source = readEditorFile("markdown-lexer-async.ts");
    expect(source).toContain(
      "`/markdown-lexer.js?v=${MARKDOWN_LEXER_VERSION}`",
    );
    expect(source).toContain("type: 'module'");
    expect(source).toContain("name: 'notegen-markdown-lexer'");
  });

  it("serves the app from the root and builds the lexer worker", () => {
    const nextConfig = readRepoFile("../../../../../../next.config.ts");
    expect(nextConfig).not.toContain("basePath");
    const packageJson = JSON.parse(
      readRepoFile("../../../../../../package.json"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["markdown-lexer:build"]).toContain(
      "public/markdown-lexer.js",
    );
    expect(packageJson.scripts.build).toContain("markdown-lexer:build");
    expect(packageJson.scripts.dev).toContain("markdown-lexer:build");
  });

  it("keeps render, search, outline, and source files free of Tauri imports", () => {
    const files = [
      "math-extension.tsx",
      "mermaid-extension.tsx",
      "code-block-extension.ts",
      "markdown-lexer-async.ts",
      "markdown-lexer-worker.ts",
      "markdown-lexer-protocol.ts",
      "schema-markdown.ts",
      "search-replace-panel.tsx",
      "outline.tsx",
      "outline-index.ts",
      "source-markdown-editor.tsx",
      "source-markdown-language.ts",
    ];
    for (const file of files) {
      expect(readEditorFile(file)).not.toContain("@tauri-apps");
    }
  });

  it("registers the render and search extensions in the visual editor", () => {
    const source = readEditorFile("tiptap-editor.tsx");
    expect(source).toContain("StableCodeBlockLowlight");
    expect(source).toContain("InlineMath");
    expect(source).toContain("BlockMath");
    expect(source).toContain("MermaidDiagram");
    expect(source).toContain("SearchAndReplace");
  });

  it("wires CodeMirror search in source mode", () => {
    const source = readEditorFile("source-markdown-editor.tsx");
    expect(source).toContain("searchKeymap");
    expect(source).toContain("openSearchPanel");
    expect(source).toContain("highlightSelectionMatches");
    expect(source).toContain("Compartment");
  });
});

describe("math and mermaid HTML round-trip (P1-2)", () => {
  it("writes data-latex on math attribute render and reads it back", () => {
    const source = readEditorFile("math-extension.tsx");
    expect(source.match(/'data-latex': attrs\.latex/g)).toHaveLength(2);
    expect(source).toContain("getAttribute('data-latex')");
    expect(source).toContain("getAttribute('latex')");
  });

  it("writes data-code on mermaid attribute render with text fallback", () => {
    const source = readEditorFile("mermaid-extension.tsx");
    expect(source).toContain("'data-code': attrs.code");
    expect(source).toContain("getAttribute('data-code')");
    expect(source).toContain("textContent?.trim()");
  });

  it("shares one inline-math guard between tokenizer and input rule (P1-3)", () => {
    const math = readEditorFile("math-extension.tsx");
    expect(math).toContain("INLINE_MATH_INPUT_RULE_RE");
    expect(math).not.toContain("find: /(?<!");
    const tokenizers = readEditorFile("markdown-tokenizers.ts");
    expect(tokenizers).toContain("INLINE_MATH_DOLLAR_SOURCE");
  });
});

describe("paste and drop honesty (M-03/M-04/M-06/M-07)", () => {
  const source = readEditorFile("tiptap-editor.tsx");

  it("uploads every pasted image, not just the first (M-06)", () => {
    expect(source).not.toContain("const imageFile = imageFiles[0]");
    expect(source).toContain("Promise.all(imageFiles.map(");
  });

  it("stops paste propagation on the handled-image branch (M-07)", () => {
    const start = source.indexOf("const handlePaste = (event: ClipboardEvent)");
    const region = source.slice(start, start + 1600);
    expect(region).toContain("event.stopPropagation()");
    expect(region).toContain("event.stopImmediatePropagation()");
  });

  it("uploads dropped images in mixed drops and never inserts bare filenames (M-03)", () => {
    expect(source).not.toContain("droppedImageFiles.length === droppedFiles.length");
    expect(source).not.toContain("droppedFileNames.map(escapeMarkdownText)");
    expect(source).toContain("fileDrop.mixedUnsupported");
  });

  it("gates file:// handling to desktop (M-04)", () => {
    const urlsStart = source.indexOf("function getFileUrlsFromDataTransfer");
    expect(source.slice(urlsStart, urlsStart + 400)).toContain("if (!checkIsTauri())");
    const hrefStart = source.indexOf("async function getMarkdownHrefForDroppedPath");
    const hrefRegion = source.slice(hrefStart, hrefStart + 900);
    expect(hrefRegion.indexOf("if (!checkIsTauri())")).toBeLessThan(hrefRegion.indexOf("return toFileUrl"));
  });
});
