// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the V2-12 web adapters: dialog, opener, and clipboard.
 *
 * Run with node:test over an esbuild bundle (no test runner is configured
 * in package.json, and node:test cannot resolve the extensionless relative
 * imports the repo uses). From the repo root, after `pnpm install`:
 *
 *   ./node_modules/.bin/esbuild src/lib/platform/__tests__/v2-12-web-dialog-opener-clipboard.spec.ts --bundle --platform=node --format=esm --outfile=/tmp/v2-12-test.mjs
 *   node --test /tmp/v2-12-test.mjs
 *
 * The file uses a `.spec.ts` suffix because the repo `.gitignore` ignores
 * `*.test.*`, which would keep a V1-05-style `*.test.ts` contract test off
 * the branch. The integrator needs a `.gitignore` negation before canonical
 * `*.test.ts` contract tests can land; renaming this file then is trivial.
 *
 * Browser globals are mocked per test through `globalThis` and restored
 * afterwards. What this file cannot verify: real browser picker behavior,
 * popup blocker behavior, and real permission prompts; those need a
 * browser run.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { PlatformCapabilityError } from "../errors";
import {
  isClipboardPermissionError,
  clipboardWriteError,
} from "../clipboard/clipboard-errors";
import { createWebClipboardAdapter } from "../clipboard/clipboard.web";
import {
  dialogFiltersToAccept,
  dialogFiltersToPickerTypes,
  suggestedFileName,
} from "../dialog/file-filters";
import {
  __resetDefaultDialogServiceForTests,
  createWebDialogAdapter,
} from "../dialog/dialog.web";
import type {
  ConfirmDialogOptions,
  DialogService,
  MessageDialogOptions,
  PromptDialogOptions,
} from "../dialog/interface";
import { createWebOpenerAdapter } from "../opener/opener.web";
import { isHttpUrl, validateHttpUrl } from "../opener/url-validation";

// ---------------------------------------------------------------------------
// Global mock helpers
// ---------------------------------------------------------------------------

const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();

function setGlobal(key: string, value: unknown): void {
  if (!savedDescriptors.has(key)) {
    savedDescriptors.set(
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    );
  }
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

function restoreGlobals(): void {
  for (const [key, descriptor] of savedDescriptors) {
    if (descriptor === undefined) {
      delete (globalThis as Record<string, unknown>)[key];
    } else {
      Object.defineProperty(globalThis, key, descriptor);
    }
  }
  savedDescriptors.clear();
  __resetDefaultDialogServiceForTests();
}

class FakeClipboardItem {
  static created: FakeClipboardItem[] = [];
  readonly items: Record<string, Blob>;

  constructor(items: Record<string, Blob>) {
    this.items = items;
    FakeClipboardItem.created.push(this);
  }
}

beforeEach(() => {
  restoreGlobals();
  FakeClipboardItem.created = [];
});

afterEach(() => {
  restoreGlobals();
});

function expectCapabilityError(
  code: string,
  adapter: string,
  capability: string,
): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof PlatformCapabilityError &&
    error.code === code &&
    error.adapter === adapter &&
    error.capability === capability;
}

function permissionError(): Error {
  const error = new Error("The request is not allowed");
  error.name = "NotAllowedError";
  return error;
}

function abortError(): Error {
  const error = new Error("The user aborted a request");
  error.name = "AbortError";
  return error;
}

// ---------------------------------------------------------------------------
// Opener URL validation (pure)
// ---------------------------------------------------------------------------

