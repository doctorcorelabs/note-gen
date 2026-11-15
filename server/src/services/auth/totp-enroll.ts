// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// TOTP enrollment service (kontrak-api-kanonis.md section 3.12;
// desain-auth.md sections 1.4 and 3.5; V3-02 part 4). This module
// owns the enrollment-only mechanics that the verification module
// deliberately does not: secret generation, the otpauth URL, the
// recovery-code batch, the pending-stage expiry rule, and the
// persistence port for credential and recovery-code writes.
//
// Sealing contract: secrets are sealed with sealTotpSecret over a
// key from deriveSealKey (see ../../auth/totp-seal.ts), the exact
// format the login verification path unseals. The V3-10b
// SecretCipher parts form (separate ciphertext/nonce columns for
// the secrets table) cannot be stored in the single
// totp_credentials.secret_sealed text column and cannot be unsealed
// by unsealTotpSecret, so it is not used here; the fail-closed rule
// is the same either way, enrollment answers 503 when no
// encryption key is configured and never stores plaintext. The
// routes enforce the 503; this module never invents a key.
//
// Pending-stage storage: there is no pending-enrollment table and
// totp_credentials has no created_at column, so the staged secret
// is stored in the credential row itself (desain-auth.md section
// 1.4: the stage-1 secret is stored sealed while totp_enabled stays
// false) with enrolled_at holding the staging time as a placeholder.
// Confirm overwrites enrolled_at with the confirmation time. A
// staged row is expired when totp_enabled is false and the
// placeholder is older than 15 minutes; confirm deletes it and
// answers the generic code error. When totp_enabled is true the
// row is live, not staged, so no expiry applies.
//
// Persistence port: AuthStore (../../auth/store.ts) has no credential
// or recovery-code write methods, and this overlap batch must not
// edit existing auth files (AD-57). The TotpEnrollmentStore port
// below carries exactly the writes enrollment needs, each
// transactional in the Drizzle implementation. The fake used by
// tests implements the same port over the FakeAuthStore maps. Wiring
// the Drizzle implementation into buildApp is integrator work.

import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { recoveryCodes, sessions, totpCredentials, users } from '../../db/index.js';
import { hashToken } from '../../auth/crypto.js';
import type { TotpCredentialRow } from '../../auth/store.js';
import { unsealTotpSecret } from '../../auth/totp-seal.js';
import { normalizeRecoveryCode, verifyTotpCode } from '../../auth/totp-verify.js';
import type { AuditEventType } from '../../auth/values.js';

export const TOTP_ISSUER = 'NoteGen';
export const TOTP_ENROLL_STAGE_MS = 15 * 60 * 1000;
export const RECOVERY_CODE_COUNT = 10;

// Recovery-code alphabet (desain-auth.md section 1.4): lowercase
// without l and o, digits without 0 and 1. 32 characters, so one
// random byte masked to 5 bits is unbiased.
export const RECOVERY_CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Audit event types for TOTP enrollment (desain-auth.md section
// 12.1). AUDIT_EVENT_TYPES in ../../auth/values.ts does not list them
// yet ("TOTP enrollment, reset, and admin event types belong to
// V3-02"); the union extension there is integrator follow-up for
// this overlap batch, which must not edit existing auth files.
// The casts below are safe at runtime: audit_events.event_type is
// plain text enforced by code, not by a CHECK constraint (see
// db/schema/m1-foundation.ts), so these values persist unchanged.
export const TOTP_ENROLLED_EVENT = 'totp_enrolled' as AuditEventType;
export const TOTP_DISABLED_EVENT = 'totp_disabled' as AuditEventType;
export const RECOVERY_CODES_REGENERATED_EVENT = 'recovery_codes_regenerated' as AuditEventType;

// RFC 4648 Base32 encoding without padding. Round-trips with
// decodeBase32 in ../../auth/totp-verify.ts (covered by the enrollment
// spec: a generated secret verifies through the real login path).
export function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >> bits) & 31];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

// A fresh TOTP secret: 20 CSPRNG bytes, 160 bits of entropy,
// encoded as 32 Base32 characters (desain-auth.md section 1.4).
export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function buildOtpauthUrl(email: string, secretBase32: string): string {
  const label = `${encodeURIComponent(TOTP_ISSUER)}:${encodeURIComponent(email)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(TOTP_ISSUER)}&digits=6&period=30`;
}

// One recovery code: 16 alphabet characters from CSPRNG bytes,
// displayed grouped 4-4-4-4 (desain-auth.md section 1.4).
export function generateRecoveryCode(): string {
  const bytes = randomBytes(16);
  const chars = [...bytes].map((byte) => RECOVERY_CODE_ALPHABET[byte & 31] as string).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => generateRecoveryCode());
}

// Storage form of a recovery code: SHA-256 hex of the normalized
// code (lowercase, separators stripped), matching the lookup in the
// login path. The raw code is never stored.
export function recoveryCodeHash(code: string): string {
  return hashToken(normalizeRecoveryCode(code));
}

export interface RecoveryBatchInput {
  codeHashes: string[];
  batchId: string;
  createdAt: Date;
}

export interface RecoveryCodeBatch extends RecoveryBatchInput {
  codes: string[];
}

// A fresh recovery set: 10 display codes, their hashes, and one
// batch id grouping the set (recovery_codes.batch_id is NOT NULL;
// regeneration deletes the whole old batch).
export function newRecoveryCodeBatch(createdAt: Date): RecoveryCodeBatch {
  const codes = generateRecoveryCodes();
  return {
    codes,
    codeHashes: codes.map((code) => recoveryCodeHash(code)),
    batchId: randomUUID(),
    createdAt,
  };
}

