// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * ClipboardAdapter interface (migration wave G3).
 *
 * Replaces two clipboard surfaces:
 * - plugin-clipboard-manager: writeText, writeImage, writeHtml.
 * - tauri-plugin-clipboard-api (vendor package, 8 importing files):
 *   hasText, hasImage, readText, readImageBase64, clear, writeText.
 * Signatures mirror the installed upstream declarations of both
 * packages. The single writeText method serves both surfaces; the
 * optional label option comes from the manager package and is used at
 * 2 call sites.
 *
 * writeImage takes raw bytes, not a Tauri Image object. The 2 call sites
 * that write images today build an Image from PNG bytes first and close
 * it afterwards; the G3 migration passes the bytes directly and the
 * Tauri implementation builds the image internally. The readText and
 * readImage functions of the manager package itself are not imported
 * anywhere and are excluded; read access enters through the vendor
 * package names above.
 */
export interface ClipboardAdapter {
  writeText(text: string, opts?: { label?: string }): Promise<void>;
  writeImage(
    image: string | Uint8Array | ArrayBuffer | number[],
  ): Promise<void>;
  writeHtml(html: string, altText?: string): Promise<void>;
  hasText(): Promise<boolean>;
  hasImage(): Promise<boolean>;
  readText(): Promise<string>;
  readImageBase64(): Promise<string>;
  clear(): Promise<void>;
}