describe("validateHttpUrl", () => {
  test("accepts absolute http and https URLs", () => {
    assert.equal(validateHttpUrl("http://example.com/x").href, "http://example.com/x");
    assert.equal(
      validateHttpUrl("https://example.com/a?b=1#frag").href,
      "https://example.com/a?b=1#frag",
    );
  });

  test("normalizes scheme and host casing", () => {
    assert.equal(
      validateHttpUrl("HTTPS://EXAMPLE.COM/Path").href,
      "https://example.com/Path",
    );
  });

  test("accepts a URL object", () => {
    const input = new URL("https://example.com/");
    assert.equal(validateHttpUrl(input), input);
  });

  test("trims surrounding whitespace", () => {
    assert.equal(
      validateHttpUrl("  https://example.com/  ").href,
      "https://example.com/",
    );
  });

  const invalidInputs: unknown[] = [
    "",
    "   ",
    "not a url",
    "/relative/path",
    "//example.com/x",
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///etc/passwd",
    "mailto:someone@example.com",
    "ftp://example.com/file",
    "https://user:pass@example.com/",
    "https://user@example.com/",
    "https://",
    "C:\\Users\\someone\\file.txt",
    "D:/docs/report.pdf",
    "/home/someone/file.txt",
    42,
    null,
    undefined,
    {},
  ];

  for (const input of invalidInputs) {
    test(`rejects ${JSON.stringify(input) ?? String(input)}`, () => {
      assert.throws(
        () => validateHttpUrl(input as string),
        expectCapabilityError("invalid_argument", "opener", "openUrl"),
      );
    });
  }

  test("never echoes the rejected input in the error message", () => {
    try {
      validateHttpUrl("https://user:secret-token-xyz@example.com/");
      assert.fail("validateHttpUrl should have thrown");
    } catch (error) {
      if (!(error instanceof PlatformCapabilityError)) {
        assert.fail("expected a PlatformCapabilityError");
      }
      assert.ok(!error.message.includes("secret-token-xyz"));
      assert.ok(!error.message.includes("example.com"));
    }
  });
});

describe("isHttpUrl", () => {
  test("returns true for http(s) URLs and false otherwise", () => {
    assert.equal(isHttpUrl("https://example.com/"), true);
    assert.equal(isHttpUrl("http://localhost:3000/x"), true);
    assert.equal(isHttpUrl("javascript:alert(1)"), false);
    assert.equal(isHttpUrl("/relative"), false);
    assert.equal(isHttpUrl(""), false);
  });
});

// ---------------------------------------------------------------------------
// Dialog file filters (pure)
// ---------------------------------------------------------------------------

describe("dialogFiltersToAccept", () => {
  test("builds a dotted extension list", () => {
    assert.equal(
      dialogFiltersToAccept([
        { name: "Images", extensions: ["png", "jpg"] },
        { name: "Docs", extensions: ["md"] },
      ]),
      ".png,.jpg,.md",
    );
  });

  test("strips leading dots, lowercases, and dedupes", () => {
    assert.equal(
      dialogFiltersToAccept([
        { name: "Mixed", extensions: [".PNG", "png", "Jpg"] },
      ]),
      ".png,.jpg",
    );
  });

  test("drops unusable extensions and returns empty when none remain", () => {
    assert.equal(
      dialogFiltersToAccept([{ name: "Bad", extensions: ["", "../x", "a b"] }]),
      "",
    );
    assert.equal(dialogFiltersToAccept(undefined), "");
    assert.equal(dialogFiltersToAccept([]), "");
  });
});

describe("dialogFiltersToPickerTypes", () => {
  test("groups extensions by MIME type per filter", () => {
    assert.deepEqual(
      dialogFiltersToPickerTypes([
        { name: "Images", extensions: ["png", "jpg"] },
        { name: "Docs", extensions: ["md"] },
      ]),
      [
        {
          description: "Images",
          accept: { "image/png": [".png"], "image/jpeg": [".jpg"] },
        },
        {
          description: "Docs",
          accept: { "text/markdown": [".md"] },
        },
      ],
    );
  });

  test("falls back to application/octet-stream for unknown extensions", () => {
    assert.deepEqual(
      dialogFiltersToPickerTypes([
        { name: "Data", extensions: ["xyz"] },
      ]),
      [
        {
          description: "Data",
          accept: { "application/octet-stream": [".xyz"] },
        },
      ],
    );
  });

  test("returns an empty list when no usable extension is present", () => {
    assert.deepEqual(dialogFiltersToPickerTypes(undefined), []);
    assert.deepEqual(
      dialogFiltersToPickerTypes([{ name: "Bad", extensions: [""] }]),
      [],
    );
  });
});

describe("suggestedFileName", () => {
  test("strips directory parts on both separators", () => {
    assert.equal(suggestedFileName("a/b/report.md"), "report.md");
    assert.equal(suggestedFileName("C:\\dir\\report.md"), "report.md");
    assert.equal(suggestedFileName("report.md"), "report.md");
  });

  test("falls back when no file name part remains", () => {
    assert.equal(suggestedFileName(undefined), "untitled");
    assert.equal(suggestedFileName(""), "untitled");
    assert.equal(suggestedFileName("///"), "untitled");
    assert.equal(suggestedFileName(undefined, "draft.txt"), "draft.txt");
  });
});

