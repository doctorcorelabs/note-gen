// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Record asset key design (V3-31 partial, overlap batch AD-57).
//
// Contract: kontrak-api-kanonis.md section 3.7 and
// fase1/desain-record-search.md section 4 (V1-14). A record asset is
// addressed ONLY by an opaque key. Keys are strictly distinguished
// from workspace media, which use relative POSIX paths
// (kontrak 3.1, V1-09 section 7; merge plan W26 stresses this
// distinction). The two address spaces never mix:
//
// - Media: client-supplied relative path, validated and resolved
//   inside the workspace root (server/src/lib/paths.ts), served at
//   GET /api/workspace/media/<path>, typed partly by extension.
// - Record assets: server-generated opaque key, never a filesystem
//   path, served at GET /api/assets/:assetKey, typed only by magic
//   bytes. No key is ever passed through path validation, path
//   resolution, or extension logic, and no media path is ever
//   accepted as an asset key.
//
// Key format (decided here, for the full V3-31 to keep or amend
// with a recorded decision; V1-14 section 4.1 states its example
// format is only an example and clients must treat keys as
// opaque):
//
//   ast_<32 lowercase hex digits>        (36 characters total)
//
// The 32 hex digits are 128 bits from crypto.randomBytes. The
// format carries no timestamp, no workspace id, no file name, and
// no path component: nothing about storage layout leaks through
// the key, and a key from one workspace reveals nothing usable in
// another. The charset is [a-z0-9_] only, so a valid key contains
// no slash, no backslash, no dot, no percent sign, and no
// whitespace. Traversal is impossible by construction: there is no
// dot segment to normalize, no separator to escape through, and no
// decoding step that could turn an encoded separator into a real
// one. Validation is exact-match only: this module never trims,
// decodes, or normalizes a candidate, because a candidate that
// needs such repair is not a key.
//
// Uniqueness: 128 random bits make accidental collision negligible.
// The store still treats generation as retryable on collision (see
// store.ts, put-if-absent save, and service.ts, key retry loop): a
// workspace is discarded and a fresh one is generated, so
// uniqueness never depends on randomness alone.
//
// Thumbnail keys (V1-14 section 4.3) use this same key space and
// this same validation when they exist; no thumbnail key format,
// size variant, or derivation rule is invented here. The full V3-31
// verifies the thumbnail decision from the design before building
// any thumbnail behavior.

import { randomBytes } from 'node:crypto';

export const ASSET_KEY_PREFIX = 'ast_';

export const ASSET_KEY_HEX_LENGTH = 32;

export const ASSET_KEY_LENGTH = ASSET_KEY_PREFIX.length + ASSET_KEY_HEX_LENGTH;

export const ASSET_KEY_PATTERN = /^ast_[0-9a-f]{32}$/;

// Generates a fresh asset key. Randomness comes from the operating
// system CSPRNG via crypto.randomBytes; no counter, timestamp, or
// client input participates, so keys are unpredictable and carry no
// ordering or ownership information.
export function generateAssetKey(): string {
  return `${ASSET_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
}

// Exact-match key check. Returns true only for strings that match
// the canonical format character for character. Everything else is
// rejected: non-strings, wrong prefix, wrong length, uppercase hex,
// embedded slashes, backslashes, dots, percent escapes, spaces, and
// control characters. Callers must treat a false result the same
// way they treat an unknown key (404 not_found, generic answer),
// never as a distinct validation error on the read path, so a
// malformed key cannot be distinguished from a foreign-workspace
// key by an unauthenticated observer of status codes.
export function isValidAssetKey(value: unknown): value is string {
  return typeof value === 'string' && value.length === ASSET_KEY_LENGTH && ASSET_KEY_PATTERN.test(value);
}
