// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Local clipboard adapter interface for the web fork (worker V2-12).
 *
 * Follows the ClipboardAdapter inventory in the V1-05 registry design
 * (`writeText`, `writeImage`, `writeHtml` from
 * `@tauri-apps/plugin-clipboard-manager`), with the following binding
 * decisions for the web implementation, to be reconciled by the integrator
 * against the canonical interfaces owned by V2-04:
 *
 * 1. `writeImage` takes bytes (`Uint8Array`) or a `Blob`, never a Tauri
 *    `Image` object. Upstream, the only call sites build the image with
 *    `TauriImage.fromBytes(png)` from PNG bytes and pass it to
 *    `writeImage`; V1-05 assigns building the `TauriImage` to the Tauri
 *    implementation. On the web the bytes become a `Blob` inside a
 *    `ClipboardItem`. The `mimeType` argument defaults to `image/png`,
 *    matching the upstream PNG bytes; callers with another encoded format
 *    must pass its MIME type explicitly.
 * 2. `writeHtml` mirrors the plugin signature `writeHtml(html, text?)`:
 *    the plain-text part is optional. When omitted, the web
 *    implementation writes only a `text/html` clipboard part.
 * 3. There are intentionally NO read methods (`readText`, `readImage`,
 *    `hasText`, `hasImage`, `clear`). V1-05 excludes them from the Fase 1
 *    interface because no `plugin-clipboard-manager` import mentions them.
 *    Note for the integrator: a second clipboard surface exists upstream,
 *    `tauri-plugin-clipboard-api` (8 files, read-oriented: `readText`,
 *    `readImageBase64`, `hasText`, `hasImage`, `clear`, plus one
 *    `writeText`), which is NOT an `@tauri-apps/*` specifier and is NOT
 *    covered by the V1-05 inventory. Whether that surface gets an adapter
 *    or a separate migration decision is out of scope for this worker.
 * 4. Permission failures surface as `PlatformCapabilityError` with code
 *    `permission_denied`, so the UI can catch them and offer the
 *    show-the-text-for-manual-copy fallback described in V1-05. Error
 *    messages never echo clipboard content.
 */

/**
 * Image input for `ClipboardAdapter.writeImage`: raw encoded image bytes
 * (the upstream shape) or a `Blob` holding encoded image data.
 */
export type ClipboardImageInput = Uint8Array | Blob;

export interface ClipboardAdapter {
  /**
   * Write plain text to the clipboard. Uses the async Clipboard API with
   * a document `execCommand` fallback on the web. Throws a
   * `PlatformCapabilityError` when permission is denied or no write path
   * is available.
   */
  writeText(text: string): Promise<void>;
  /**
   * Write an image to the clipboard. `mimeType` defaults to `image/png`.
   * Throws a `PlatformCapabilityError` when the browser lacks
   * `ClipboardItem` support, when permission is denied, or when
   * `mimeType` is not a valid image MIME type.
   */
  writeImage(
    image: ClipboardImageInput,
    mimeType?: string,
  ): Promise<void>;
  /**
   * Write HTML plus an optional plain-text alternative to the clipboard.
   * Throws a `PlatformCapabilityError` when the browser lacks
   * `ClipboardItem` support or when permission is denied.
   */
  writeHtml(html: string, text?: string): Promise<void>;
}
