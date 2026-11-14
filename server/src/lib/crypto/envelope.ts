// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Versioned envelope encryption for server-side secrets (AD-16).
//
// Construction: AES-256-GCM via node:crypto, no new dependencies. The
// key from the environment is the wrapping key; every sealed value gets
// a fresh random 12-byte nonce, and the key version that sealed it is
// recorded with the data so rotation can keep opening older values.
// This is the construction desain-store-adapter.md section 4.3 fixes
// for the MVP: a per-secret data key (full envelope with a wrapped
// data key per value) is hardening the design leaves open, not a
// requirement, and is not silently added here.
//
// Two forms, one construction:
//
// 1. Parts form, for the `secrets` table (which has `ciphertext`,
//    `nonce`, and `key_version` columns and no version column):
//    - `nonce` holds the 12-byte IV.
//    - `ciphertext` holds one format-version byte (0x01), then the
//      GCM ciphertext, then the 16-byte GCM authentication tag.
//    - `key_version` holds the sealing key version.
//    The version byte travels inside the stored bytes because the
//    table has nowhere else to keep it. The GCM tag authenticates
//    the ciphertext and tag bytes that follow it; the version byte
//    itself is validated explicitly on open, so tampering with it
//    fails the open instead of changing the meaning of the bytes.
//
// 2. String form, a single self-describing value for stores that keep
//    one column (for example the sealed TOTP secret):
//    `ngsec1:` + base64url(version byte || key version uint32BE ||
//    nonce || ciphertext || tag).
//
// Failure behaviour is fail-closed throughout: a missing or invalid
// key, an unknown key version, a malformed envelope, an unsupported
// format version, and an authentication failure all throw a typed
// CryptoError. There is no plaintext fallback anywhere in this module,
// and no function logs secret material.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import {
  decryptionFailedError,
  malformedEnvelopeError,
  unknownKeyVersionError,
  unsupportedVersionError,
} from './errors.js';
import {
  loadKeyRingFromEnv,
  type KeyRing,
  type KeyRingEnv,
} from './key-ring.js';

export const ENVELOPE_FORMAT_VERSION = 1;
export const ENVELOPE_STRING_PREFIX = 'ngsec1:';
const VERSION_BYTE = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_VERSION_BYTES = 4;
const AAD_DOMAIN = 'notegen-secrets/envelope-v1';

export interface SealOptions {
  /**
   * Optional caller additional authenticated data, bound into the GCM
   * tag. When a value is sealed with AAD, the identical AAD is
   * required to open it, including across rotation. Callers that bind
   * ciphertext to a row (for example `secrets:<kind>:<ref>`) must pass
   * the same value on every open and every rotation of that row.
   */
  readonly aad?: string | Buffer;
}

/**
 * The parts form of a sealed value, shaped for the `secrets` table:
 * `ciphertext` and `nonce` go to their bytea columns and `keyVersion`
 * to `key_version`. `ciphertext` starts with the one-byte format
 * version, followed by the GCM ciphertext and the 16-byte tag.
 */
export interface SealedParts {
  readonly formatVersion: typeof ENVELOPE_FORMAT_VERSION;
  readonly keyVersion: number;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
}

export interface SealedStringHeader {
  readonly formatVersion: typeof ENVELOPE_FORMAT_VERSION;
  readonly keyVersion: number;
}

function aadBytes(options: SealOptions | undefined): Buffer {
  const domain = Buffer.from(AAD_DOMAIN, 'utf8');
  const caller = options?.aad;
  if (caller === undefined) {
    return domain;
  }
  const callerBytes = typeof caller === 'string' ? Buffer.from(caller, 'utf8') : caller;
  return Buffer.concat([domain, Buffer.from([0]), callerBytes]);
}

function toBuffer(plaintext: string | Buffer): Buffer {
  return typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
}

function sealWithKey(
  key: Buffer,
  keyVersion: number,
  plaintext: Buffer,
  options: SealOptions | undefined,
): SealedParts {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadBytes(options));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Object.freeze({
    formatVersion: ENVELOPE_FORMAT_VERSION,
    keyVersion,
    nonce,
    ciphertext: Buffer.concat([Buffer.from([VERSION_BYTE]), ciphertext, tag]),
  });
}

function openWithKey(
  key: Buffer,
  parts: SealedParts,
  options: SealOptions | undefined,
): Buffer {
  if (parts.formatVersion !== ENVELOPE_FORMAT_VERSION) {
    throw unsupportedVersionError();
  }
  if (!Buffer.isBuffer(parts.nonce) || parts.nonce.length !== NONCE_BYTES) {
    throw malformedEnvelopeError();
  }
  if (!Buffer.isBuffer(parts.ciphertext) || parts.ciphertext.length < 1 + TAG_BYTES) {
    throw malformedEnvelopeError();
  }
  if (parts.ciphertext[0] !== VERSION_BYTE) {
    throw unsupportedVersionError();
  }
  const body = parts.ciphertext.subarray(1);
  const ciphertext = body.subarray(0, body.length - TAG_BYTES);
  const tag = body.subarray(body.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, parts.nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aadBytes(options));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw decryptionFailedError();
  }
}

function encodeSealedString(parts: SealedParts): string {
  const keyVersion = Buffer.alloc(KEY_VERSION_BYTES);
  keyVersion.writeUInt32BE(parts.keyVersion, 0);
  const body = Buffer.concat([
    Buffer.from([VERSION_BYTE]),
    keyVersion,
    parts.nonce,
    // Parts ciphertext already starts with its own version byte; the
    // string form keeps one version byte at the front and stores the
    // GCM output (ciphertext + tag) after the nonce.
    parts.ciphertext.subarray(1),
  ]);
  return ENVELOPE_STRING_PREFIX + body.toString('base64url');
}

