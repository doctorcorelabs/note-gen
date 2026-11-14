// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * AssetUrlAdapter interface (migration wave G3).
 *
 * Replaces the convertFileSrc function from api/core, which turns a disk
 * path into an asset-protocol URL for images. The function is synchronous
 * upstream and stays synchronous here. Signatures mirror the installed
 * upstream declarations (api 2.11.1). All call sites pass a single
 * argument; the optional protocol argument is kept for pass-through
 * fidelity.
 */
export interface AssetUrlAdapter {
  convertFileSrc(filePath: string, protocol?: string): string;
}
