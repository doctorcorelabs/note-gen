// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// AES-256-GCM sealing of TOTP secrets (desain-auth.md sections 1.4
// and 8.3). Sealed format, exactly as designed: base64url of
// iv (12 bytes) + tag (16 bytes) + ciphertext. Key derivation is a
// contract between this worker (verification) and V3-02
// (enrollment): V3-02 MUST seal with deriveSealKey on the same
// ENCRYPTION_KEY value, or verification here cannot unseal what
// enrollment stored. Key version 1 denotes exactly this derivation.
//
// Key value precedence (documented, deterministic): a base64 value
// that decodes to 32 bytes wins; else a 64-hex-character value wins;
// else SHA-256 of the raw string is used. Operators should set a
// base64 or hex 32-byte key; the SHA-256 fallback exists so a
// passphrase-shaped value fails closed into a defined key instead of
// crashing the server at an unpredictable point.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const TOTP_SEAL_KEY_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function deriveSealKey(encryptionKeyValue: string | undefined): Buffer | null {
  if (encryptionKeyValue === undefined || encryptionKeyValue === '') {
    return null;
  }
  const trimmed = encryptionKeyValue.trim();
  const base64Candidate = Buffer.from(trimmed, 'base64');
  if (base64Candidate.length === 32 && base64Candidate.toString('base64').replace(/=+$/, '') === trimmed.replace(/=+$/, '')) {
    return base64Candidate;
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  return createHash('sha256').update(trimmed, 'utf8').digest();
}

export class TotpSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpSealError';
  }
}

export function sealTotpSecret(secret: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

// Returns null on any failure (wrong version, bad format, bad key,
// bad tag). Callers treat null as an unverifiable credential and
// fail closed with the generic invalid-code response.
export function unsealTotpSecret(sealed: string, key: Buffer, keyVersion: number): string | null {
  if (keyVersion !== TOTP_SEAL_KEY_VERSION) {
    return null;
  }
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < IV_LENGTH + TAG_LENGTH + 1) {
      return null;
    }
    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
