// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Web implementation of the opener adapter.
 *
 * `openUrl` opens validated http(s) URLs in a new tab with
 * `window.open(url, "_blank", "noopener,noreferrer")`, falling back to an
 * anchor click when `window.open` is unavailable. A `null` return from
 * `window.open` means the browser popup blocker intervened and surfaces as
 * a `PlatformCapabilityError`, never as a silent no-op.
 *
 * `openPath` and `revealItemInDir` always throw a `PlatformCapabilityError`:
 * a browser cannot open a local path with a system application or reveal
 * it in a file manager, and local paths are never echoed in errors.
 *
 * Downloads go through an anchor element: `downloadUrl` points the anchor
 * at the validated URL, `downloadBlob` points it at an object URL that is
 * revoked shortly after the click.
 *
 * All browser globals are read at call time through `globalThis`, never
 * captured at module load, so unit tests can substitute mocks and so the
 * module is safe to import during server-side rendering.
 */

import { capabilityError } from "../errors";
import type { OpenerAdapter } from "./interface";
import { validateHttpUrl } from "./url-validation";

/** Delay before revoking a download object URL, in milliseconds. */
const DOWNLOAD_URL_REVOKE_DELAY_MS = 1000;

function getGlobals(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function getDocument(): Document | undefined {
  const value = getGlobals()["document"];
  return value === undefined ? undefined : (value as Document);
}

function openWithWindowOpen(href: string): unknown | undefined {
  const globals = getGlobals();
  const windowValue = globals["window"];
  if (windowValue !== null && typeof windowValue === "object") {
    const openFn = (windowValue as Record<string, unknown>)["open"];
    if (typeof openFn !== "function") {
      return undefined;
    }
    // Call with the window object as `this`: an unbound `window.open`
    // throws an illegal invocation error in browsers.
    return (
      openFn as (url: string, target: string, features: string) => unknown
    ).call(windowValue, href, "_blank", "noopener,noreferrer");
  }
  const openFn = globals["open"];
  if (typeof openFn !== "function") {
    return undefined;
  }
  return (openFn as (url: string, target: string, features: string) => unknown).call(
    globalThis,
    href,
    "_blank",
    "noopener,noreferrer",
  );
}

function hasWindowOpen(): boolean {
  const globals = getGlobals();
  const windowValue = globals["window"];
  if (windowValue !== null && typeof windowValue === "object") {
    return (
      typeof (windowValue as Record<string, unknown>)["open"] === "function"
    );
  }
  return typeof globals["open"] === "function";
}

function requireDocument(capability: string): Document {
  const document = getDocument();
  if (!document || !document.body) {
    throw capabilityError(
      "unavailable",
      "opener",
      capability,
      "web",
      "This operation requires a browser document with a body element.",
    );
  }
  return document;
}

function clickAnchor(
  document: Document,
  href: string,
  filename: string | undefined,
  openInNewTab: boolean,
  capability: string,
): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  if (filename !== undefined) {
    anchor.download = filename;
  }
  if (openInNewTab) {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
  const body = document.body;
  if (!body) {
    throw capabilityError(
      "unavailable",
      "opener",
      capability,
      "web",
      "This operation requires a browser document with a body element.",
    );
  }
  body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

function defaultDownloadFilename(url: URL): string {
  const segments = url.pathname.split("/").filter((part) => part !== "");
  const last = segments[segments.length - 1];
  if (!last) {
    return "download";
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Create the web opener adapter. */
export function createWebOpenerAdapter(): OpenerAdapter {
  return {
    async openUrl(url: string | URL, openWith?: string): Promise<void> {
      // `openWith` cannot be honored in a browser: there is no way to
      // choose the application that opens a URL. It is accepted only for
      // signature compatibility with the desktop adapter.
      void openWith;
      const validated = validateHttpUrl(url);
      if (hasWindowOpen()) {
        const opened = openWithWindowOpen(validated.href);
        if (opened === null) {
          throw capabilityError(
            "unavailable",
            "opener",
            "openUrl",
            "web",
            "The browser blocked the new tab (popup blocker). Allow popups for this site or open the link from the address bar.",
          );
        }
        return;
      }
      const document = requireDocument("openUrl");
      clickAnchor(document, validated.href, undefined, true, "openUrl");
    },

    async openPath(path: string, openWith?: string): Promise<void> {
      void path;
      void openWith;
      throw capabilityError(
        "unsupported",
        "opener",
        "openPath",
        "web",
        "Local paths cannot be opened from the browser. Use the download methods for workspace files once their content or file URL is available.",
      );
    },

    async revealItemInDir(path: string): Promise<void> {
      void path;
      throw capabilityError(
        "unsupported",
        "opener",
        "revealItemInDir",
        "web",
        "Local paths cannot be revealed in a file manager from the browser.",
      );
    },

    async downloadUrl(
      url: string | URL,
      filename?: string,
    ): Promise<void> {
      const validated = validateHttpUrl(url, "downloadUrl");
      const document = requireDocument("downloadUrl");
      const trimmed = filename?.trim();
      const name =
        trimmed !== undefined && trimmed !== ""
          ? trimmed
          : defaultDownloadFilename(validated);
      clickAnchor(document, validated.href, name, false, "downloadUrl");
    },

    async downloadBlob(blob: Blob, filename: string): Promise<void> {
      const name = filename.trim();
      if (name === "") {
        throw capabilityError(
          "invalid_argument",
          "opener",
          "downloadBlob",
          "web",
          "A non-empty file name is required for a blob download.",
        );
      }
      const document = requireDocument("downloadBlob");
      const urlCtor = getGlobals()["URL"] as
        | {
            createObjectURL?: (blob: Blob) => string;
            revokeObjectURL?: (url: string) => void;
          }
        | undefined;
      if (typeof urlCtor?.createObjectURL !== "function") {
        throw capabilityError(
          "unavailable",
          "opener",
          "downloadBlob",
          "web",
          "Download requires URL.createObjectURL, which is unavailable.",
        );
      }
      const objectUrl = urlCtor.createObjectURL(blob);
      try {
        clickAnchor(document, objectUrl, name, false, "downloadBlob");
      } catch (error) {
        if (typeof urlCtor.revokeObjectURL === "function") {
          urlCtor.revokeObjectURL(objectUrl);
        }
        throw error;
      }
      const revoke = urlCtor.revokeObjectURL;
      if (typeof revoke === "function") {
        setTimeout(() => {
          revoke(objectUrl);
        }, DOWNLOAD_URL_REVOKE_DELAY_MS);
      }
    },
  };
}