// Pure TOTP code check against a stored credential: unseal, then
// verify with the window and anti-replay rule. Any failure (no
// credential, no key, unseal failure, bad shape, wrong code,
// replayed step) yields the same invalid outcome, so callers can
// answer one generic error. Verification alone never consumes the
// code: the caller must claim the step through
// AuthStore.claimTotpStep, exactly as the login path does.
export type TotpProofResult = { valid: true; step: number } | { valid: false };

export function verifyTotpProof(input: {
  credential: TotpCredentialRow | null;
  sealKey: Buffer | null;
  code: string;
  nowMs: number;
}): TotpProofResult {
  if (input.credential === null || input.sealKey === null) {
    return { valid: false };
  }
  const secret = unsealTotpSecret(input.credential.secretSealed, input.sealKey, input.credential.keyVersion);
  if (secret === null) {
    return { valid: false };
  }
  const result = verifyTotpCode({
    secretBase32: secret,
    code: input.code,
    nowMs: input.nowMs,
    lastUsedStep: input.credential.lastUsedStep,
  });
  return result.valid ? { valid: true, step: result.step } : { valid: false };
}

// True when a credential row is an unconfirmed stage-1 secret older
// than 15 minutes (desain-auth.md section 1.4). The enrolled_at
// column holds the staging time until confirm overwrites it. The
// boundary is inclusive: exactly 15 minutes still counts, matching
// the step-up freshness boundary in ../../auth/service.ts.
export function isStageExpired(credential: TotpCredentialRow, totpEnabled: boolean, nowMs: number): boolean {
  if (totpEnabled) {
    return false;
  }
  return nowMs - credential.enrolledAt.getTime() > TOTP_ENROLL_STAGE_MS;
}

export interface StageCredentialInput {
  userId: string;
  secretSealed: string;
  keyVersion: number;
  stagedAt: Date;
}

export interface ActivateEnrollmentInput {
  userId: string;
  enrolledAt: Date;
  verifiedAt: Date;
  batch: RecoveryBatchInput;
}

export interface TotpEnrollmentStore {
  // Upserts the staged sealed secret (last_used_step and
  // verified_at reset; enrolled_at holds the staging time until
  // confirm). Overwriting an active credential is the re-enrollment
  // path: the caller verifies the old proof first.
  stageCredential(input: StageCredentialInput): Promise<void>;
  // One transaction: set enrolled_at/verified_at on the credential,
  // set users.totp_enabled, and replace the whole recovery set with
  // the new batch. last_used_step is untouched: the caller claimed
  // the confirmation step before calling.
  activateEnrollment(input: ActivateEnrollmentInput): Promise<void>;
  // One transaction: delete the credential, delete all recovery
  // codes, and set users.totp_enabled false (desain-auth.md
  // section 1.4).
  disableTotp(userId: string, at: Date): Promise<void>;
  // One transaction: delete every recovery code of the account
  // (used and unused) and insert the new batch.
  replaceRecoveryCodes(userId: string, batch: RecoveryBatchInput): Promise<void>;
  // Deletes the credential row (expired-stage cleanup). Recovery
  // codes and the totp_enabled flag are untouched.
  deleteCredential(userId: string): Promise<void>;
  // Deletes every session of the account except the kept one.
  // Returns the number deleted. No epoch change: TOTP changes
  // revoke other sessions explicitly without bumping the epoch
  // (desain-auth.md section 3.5).
  deleteOtherSessions(userId: string, keepSessionId: string): Promise<number>;
}

export class DrizzleTotpEnrollmentStore implements TotpEnrollmentStore {
  constructor(private readonly db: Database) {}

  async stageCredential(input: StageCredentialInput): Promise<void> {
    await this.db
      .insert(totpCredentials)
      .values({
        userId: input.userId,
        secretSealed: input.secretSealed,
        keyVersion: input.keyVersion,
        lastUsedStep: null,
        enrolledAt: input.stagedAt,
        verifiedAt: null,
      })
      .onConflictDoUpdate({
        target: totpCredentials.userId,
        set: {
          secretSealed: input.secretSealed,
          keyVersion: input.keyVersion,
          lastUsedStep: null,
          enrolledAt: input.stagedAt,
          verifiedAt: null,
        },
      });
  }

  async activateEnrollment(input: ActivateEnrollmentInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(totpCredentials)
        .set({ enrolledAt: input.enrolledAt, verifiedAt: input.verifiedAt })
        .where(eq(totpCredentials.userId, input.userId));
      await tx
        .update(users)
        .set({ totpEnabled: true, updatedAt: input.enrolledAt })
        .where(eq(users.id, input.userId));
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, input.userId));
      await tx.insert(recoveryCodes).values(
        input.batch.codeHashes.map((codeHash) => ({
          userId: input.userId,
          codeHash,
          batchId: input.batch.batchId,
          createdAt: input.batch.createdAt,
        })),
      );
    });
  }

  async disableTotp(userId: string, at: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(totpCredentials).where(eq(totpCredentials.userId, userId));
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
      await tx.update(users).set({ totpEnabled: false, updatedAt: at }).where(eq(users.id, userId));
    });
  }

  async replaceRecoveryCodes(userId: string, batch: RecoveryBatchInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
      await tx.insert(recoveryCodes).values(
        batch.codeHashes.map((codeHash) => ({
          userId,
          codeHash,
          batchId: batch.batchId,
          createdAt: batch.createdAt,
        })),
      );
    });
  }

  async deleteCredential(userId: string): Promise<void> {
    await this.db.delete(totpCredentials).where(eq(totpCredentials.userId, userId));
  }

  async deleteOtherSessions(userId: string, keepSessionId: string): Promise<number> {
    const rows = await this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
      .returning({ id: sessions.id });
    return rows.length;
  }
}