function decodeSealedString(envelope: string): SealedParts {
  if (typeof envelope !== 'string' || !envelope.startsWith(ENVELOPE_STRING_PREFIX)) {
    throw malformedEnvelopeError();
  }
  const encoded = envelope.slice(ENVELOPE_STRING_PREFIX.length);
  if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw malformedEnvelopeError();
  }
  const body = Buffer.from(encoded, 'base64url');
  if (body.toString('base64url') !== encoded) {
    throw malformedEnvelopeError();
  }
  const minimum = 1 + KEY_VERSION_BYTES + NONCE_BYTES + TAG_BYTES;
  if (body.length < minimum) {
    throw malformedEnvelopeError();
  }
  if (body[0] !== VERSION_BYTE) {
    throw unsupportedVersionError();
  }
  const keyVersion = body.readUInt32BE(1);
  if (keyVersion < 1) {
    throw malformedEnvelopeError();
  }
  const nonce = body.subarray(1 + KEY_VERSION_BYTES, 1 + KEY_VERSION_BYTES + NONCE_BYTES);
  const gcmOutput = body.subarray(1 + KEY_VERSION_BYTES + NONCE_BYTES);
  return {
    formatVersion: ENVELOPE_FORMAT_VERSION,
    keyVersion,
    nonce: Buffer.from(nonce),
    ciphertext: Buffer.concat([Buffer.from([VERSION_BYTE]), Buffer.from(gcmOutput)]),
  };
}

/** Read the header of a string-form envelope without opening it. */
export function inspectSealedString(envelope: string): SealedStringHeader {
  const parts = decodeSealedString(envelope);
  return { formatVersion: parts.formatVersion, keyVersion: parts.keyVersion };
}

export class CryptoService {
  private readonly keyRing: KeyRing;

  constructor(keyRing: KeyRing) {
    this.keyRing = keyRing;
  }

  get currentKeyVersion(): number {
    return this.keyRing.currentVersion;
  }

  /** Seal a value with the current key, in parts form for the `secrets` table. */
  encrypt(plaintext: string | Buffer, options?: SealOptions): SealedParts {
    return sealWithKey(this.keyRing.currentKey(), this.keyRing.currentVersion, toBuffer(plaintext), options);
  }

  /** Open a parts-form sealed value, selecting the key by its recorded version. */
  decrypt(parts: SealedParts, options?: SealOptions): Buffer {
    if (!Number.isSafeInteger(parts.keyVersion) || parts.keyVersion < 1) {
      throw malformedEnvelopeError();
    }
    const key = this.keyRing.keyFor(parts.keyVersion);
    if (key === undefined) {
      throw unknownKeyVersionError();
    }
    return openWithKey(key, parts, options);
  }

  decryptToString(parts: SealedParts, options?: SealOptions): string {
    return this.decrypt(parts, options).toString('utf8');
  }

  /** Seal a value with the current key, in single-string self-describing form. */
  seal(plaintext: string | Buffer, options?: SealOptions): string {
    return encodeSealedString(this.encrypt(plaintext, options));
  }

  /** Open a string-form sealed value, selecting the key by its recorded version. */
  open(envelope: string, options?: SealOptions): Buffer {
    return this.decrypt(decodeSealedString(envelope), options);
  }

  openToString(envelope: string, options?: SealOptions): string {
    return this.open(envelope, options).toString('utf8');
  }

  /**
   * Whether a sealed value was sealed under a retired key and should be
   * re-sealed under the current key. Malformed input throws instead of
   * answering, so a rotation sweep never mistakes corruption for age.
   */
  needsRotation(sealed: SealedParts | string): boolean {
    const keyVersion = typeof sealed === 'string' ? inspectSealedString(sealed).keyVersion : sealed.keyVersion;
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
      throw malformedEnvelopeError();
    }
    return keyVersion !== this.keyRing.currentVersion;
  }

  /**
   * Re-seal a parts-form value under the current key. Values already at
   * the current version are returned unchanged. The retired key must
   * still be in the ring, and the same AAD used at seal time (if any)
   * must be passed again.
   */
  rotateParts(parts: SealedParts, options?: SealOptions): SealedParts {
    if (!this.needsRotation(parts)) {
      return parts;
    }
    return this.encrypt(this.decrypt(parts, options), options);
  }

  /** String-form equivalent of rotateParts. */
  rotateString(envelope: string, options?: SealOptions): string {
    if (!this.needsRotation(envelope)) {
      return envelope;
    }
    return this.seal(this.open(envelope, options), options);
  }
}

export function createCryptoService(keyRing: KeyRing): CryptoService {
  return new CryptoService(keyRing);
}

/**
 * Build a crypto service from environment variables. Throws
 * ENCRYPTION_KEY_MISSING when neither ENCRYPTION_KEY nor the legacy
 * SECRETS_ENCRYPTION_KEY alias is set, so a secrets service built
 * on this factory fails explicitly at startup instead of ever
 * handling secrets in plaintext. See loadKeyRingFromEnv for the
 * exact name precedence.
 */
export function createCryptoServiceFromEnv(env: KeyRingEnv): CryptoService {
  return new CryptoService(loadKeyRingFromEnv(env));
}