// ---------------------------------------------------------------------------
// Clipboard error classification (pure)
// ---------------------------------------------------------------------------

describe("isClipboardPermissionError", () => {
  test("matches NotAllowedError and SecurityError names", () => {
    assert.equal(isClipboardPermissionError(permissionError()), true);
    const security = new Error("secure context required");
    security.name = "SecurityError";
    assert.equal(isClipboardPermissionError(security), true);
  });

  test("matches permission wording in the message", () => {
    assert.equal(
      isClipboardPermissionError(new Error("Permission denied by user")),
      true,
    );
    assert.equal(
      isClipboardPermissionError(new Error("The request is not allowed")),
      true,
    );
  });

  test("rejects other values", () => {
    assert.equal(isClipboardPermissionError(new Error("boom")), false);
    assert.equal(isClipboardPermissionError(null), false);
    assert.equal(isClipboardPermissionError("NotAllowedError"), false);
    assert.equal(isClipboardPermissionError({}), false);
  });
});

describe("clipboardWriteError", () => {
  test("maps permission failures to permission_denied", () => {
    const mapped = clipboardWriteError("writeText", permissionError(), "other");
    assert.equal(mapped.code, "permission_denied");
    assert.equal(mapped.capability, "writeText");
    assert.equal(mapped.adapter, "clipboard");
  });

  test("maps other failures to unavailable with the given reason", () => {
    const mapped = clipboardWriteError(
      "writeImage",
      new Error("boom"),
      "image write failed",
    );
    assert.equal(mapped.code, "unavailable");
    assert.ok(mapped.message.includes("image write failed"));
  });

  test("passes PlatformCapabilityError through unchanged", () => {
    const original = clipboardWriteError("writeText", new Error("x"), "r");
    assert.equal(clipboardWriteError("writeText", original, "other"), original);
  });
});

// ---------------------------------------------------------------------------
// Clipboard web adapter (global mocks)
// ---------------------------------------------------------------------------

interface ClipboardApiShape {
  writeText: (text: string) => Promise<void>;
  write: (items: unknown[]) => Promise<void>;
}

function mockClipboardApi(overrides: Partial<ClipboardApiShape> = {}): {
  writeTextCalls: string[];
  writeCalls: unknown[][];
} {
  const writeTextCalls: string[] = [];
  const writeCalls: unknown[][] = [];
  const clipboard: ClipboardApiShape = {
    writeText: async (text: string) => {
      writeTextCalls.push(text);
    },
    write: async (items: unknown[]) => {
      writeCalls.push(items);
    },
    ...overrides,
  };
  setGlobal("navigator", { clipboard });
  return { writeTextCalls, writeCalls };
}

interface FakeTextarea {
  value: string;
  style: Record<string, string>;
  focused: boolean;
  selected: boolean;
  removed: boolean;
  focus: () => void;
  select: () => void;
  setSelectionRange: (start: number, end: number) => void;
  remove: () => void;
  setAttribute: (name: string, value: string) => void;
}

function mockExecCommandDocument(copyResult: boolean): {
  textareas: FakeTextarea[];
  execCommandCalls: () => number;
} {
  const textareas: FakeTextarea[] = [];
  let execCommandCount = 0;
  const documentMock = {
    activeElement: null,
    body: {
      appendChild: (): void => undefined,
    },
    createElement: (): FakeTextarea => {
      const textarea: FakeTextarea = {
        value: "",
        style: {},
        focused: false,
        selected: false,
        removed: false,
        focus: (): void => {
          textarea.focused = true;
        },
        select: (): void => {
          textarea.selected = true;
        },
        setSelectionRange: (): void => undefined,
        remove: (): void => {
          textarea.removed = true;
        },
        setAttribute: (): void => undefined,
      };
      textareas.push(textarea);
      return textarea;
    },
    execCommand: (): boolean => {
      execCommandCount += 1;
      return copyResult;
    },
  };
  setGlobal("document", documentMock);
  return { textareas, execCommandCalls: () => execCommandCount };
}

function mockRichClipboard(): { writeCalls: unknown[][] } {
  setGlobal("ClipboardItem", FakeClipboardItem);
  return mockClipboardApi();
}

