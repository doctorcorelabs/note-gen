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
 *
 * Merge M11 reconciliation (audit V2-40): the G0 signature is
 * kept. The audit row preferring a V2-14 options signature was
 * written against a stale snapshot; the branch tip carries an
 * interface mechanically identical to G0 (verified
 * comment-stripped), and the implementation uses this signature.
 * An AssetUrlOptions shape (revision/cacheBuster) is a wave-3
 * design item for the media-URL call-site migration, not a
 * merge-time invention. Callers append ?v= values themselves.
 */
export interface AssetUrlAdapter {
  convertFileSrc(filePath: string, protocol?: string): string;
}
