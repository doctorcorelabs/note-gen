// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Web implementation of the clipboard adapter.
 *
 * `writeText` uses the async Clipboard API (`navigator.clipboard.writeText`)
 * and falls back to a hidden textarea plus `document.execCommand("copy")`
 * when the API is missing or its write fails. The fallback is mandatory:
 * the Clipboard API needs a secure context and user activation, and older
 * browsers do not provide it at all. When both paths fail, the error is a
 * `PlatformCapabilityError` whose code keeps the permission classification
 * of the Clipboard API failure (`permission_denied`), so the UI can offer
 * the show-the-text-for-manual-copy fallback.
 *
 * `writeImage` and `writeHtml` use `navigator.clipboard.write` with a
 * `ClipboardItem`, mirroring the web branch already present in
 * `src/lib/plugins/document-output.ts`. Both need `ClipboardItem` support
 * and a secure context; when either is missing they throw a
 * `PlatformCapabilityError` instead of failing silently. There is no
 * `execCommand` fallback for image or HTML content.
 *
 * All browser globals are read at call time through `globalThis`, never
 * captured at module load, so unit tests can substitute mocks and so the
 * module is safe to import during server-side rendering (methods then fail
 * with an explicit capability error instead of a ReferenceError). Error
 * messages never echo clipboard content.
 */

import { capabilityError } from "../errors";
import { clipboardWriteError } from "./clipboard-errors";
import type { ClipboardAdapter, ClipboardImageInput } from "./interface";

/** Default MIME type for `writeImage`, matching the upstream PNG bytes. */
const DEFAULT_IMAGE_MIME_TYPE = "image/png";

/** Valid image MIME types: `image/` plus a token without parameters. */
const IMAGE_MIME_PATTERN = /^image\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