describe("web clipboard adapter", () => {
  test("writeText uses the Clipboard API when available", async () => {
    const { writeTextCalls } = mockClipboardApi();
    mockExecCommandDocument(true);
    const adapter = createWebClipboardAdapter();
    await adapter.writeText("hello");
    assert.deepEqual(writeTextCalls, ["hello"]);
  });

  test("writeText falls back to execCommand when the Clipboard API is missing", async () => {
    setGlobal("navigator", {});
    const { textareas, execCommandCalls } = mockExecCommandDocument(true);
    const adapter = createWebClipboardAdapter();
    await adapter.writeText("fallback text");
    assert.equal(execCommandCalls(), 1);
    assert.equal(textareas.length, 1);
    assert.equal(textareas[0].value, "fallback text");
    assert.equal(textareas[0].focused, true);
    assert.equal(textareas[0].selected, true);
    assert.equal(textareas[0].removed, true);
  });

  test("writeText falls back to execCommand when the Clipboard API write fails", async () => {
    mockClipboardApi({
      writeText: async () => {
        throw new Error("clipboard busy");
      },
    });
    const { textareas, execCommandCalls } = mockExecCommandDocument(true);
    const adapter = createWebClipboardAdapter();
    await adapter.writeText("rescued");
    assert.equal(execCommandCalls(), 1);
    assert.equal(textareas[0].value, "rescued");
  });

  test("writeText throws permission_denied when permission is denied and no fallback exists", async () => {
    mockClipboardApi({
      writeText: async () => {
        throw permissionError();
      },
    });
    const adapter = createWebClipboardAdapter();
    await assert.rejects(
      () => adapter.writeText("secret"),
      expectCapabilityError("permission_denied", "clipboard", "writeText"),
    );
  });

  test("writeText keeps the permission classification when the fallback also fails", async () => {
    mockClipboardApi({
      writeText: async () => {
        throw permissionError();
      },
    });
    mockExecCommandDocument(false);
    const adapter = createWebClipboardAdapter();
    await assert.rejects(
      () => adapter.writeText("secret"),
      expectCapabilityError("permission_denied", "clipboard", "writeText"),
    );
  });

  test("writeText throws unavailable when neither path exists", async () => {
    setGlobal("navigator", {});
    const adapter = createWebClipboardAdapter();
    await assert.rejects(
      () => adapter.writeText("nothing here"),
      expectCapabilityError("unavailable", "clipboard", "writeText"),
    );
  });

  test("writeImage writes PNG bytes through ClipboardItem", async () => {
    const { writeCalls } = mockRichClipboard();
    const adapter = createWebClipboardAdapter();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await adapter.writeImage(bytes);
    assert.equal(writeCalls.length, 1);
    assert.equal(FakeClipboardItem.created.length, 1);
    const blob = FakeClipboardItem.created[0].items["image/png"];
    assert.ok(blob instanceof Blob);
    assert.equal(blob.type, "image/png");
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  });

  test("writeImage copies exactly the bytes of a Uint8Array view", async () => {
    mockRichClipboard();
    const adapter = createWebClipboardAdapter();
    const buffer = new ArrayBuffer(8);
    new Uint8Array(buffer).set([1, 2, 3, 4, 5, 6, 7, 8]);
    const view = new Uint8Array(buffer, 2, 4);
    await adapter.writeImage(view);
    const blob = FakeClipboardItem.created[0].items["image/png"];
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([3, 4, 5, 6]));
  });

  test("writeImage accepts a Blob and normalizes its type", async () => {
    mockRichClipboard();
    const adapter = createWebClipboardAdapter();
    await adapter.writeImage(new Blob(["raw"], { type: "" }), "image/jpeg");
    const blob = FakeClipboardItem.created[0].items["image/jpeg"];
    assert.equal(blob.type, "image/jpeg");
    assert.equal(await blob.text(), "raw");
  });

  test("writeImage rejects a non-image MIME type", async () => {
    mockRichClipboard();
    const adapter = createWebClipboardAdapter();
    await assert.rejects(
      () => adapter.writeImage(new Uint8Array([1]), "text/plain"),
      expectCapabilityError("invalid_argument", "clipboard", "writeImage"),
    );
  });

  test("writeImage throws unavailable without ClipboardItem support", async () => {
    mockClipboardApi();
    const adapter = createWebClipboardAdapter();
    await assert.rejects(
      () => adapter.writeImage(new Uint8Array([1])),
      expectCapabilityError("unavailable", "clipboard", "writeImage"),
    );
  });

  test("writeImage maps a denied write to permission_denied", async () => {
    setGlobal("ClipboardItem", FakeClipboardItem);
    mockClipboardApi({
      write: async () => {
        throw permissionError();
      },
    });
    const adapter = createWebClipboardAdapter();
    await assert.rejects(
      () => adapter.writeImage(new Uint8Array([1])),
      expectCapabilityError("permission_denied", "clipboard", "writeImage"),
    );
  });

  test("writeHtml writes html and plain parts through ClipboardItem", async () => {
    mockRichClipboard();
    const adapter = createWebClipboardAdapter();
    await adapter.writeHtml("<p>Hi</p>", "Hi");
    const items = FakeClipboardItem.created[0].items;
    assert.equal(await items["text/html"].text(), "<p>Hi</p>");
    assert.equal(items["text/html"].type, "text/html");
    assert.equal(await items["text/plain"].text(), "Hi");
    assert.equal(items["text/plain"].type, "text/plain");
  });

  test("writeHtml without a plain part writes only the html part", async () => {
    mockRichClipboard();
    const adapter = createWebClipboardAdapter();
    await adapter.writeHtml("<p>Hi</p>");
    assert.deepEqual(
      Object.keys(FakeClipboardItem.created[0].items),
      ["text/html"],
    );
  });

  test("writeHtml throws unavailable without ClipboardItem support", async () => {
    mockClipboardApi();
    const adapter = createWebClipboardAdapter();
    await assert.rejects(
      () => adapter.writeHtml("<p>Hi</p>", "Hi"),
      expectCapabilityError("unavailable", "clipboard", "writeHtml"),
    );
  });
});

