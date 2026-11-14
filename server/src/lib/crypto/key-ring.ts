// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Encryption key loading and key-ring management for envelope encryption.
//
// Canonical key source: the ENCRYPTION_KEY environment variable
// (desain-auth.md section 1.4; the legacy SECRETS_ENCRYPTION_KEY alias
// was removed and is never read by this module). The key is a 32-byte
// AES-256 key encoded as hex (64 characters), base64, or base64url.
//
// Rotation support: ENCRYPTION_KEY_VERSION names the version of the
// current key (default 1). ENCRYPTION_PREVIOUS_KEYS carries retired
// keys that are still needed to open older sealed data, as a
// comma-separated list of `version=encodedKey` pairs, for example
// `1=<previous key>,2=<older key>`. Previous keys are decryption-only;
// sealing always uses the current key. See the V3-10b report for the
// full rotation procedure.
//
// No function in this module logs, prints, or embeds key material in
// error messages. Callers must treat returned key bytes the same way.

import {
  invalidKeyError,
  missingKeyError,
} from './errors.js';

export const ENCRYPTION_KEY_BYTES = 32;
export const DEFAULT_KEY_VERSION = 1;
const MAX_KEY_VERSION = 2147483647;

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const BASE64_PADDED = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_UNPADDED = /^[A-Za-z0-9_-]+$/;

/** Decode one 32-byte encryption key from its hex, base64, or base64url form. */
export function decodeEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw invalidKeyError('key value is empty');
  }
  if (HEX_64.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  if (BASE64_PADDED.test(trimmed) && trimmed.length % 4 === 0) {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === ENCRYPTION_KEY_BYTES && decoded.toString('base64') === trimmed) {
      return decoded;
    }
    throw invalidKeyError('key must decode to exactly 32 bytes');
  }
  if (BASE64URL_UNPADDED.test(trimmed)) {
    const decoded = Buffer.from(trimmed, 'base64url');
    if (decoded.length === ENCRYPTION_KEY_BYTES && decoded.toString('base64url') === trimmed) {
      return decoded;
    }
    throw invalidKeyError('key must decode to exactly 32 bytes');
  }
  throw invalidKeyError('key must be hex, base64, or base64url encoded');
}

function parseKeyVersion(raw: string | undefined, label: string, allowEmpty: boolean): number {
  if (raw === undefined || raw.trim() === '') {
    if (!allowEmpty) {
      throw invalidKeyError(`${label} must be a positive integer`);
    }
    return DEFAULT_KEY_VERSION;
  }
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw invalidKeyError(`${label} must be a positive integer`);
  }
  const version = Number(trimmed);
  if (!Number.isSafeInteger(version) || version < 1 || version > MAX_KEY_VERSION) {
    throw invalidKeyError(`${label} must be a positive integer`);
  }
  return version;
}

function parsePreviousKeys(raw: string | undefined): Array<{ version: number; key: Buffer }> {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  const entries: Array<{ version: number; key: Buffer }> = [];
  const seen = new Set<number>();
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (entry === '') {
      continue;
    }
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw invalidKeyError('ENCRYPTION_PREVIOUS_KEYS entries must use version=key form');
    }
    const version = parseKeyVersion(entry.slice(0, eq), 'ENCRYPTION_PREVIOUS_KEYS version', false);
    if (seen.has(version)) {
      throw invalidKeyError('ENCRYPTION_PREVIOUS_KEYS lists the same version twice');
    }
    seen.add(version);
    entries.push({ version, key: decodeEncryptionKey(entry.slice(eq + 1)) });
  }
  return entries;
}

export interface KeyRingEntry {
  readonly version: number;
  readonly key: Buffer;
}

/**
 * An immutable set of encryption keys: one current key used for sealing,
 * plus retired keys kept only for opening older sealed data.
 */
export class KeyRing {
  readonly currentVersion: number;
  private readonly keysByVersion: ReadonlyMap<number, Buffer>;

  constructor(entries: readonly KeyRingEntry[], currentVersion: number) {
    if (entries.length === 0) {
      throw missingKeyError();
    }
    const byVersion = new Map<number, Buffer>();
    for (const entry of entries) {
      if (!Number.isSafeInteger(entry.version) || entry.version < 1 || entry.version > MAX_KEY_VERSION) {
        throw invalidKeyError('key version must be a positive integer');
      }
      if (!Buffer.isBuffer(entry.key) || entry.key.length !== ENCRYPTION_KEY_BYTES) {
        throw invalidKeyError('key must be exactly 32 bytes');
      }
      if (byVersion.has(entry.version)) {
        throw invalidKeyError('key ring lists the same version twice');
      }
      byVersion.set(entry.version, Buffer.from(entry.key));
    }
    if (!byVersion.has(currentVersion)) {
      throw invalidKeyError('current key version has no key in the ring');
    }
    this.currentVersion = currentVersion;
    this.keysByVersion = byVersion;
  }

  /** Versions present in the ring, ascending. */
  versions(): number[] {
    return [...this.keysByVersion.keys()].sort((a, b) => a - b);
  }

  has(version: number): boolean {
    return this.keysByVersion.has(version);
  }

  /** A copy of the key for a version, or undefined when the ring has no such key. */
  keyFor(version: number): Buffer | undefined {
    const key = this.keysByVersion.get(version);
    return key === undefined ? undefined : Buffer.from(key);
  }

  /** A copy of the current sealing key. */
  currentKey(): Buffer {
    const key = this.keysByVersion.get(this.currentVersion);
    if (key === undefined) {
      throw missingKeyError();
    }
    return Buffer.from(key);
  }
}

export type KeyRingEnv = Readonly<Record<string, string | undefined>>;

/**
 * Build a key ring from environment variables.
 *
 * Reads ENCRYPTION_KEY (required), ENCRYPTION_KEY_VERSION (optional,
 * default 1), and ENCRYPTION_PREVIOUS_KEYS (optional). The legacy
 * SECRETS_ENCRYPTION_KEY name is never consulted: an environment that
 * sets only the legacy name fails with ENCRYPTION_KEY_MISSING, so a
 * missing canonical key can never silently fall back to anything.
 */
export function loadKeyRingFromEnv(env: KeyRingEnv): KeyRing {
  const rawKey = env.ENCRYPTION_KEY;
  if (rawKey === undefined || rawKey.trim() === '') {
    throw missingKeyError();
  }
  const currentVersion = parseKeyVersion(env.ENCRYPTION_KEY_VERSION, 'ENCRYPTION_KEY_VERSION', true);
  const currentKey = decodeEncryptionKey(rawKey);
  const previous = parsePreviousKeys(env.ENCRYPTION_PREVIOUS_KEYS);
  for (const entry of previous) {
    if (entry.version === currentVersion) {
      throw invalidKeyError('ENCRYPTION_PREVIOUS_KEYS must not repeat the current key version');
    }
  }
  return new KeyRing([{ version: currentVersion, key: currentKey }, ...previous], currentVersion);
}