function getGlobals(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function getNavigator(): Record<string, unknown> | undefined {
  const value = getGlobals()["navigator"];
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function getClipboard(): Record<string, unknown> | undefined {
  const clipboard = getNavigator()?.["clipboard"];
  return clipboard !== null && typeof clipboard === "object"
    ? (clipboard as Record<string, unknown>)
    : undefined;
}

function getDocument(): Document | undefined {
  const value = getGlobals()["document"];
  return value === undefined ? undefined : (value as Document);
}

function getClipboardItemCtor():
  | (new (items: Record<string, Blob>) => unknown)
  | undefined {
  const ctor = getGlobals()["ClipboardItem"];
  return typeof ctor === "function"
    ? (ctor as new (items: Record<string, Blob>) => unknown)
    : undefined;
}

function getBlobCtor(): typeof Blob | undefined {
  const ctor = getGlobals()["Blob"];
  return typeof ctor === "function" ? (ctor as typeof Blob) : undefined;
}

function requireRichClipboard(
  capability: string,
): {
  clipboard: Record<string, unknown>;
  write: (items: unknown[]) => Promise<void>;
  ClipboardItemCtor: new (items: Record<string, Blob>) => unknown;
  BlobCtor: typeof Blob;
} {
  const clipboard = getClipboard();
  const write = clipboard?.["write"];
  const ClipboardItemCtor = getClipboardItemCtor();
  const BlobCtor = getBlobCtor();
  if (
    !clipboard ||
    typeof write !== "function" ||
    !ClipboardItemCtor ||
    !BlobCtor
  ) {
    throw capabilityError(
      "unavailable",
      "clipboard",
      capability,
      "web",
      "Rich clipboard writes need ClipboardItem support and a secure context. This browser does not provide them.",
    );
  }
  return {
    clipboard,
    write: write as (items: unknown[]) => Promise<void>,
    ClipboardItemCtor,
    BlobCtor,
  };
}

/**
 * Copy text through a hidden textarea and `document.execCommand("copy")`.
 * Returns false when the fallback is unavailable or the copy fails; never
 * throws, so the caller can decide which error to surface.
 */
async function tryExecCommandCopy(text: string): Promise<boolean> {
  const document = getDocument();
  if (!document || !document.body) {
    return false;
  }
  const execCommand = (
    document as unknown as Record<string, unknown>
  )["execCommand"];
  if (typeof execCommand !== "function") {
    return false;
  }
  const activeElement = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  // Keep the textarea in layout but invisible: `display: none` elements
  // cannot be selected, and selection is what the copy command reads.
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const copied = (
      execCommand as (command: string) => unknown
    ).call(document, "copy");
    return copied === true;
  } catch {
    return false;
  } finally {
    textarea.remove();
    const focusable = activeElement as unknown as {
      focus?: unknown;
    } | null;
    if (focusable && typeof focusable.focus === "function") {
      try {
        (focusable.focus as () => void).call(activeElement);
      } catch {
        // Restoring focus is best-effort; a failure here must not fail
        // the copy that already happened.
      }
    }
  }
}

/** Create the web clipboard adapter. */
export function createWebClipboardAdapter(): ClipboardAdapter {
  return {
    async writeText(text: string): Promise<void> {
      const clipboard = getClipboard();
      const writeText = clipboard?.["writeText"];
      if (typeof writeText === "function") {
        try {
          await (writeText as (value: string) => Promise<void>).call(
            clipboard,
            text,
          );
          return;
        } catch (error) {
          if (await tryExecCommandCopy(text)) {
            return;
          }
          throw clipboardWriteError(
            "writeText",
            error,
            "Clipboard write failed and the document copy fallback is unavailable. Show the text so the user can copy it manually.",
          );
        }
      }
      if (await tryExecCommandCopy(text)) {
        return;
      }
      throw capabilityError(
        "unavailable",
        "clipboard",
        "writeText",
        "web",
        "Neither the Clipboard API nor the document copy fallback is available. Show the text so the user can copy it manually.",
      );
    },

    async writeImage(
      image: ClipboardImageInput,
      mimeType: string = DEFAULT_IMAGE_MIME_TYPE,
    ): Promise<void> {
      const normalizedMime = mimeType.trim().toLowerCase();
      if (!IMAGE_MIME_PATTERN.test(normalizedMime)) {
        throw capabilityError(
          "invalid_argument",
          "clipboard",
          "writeImage",
          "web",
          "A valid image MIME type such as image/png is required.",
        );
      }
      const { clipboard, write, ClipboardItemCtor, BlobCtor } =
        requireRichClipboard("writeImage");
      // Copy byte inputs so the Blob owns exactly the input bytes even
      // when the Uint8Array is a view over a larger buffer. Blob inputs
      // are re-wrapped so the clipboard part carries the requested type.
      const blob =
        image instanceof Uint8Array
          ? new BlobCtor([image.slice().buffer], { type: normalizedMime })
          : new BlobCtor([image], { type: normalizedMime });
      const item = new ClipboardItemCtor({ [normalizedMime]: blob });
      try {
        await write.call(clipboard, [item]);
      } catch (error) {
        throw clipboardWriteError(
          "writeImage",
          error,
          "Image clipboard write failed. This browser may only support image/png clipboard writes.",
        );
      }
    },

    async writeHtml(html: string, text?: string): Promise<void> {
      const { clipboard, write, ClipboardItemCtor, BlobCtor } =
        requireRichClipboard("writeHtml");
      const parts: Record<string, Blob> = {
        "text/html": new BlobCtor([html], { type: "text/html" }),
      };
      if (text !== undefined) {
        parts["text/plain"] = new BlobCtor([text], { type: "text/plain" });
      }
      const item = new ClipboardItemCtor(parts);
      try {
        await write.call(clipboard, [item]);
      } catch (error) {
        throw clipboardWriteError(
          "writeHtml",
          error,
          "Rich-text clipboard write failed.",
        );
      }
    },
  };
}