// ---------------------------------------------------------------------------
// Dialog web adapter (global mocks)
// ---------------------------------------------------------------------------

function mockDialogService(): {
  service: DialogService;
  calls: Array<{ method: string; message: string; options: unknown }>;
} {
  const calls: Array<{ method: string; message: string; options: unknown }> =
    [];
  const service: DialogService = {
    confirm: async (
      message: string,
      options?: string | ConfirmDialogOptions,
    ) => {
      calls.push({ method: "confirm", message, options });
      return true;
    },
    ask: async (message: string, options?: string | ConfirmDialogOptions) => {
      calls.push({ method: "ask", message, options });
      return false;
    },
    message: async (
      message: string,
      options?: string | MessageDialogOptions,
    ) => {
      calls.push({ method: "message", message, options });
    },
    prompt: async (
      message: string,
      options?: string | PromptDialogOptions,
    ) => {
      calls.push({ method: "prompt", message, options });
      return "typed";
    },
  };
  return { service, calls };
}

function makeFile(name: string, relativePath: string, content = "x"): File {
  const file = new File([content], name, { type: "text/plain" });
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
}

interface FakeInput {
  type: string;
  multiple: boolean;
  accept: string;
  webkitdirectory: boolean;
  style: Record<string, string>;
  files: File[] | null;
  removed: boolean;
  addEventListener: (type: string, listener: () => void) => void;
  click: () => void;
  remove: () => void;
}

function mockInputDocument(
  files: File[],
  behavior: "change" | "cancel" = "change",
): { inputs: FakeInput[] } {
  const inputs: FakeInput[] = [];
  const documentMock = {
    body: {
      appendChild: (): void => undefined,
    },
    createElement: (): FakeInput => {
      const listeners = new Map<string, Array<() => void>>();
      const input: FakeInput = {
        type: "",
        multiple: false,
        accept: "",
        webkitdirectory: false,
        style: {},
        files,
        removed: false,
        addEventListener: (type: string, listener: () => void): void => {
          const list = listeners.get(type) ?? [];
          list.push(listener);
          listeners.set(type, list);
        },
        click: (): void => {
          for (const listener of listeners.get(behavior) ?? []) {
            listener();
          }
        },
        remove: (): void => {
          input.removed = true;
        },
      };
      inputs.push(input);
      return input;
    },
  };
  setGlobal("document", documentMock);
  return { inputs };
}

interface FakeAnchor {
  href: string;
  download: string;
  target: string;
  rel: string;
  clicked: boolean;
  removed: boolean;
  click: () => void;
  remove: () => void;
}

