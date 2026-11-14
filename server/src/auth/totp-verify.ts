// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// TOTP verification (RFC 6238, SHA-1, 30-second steps, 6 digits,
// window of one step either side) with anti-replay through the
// last_used_step recorded on the credential (desain-auth.md
// sections 1.4 and 3.4). This module is verification only: secret
// generation and enrollment belong to V3-02. Recovery codes are
// normalized (lowercase, no spaces or hyphens) before hashing, per
// desain-auth.md section 1.5.

import { createHmac } from 'node:crypto';
import { safeEqual } from './crypto.js';
import { TOTP_DIGITS, TOTP_STEP_SECONDS, TOTP_WINDOW_STEPS } from './values.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(value: string): Buffer {
  const cleaned = value.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (cleaned.length === 0) {
    throw new Error('empty base32 secret');
  }
  let bits = 0;
  let valueBits = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('invalid base32 character');
    }
    valueBits = (valueBits << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((valueBits >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function totpCodeAt(secretBytes: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secretBytes).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function currentTotpCounter(nowMs: number): number {
  return Math.floor(nowMs / (TOTP_STEP_SECONDS * 1000));
}

export function isTotpCodeShape(code: unknown): code is string {
  return typeof code === 'string' && /^\d{6}$/.test(code.trim());
}

export type TotpVerifyResult =
  | { valid: true; step: number }
  | { valid: false; reason: 'invalid' | 'replayed' };

// Verifies a code against the window around the current step. A
// matching step at or below lastUsedStep is a replay, not a success.
// The caller must claim the returned step with a conditional store
// update (claimTotpStep) before creating the session; verification
// alone does not consume the code.
export function verifyTotpCode(input: {
  secretBase32: string;
  code: string;
  nowMs: number;
  lastUsedStep: number | null;
}): TotpVerifyResult {
  const code = input.code.trim();
  if (!isTotpCodeShape(code)) {
    return { valid: false, reason: 'invalid' };
  }
  let secretBytes: Buffer;
  try {
    secretBytes = decodeBase32(input.secretBase32);
  } catch {
    return { valid: false, reason: 'invalid' };
  }
  const current = currentTotpCounter(input.nowMs);
  let replayed = false;
  for (let step = current - TOTP_WINDOW_STEPS; step <= current + TOTP_WINDOW_STEPS; step += 1) {
    if (step < 0) {
      continue;
    }
    if (safeEqual(totpCodeAt(secretBytes, step), code)) {
      if (input.lastUsedStep !== null && step <= input.lastUsedStep) {
        replayed = true;
        continue;
      }
      return { valid: true, step };
    }
  }
  return { valid: false, reason: replayed ? 'replayed' : 'invalid' };
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/[\s-]/g, '');
}
