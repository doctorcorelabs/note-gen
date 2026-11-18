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
// The seal key is the 32-byte key decoded from ENCRYPTION_KEY by
// the one shared decoder (decodeEncryptionKey in lib/crypto/
// key-ring.ts), the same decoder the settings key ring uses: hex
// (64 characters), base64, or base64url. Any other value, including
// a passphrase-shaped value and a whitespace-only value, yields
// null and the caller fails closed (G11b). There is deliberately no
// SHA-256 fallback: hashing an arbitrary string into a key let weak
// or publicly known values seal TOTP secrets with a key guessable
// offline, and let the TOTP path silently disagree with the strict
// settings path over the same variable. For a valid 32-byte key the
// derived bytes are unchanged, so seals written before this change
// still open. Domain separation between the TOTP seal key and the
// envelope key, and versioned TOTP key rotation, remain open work
// (DA-02-K02): changing the derived bytes would orphan existing
// seals and needs a re-seal migration first.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { decodeEncryptionKey } from '../lib/crypto/key-ring.js';

export const TOTP_SEAL_KEY_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function deriveSealKey(encryptionKeyValue: string | undefined): Buffer | null {
  if (encryptionKeyValue === undefined || encryptionKeyValue === '') {
    return null;
  }
  try {
    return decodeEncryptionKey(encryptionKeyValue);
  } catch {
    return null;
  }
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