function mockAnchorDocument(): { anchors: FakeAnchor[] } {
  const anchors: FakeAnchor[] = [];
  const documentMock = {
    body: {
      appendChild: (): void => undefined,
    },
    createElement: (): FakeAnchor => {
      const anchor: FakeAnchor = {
        href: "",
        download: "",
        target: "",
        rel: "",
        clicked: false,
        removed: false,
        click: (): void => {
          anchor.clicked = true;
        },
        remove: (): void => {
          anchor.removed = true;
        },
      };
      anchors.push(anchor);
      return anchor;
    },
  };
  setGlobal("document", documentMock);
  return { anchors };
}

describe("web dialog adapter", () => {
  test("confirm, ask, message, and prompt delegate to the injected service", async () => {
    const { service, calls } = mockDialogService();
    const adapter = createWebDialogAdapter({ dialogService: service });
    assert.equal(await adapter.confirm("Sure?", { title: "T" }), true);
    assert.equal(await adapter.ask("Delete?"), false);
    await adapter.message("Hello");
    assert.equal(await adapter.prompt("Name?"), "typed");
    assert.deepEqual(
      calls.map((call) => call.method),
      ["confirm", "ask", "message", "prompt"],
    );
    assert.equal(calls[0].message, "Sure?");
  });

  test("confirm without a dialog service throws instead of using a native popup", async () => {
    const adapter = createWebDialogAdapter();
    await assert.rejects(
      () => adapter.confirm("Sure?"),
      expectCapabilityError("unavailable", "dialog", "confirm"),
    );
    await assert.rejects(
      () => adapter.prompt("Name?"),
      expectCapabilityError("unavailable", "dialog", "prompt"),
    );
  });

  test("open uses the File System Access picker when available", async () => {
    const file = makeFile("note.md", "note.md", "content");
    let seenOptions: unknown;
    setGlobal("showOpenFilePicker", async (options: unknown) => {
      seenOptions = options;
      return [
        {
          kind: "file",
          name: "note.md",
          getFile: async () => file,
        },
      ];
    });
    const adapter = createWebDialogAdapter();
    const result = await adapter.open({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (result === null || Array.isArray(result)) {
      assert.fail("expected a single picked file");
    }
    assert.equal(result.name, "note.md");
    assert.equal(result.relativePath, "note.md");
    assert.equal(result.size, file.size);
    assert.equal(result.file, file);
    assert.ok(result.handle !== undefined);
    assert.deepEqual(
      seenOptions as Record<string, unknown>,
      {
        multiple: false,
        types: [
          {
            description: "Markdown",
            accept: { "text/markdown": [".md"] },
          },
        ],
      },
    );
  });

  test("open returns null when the picker is cancelled", async () => {
    setGlobal("showOpenFilePicker", async () => {
      throw abortError();
    });
    const adapter = createWebDialogAdapter();
    assert.equal(await adapter.open({}), null);
  });

  test("open falls back to a file input and returns one file when multiple is false", async () => {
    const file = makeFile("a.txt", "a.txt");
    mockInputDocument([file]);
    const adapter = createWebDialogAdapter();
    const result = await adapter.open({
      multiple: false,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (result === null || Array.isArray(result)) {
      assert.fail("expected a single picked file");
    }
    assert.equal(result.name, "a.txt");
    assert.equal(result.handle, undefined);
  });

  test("open falls back to a file input and returns null on cancel", async () => {
    mockInputDocument([], "cancel");
    const adapter = createWebDialogAdapter();
    assert.equal(await adapter.open({}), null);
  });

  test("directory open through the input fallback returns every file", async () => {
    const files = [
      makeFile("a.md", "docs/a.md"),
      makeFile("b.md", "docs/sub/b.md"),
      makeFile("c.md", "docs/sub/c.md"),
    ];
    const { inputs } = mockInputDocument(files);
    const adapter = createWebDialogAdapter();
    const result = await adapter.open({ directory: true, multiple: false });
    if (!Array.isArray(result)) {
      assert.fail("expected an array of picked files");
    }
    assert.equal(result.length, 3);
    assert.deepEqual(
      result.map((picked) => picked.relativePath),
      ["docs/a.md", "docs/sub/b.md", "docs/sub/c.md"],
    );
    assert.equal(inputs[0].webkitdirectory, true);
    assert.equal(inputs[0].removed, true);
  });

  test("directory open through showDirectoryPicker collects nested files", async () => {
    const fileA = makeFile("a.md", "a.md");
    const fileB = makeFile("b.md", "b.md");
    const fileHandleB = {
      kind: "file",
      name: "b.md",
      getFile: async () => fileB,
    };
    const subdir = {
      kind: "directory",
      name: "sub",
      values: async function* () {
        yield fileHandleB;
      },
    };
    const root = {
      kind: "directory",
      name: "root",
      values: async function* () {
        yield { kind: "file", name: "a.md", getFile: async () => fileA };
        yield subdir;
      },
    };
    setGlobal("showDirectoryPicker", async () => root);
    const adapter = createWebDialogAdapter();
    const result = await adapter.open({ directory: true });
    if (!Array.isArray(result)) {
      assert.fail("expected an array of picked files");
    }
    assert.deepEqual(
      result.map((picked) => picked.relativePath),
      ["a.md", "sub/b.md"],
    );
  });

  test("open throws when no picker and no document exist", async () => {
    const adapter = createWebDialogAdapter();
    await assert.rejects(
      () => adapter.open({}),
      expectCapabilityError("unavailable", "dialog", "open"),
    );
  });

  test("save returns the picked target with its handle", async () => {
    const handle = {
      kind: "file",
      name: "saved.md",
      getFile: async () => makeFile("saved.md", "saved.md"),
    };
    setGlobal("showSaveFilePicker", async () => handle);
    const adapter = createWebDialogAdapter();
    const target = await adapter.save({ defaultPath: "saved.md" });
    if (target === null) {
      assert.fail("expected a save target");
    }
    assert.equal(target.name, "saved.md");
    assert.ok(target.handle !== undefined);
  });

  test("save returns null when the picker is cancelled", async () => {
    setGlobal("showSaveFilePicker", async () => {
      throw abortError();
    });
    const adapter = createWebDialogAdapter();
    assert.equal(await adapter.save({}), null);
  });

  test("save throws when the File System Access API is unavailable", async () => {
    const adapter = createWebDialogAdapter();
    await assert.rejects(
      () => adapter.save({ defaultPath: "saved.md" }),
      expectCapabilityError("unavailable", "dialog", "save"),
    );
  });

  test("saveBlob writes through the save picker handle", async () => {
    const written: Blob[] = [];
    let closed = false;
    const handle = {
      kind: "file",
      name: "saved.md",
      getFile: async () => makeFile("saved.md", "saved.md"),
      createWritable: async () => ({
        write: async (data: Blob) => {
          written.push(data);
        },
        close: async () => {
          closed = true;
        },
      }),
    };
    setGlobal("showSaveFilePicker", async () => handle);
    const adapter = createWebDialogAdapter();
    const blob = new Blob(["hello"], { type: "text/plain" });
    assert.equal(await adapter.saveBlob({ defaultPath: "saved.md" }, blob), true);
    assert.equal(written.length, 1);
    assert.equal(await written[0].text(), "hello");
    assert.equal(closed, true);
  });

  test("saveBlob returns false when the save picker is cancelled", async () => {
    setGlobal("showSaveFilePicker", async () => {
      throw abortError();
    });
    const adapter = createWebDialogAdapter();
    assert.equal(
      await adapter.saveBlob({ defaultPath: "x.md" }, new Blob(["x"])),
      false,
    );
  });

  test("saveBlob downloads through an anchor when no picker exists", async () => {
    const { anchors } = mockAnchorDocument();
    const adapter = createWebDialogAdapter();
    assert.equal(
      await adapter.saveBlob(
        { defaultPath: "reports/final.md" },
        new Blob(["data"]),
      ),
      true,
    );
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].download, "final.md");
    assert.ok(anchors[0].href.startsWith("blob:"));
    assert.equal(anchors[0].clicked, true);
    assert.equal(anchors[0].removed, true);
  });
});

// ---------------------------------------------------------------------------
// Opener web adapter (global mocks)
// ---------------------------------------------------------------------------

function mockWindowOpen(result: unknown): {
  calls: Array<{ url: string; target: string; features: string }>;
} {
  const calls: Array<{ url: string; target: string; features: string }> = [];
  setGlobal("window", {
    open: (url: string, target: string, features: string): unknown => {
      calls.push({ url, target, features });
      return result;
    },
  });
  return { calls };
}

describe("web opener adapter", () => {
  test("openUrl opens a validated URL in a new tab with noopener", async () => {
    const { calls } = mockWindowOpen({});
    const adapter = createWebOpenerAdapter();
    await adapter.openUrl("HTTPS://EXAMPLE.COM/page");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://example.com/page");
    assert.equal(calls[0].target, "_blank");
    assert.equal(calls[0].features, "noopener,noreferrer");
  });

  test("openUrl surfaces a blocked popup as a capability error", async () => {
    mockWindowOpen(null);
    const adapter = createWebOpenerAdapter();
    await assert.rejects(
      () => adapter.openUrl("https://example.com/"),
      expectCapabilityError("unavailable", "opener", "openUrl"),
    );
  });

  test("openUrl falls back to an anchor click when window.open is missing", async () => {
    setGlobal("window", {});
    const { anchors } = mockAnchorDocument();
    const adapter = createWebOpenerAdapter();
    await adapter.openUrl("https://example.com/");
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].href, "https://example.com/");
    assert.equal(anchors[0].target, "_blank");
    assert.equal(anchors[0].rel, "noopener noreferrer");
    assert.equal(anchors[0].clicked, true);
  });

  test("openUrl rejects local paths and never echoes them", async () => {
    mockWindowOpen({});
    const adapter = createWebOpenerAdapter();
    try {
      await adapter.openUrl("file:///home/someone/secret-note.md" as string);
      assert.fail("openUrl should have thrown");
    } catch (error) {
      if (!(error instanceof PlatformCapabilityError)) {
        assert.fail("expected a PlatformCapabilityError");
      }
      assert.equal(error.code, "invalid_argument");
      assert.ok(!error.message.includes("secret-note"));
    }
    await assert.rejects(
      () => adapter.openUrl("javascript:alert(1)"),
      expectCapabilityError("invalid_argument", "opener", "openUrl"),
    );
  });

  test("openUrl ignores the openWith argument", async () => {
    const { calls } = mockWindowOpen({});
    const adapter = createWebOpenerAdapter();
    await adapter.openUrl("https://example.com/", "firefox");
    assert.equal(calls.length, 1);
  });

  test("openPath always throws and never echoes the path", async () => {
    const adapter = createWebOpenerAdapter();
    try {
      await adapter.openPath("/home/someone/private-file.txt");
      assert.fail("openPath should have thrown");
    } catch (error) {
      if (!(error instanceof PlatformCapabilityError)) {
        assert.fail("expected a PlatformCapabilityError");
      }
      assert.equal(error.code, "unsupported");
      assert.equal(error.capability, "openPath");
      assert.ok(!error.message.includes("private-file"));
    }
  });

  test("revealItemInDir always throws", async () => {
    const adapter = createWebOpenerAdapter();
    await assert.rejects(
      () => adapter.revealItemInDir("/home/someone/file.txt"),
      expectCapabilityError("unsupported", "opener", "revealItemInDir"),
    );
  });

  test("downloadUrl anchors to the validated URL with a file name", async () => {
    const { anchors } = mockAnchorDocument();
    const adapter = createWebOpenerAdapter();
    await adapter.downloadUrl("https://example.com/files/report.pdf");
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].href, "https://example.com/files/report.pdf");
    assert.equal(anchors[0].download, "report.pdf");
    assert.equal(anchors[0].clicked, true);
  });

  test("downloadUrl falls back to a generic name for a bare host URL", async () => {
    const { anchors } = mockAnchorDocument();
    const adapter = createWebOpenerAdapter();
    await adapter.downloadUrl("https://example.com/", "  ");
    assert.equal(anchors[0].download, "download");
  });

  test("downloadUrl rejects non-http(s) URLs", async () => {
    mockAnchorDocument();
    const adapter = createWebOpenerAdapter();
    await assert.rejects(
      () => adapter.downloadUrl("file:///etc/passwd"),
      expectCapabilityError("invalid_argument", "opener", "downloadUrl"),
    );
  });

  test("downloadBlob anchors to an object URL with the given name", async () => {
    const { anchors } = mockAnchorDocument();
    const adapter = createWebOpenerAdapter();
    await adapter.downloadBlob(new Blob(["data"]), "export.md");
    assert.equal(anchors.length, 1);
    assert.ok(anchors[0].href.startsWith("blob:"));
    assert.equal(anchors[0].download, "export.md");
    assert.equal(anchors[0].clicked, true);
  });

  test("downloadBlob rejects an empty file name", async () => {
    mockAnchorDocument();
    const adapter = createWebOpenerAdapter();
    await assert.rejects(
      () => adapter.downloadBlob(new Blob(["x"]), "   "),
      expectCapabilityError("invalid_argument", "opener", "downloadBlob"),
    );
  });
});
