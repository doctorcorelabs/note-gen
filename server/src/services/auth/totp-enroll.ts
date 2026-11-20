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
// Pending-stage storage: the staged secret lives in its own table,
// totp_enrollment_stages, never in the live credential row
// (desain-auth.md section 1.4; DA-02-F03). Storing the stage in
// totp_credentials destroyed the active credential on enroll/start
// and broke TOTP login until the new secret was confirmed. The
// stage row holds the sealed secret plus staged_at; enrolled_at on
// the credential row is filled only when confirm promotes the
// stage. A stage older than 15 minutes is expired whether or not
// the account already has TOTP enabled; confirm deletes it and
// answers the generic code error, and the live credential, if any,
// is untouched.
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
import { recoveryCodes, sessions, totpCredentials, totpEnrollmentStages, users } from '../../db/index.js';
import { hashToken } from '../../auth/crypto.js';
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

// Sealed-secret shape shared by a live credential row and an
// enrollment stage row: both carry the same sealed form and key
// version. A stage has no anti-replay history, so callers pass
// lastUsedStep null for a stage; the confirmation step is recorded
// when activation promotes the stage.
export interface TotpProofCredential {
  secretSealed: string;
  keyVersion: number;
  lastUsedStep: number | null;
}

// Pure TOTP code check against a stored credential or stage:
// unseal, then verify with the window and anti-replay rule. Any
// failure (no credential, no key, unseal failure, bad shape, wrong
// code, replayed step) yields the same invalid outcome, so callers
// can answer one generic error. Verification alone never consumes
// the code: callers proving against a live credential must claim
// the step through AuthStore.claimTotpStep, exactly as the login
// path does; callers proving against a stage record the step when
// activation promotes the stage.
export type TotpProofResult = { valid: true; step: number } | { valid: false };

export function verifyTotpProof(input: {
  credential: TotpProofCredential | null;
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

// True when an enrollment stage is older than 15 minutes
// (desain-auth.md section 1.4). The boundary is inclusive: exactly
// 15 minutes still counts, matching the step-up freshness boundary
// in ../../auth/service.ts. Expiry applies to every stage,
// including a re-enrollment stage on a TOTP-enabled account: the
// live credential is stored separately and is never the stage.
export function isStageExpired(stage: TotpEnrollmentStageRow, nowMs: number): boolean {
  return nowMs - stage.stagedAt.getTime() > TOTP_ENROLL_STAGE_MS;
}

export type TotpEnrollmentStageRow = typeof totpEnrollmentStages.$inferSelect;

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
  // The TOTP step the confirmation code proved. Activation records
  // it as last_used_step on the promoted credential, so the same
  // code cannot then pass login as a fresh proof.
  totpStep: number;
  batch: RecoveryBatchInput;
}

export interface TotpEnrollmentStore {
  // Upserts the staged sealed secret into totp_enrollment_stages,
  // replacing any pending stage. The live credential row is never
  // touched: until confirm promotes the stage, login keeps
  // verifying against the old secret.
  stageCredential(input: StageCredentialInput): Promise<void>;
  // Reads the pending stage, or null when the account has none.
  findStage(userId: string): Promise<TotpEnrollmentStageRow | null>;
  // Deletes the pending stage (expired-stage cleanup). The live
  // credential, the recovery codes, and the totp_enabled flag are
  // untouched.
  deleteStage(userId: string): Promise<void>;
  // One transaction: promote the pending stage into the credential
  // row (insert, or replace the old secret for re-enrollment, with
  // enrolled_at/verified_at/last_used_step set), set
  // users.totp_enabled, replace the whole recovery set with the new
  // batch, and delete the stage. Returns false without writing
  // anything when no stage exists (a concurrent confirm already
  // promoted or deleted it); the caller answers the generic code
  // error in that case.
  activateEnrollment(input: ActivateEnrollmentInput): Promise<boolean>;
  // One transaction: delete the credential, the pending stage if
  // any, and all recovery codes, and set users.totp_enabled false
  // (desain-auth.md section 1.4).
  disableTotp(userId: string, at: Date): Promise<void>;
  // One transaction: delete every recovery code of the account
  // (used and unused) and insert the new batch.
  replaceRecoveryCodes(userId: string, batch: RecoveryBatchInput): Promise<void>;
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
      .insert(totpEnrollmentStages)
      .values({
        userId: input.userId,
        secretSealed: input.secretSealed,
        keyVersion: input.keyVersion,
        stagedAt: input.stagedAt,
      })
      .onConflictDoUpdate({
        target: totpEnrollmentStages.userId,
        set: {
          secretSealed: input.secretSealed,
          keyVersion: input.keyVersion,
          stagedAt: input.stagedAt,
        },
      });
  }

  async findStage(userId: string): Promise<TotpEnrollmentStageRow | null> {
    const rows = await this.db
      .select()
      .from(totpEnrollmentStages)
      .where(eq(totpEnrollmentStages.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  async deleteStage(userId: string): Promise<void> {
    await this.db.delete(totpEnrollmentStages).where(eq(totpEnrollmentStages.userId, userId));
  }

  async activateEnrollment(input: ActivateEnrollmentInput): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // Lock the stage row: a concurrent confirm for the same
      // account waits here, then re-reads after this transaction
      // commits and finds the stage gone, so exactly one confirm
      // can promote a stage.
      const stages = await tx
        .select()
        .from(totpEnrollmentStages)
        .where(eq(totpEnrollmentStages.userId, input.userId))
        .for('update');
      const stage = stages[0];
      if (stage === undefined) {
        return false;
      }
      await tx
        .insert(totpCredentials)
        .values({
          userId: input.userId,
          secretSealed: stage.secretSealed,
          keyVersion: stage.keyVersion,
          lastUsedStep: input.totpStep,
          enrolledAt: input.enrolledAt,
          verifiedAt: input.verifiedAt,
        })
        .onConflictDoUpdate({
          target: totpCredentials.userId,
          set: {
            secretSealed: stage.secretSealed,
            keyVersion: stage.keyVersion,
            lastUsedStep: input.totpStep,
            enrolledAt: input.enrolledAt,
            verifiedAt: input.verifiedAt,
          },
        });
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
      await tx.delete(totpEnrollmentStages).where(eq(totpEnrollmentStages.userId, input.userId));
      return true;
    });
  }

  async disableTotp(userId: string, at: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(totpEnrollmentStages).where(eq(totpEnrollmentStages.userId, userId));
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

  async deleteOtherSessions(userId: string, keepSessionId: string): Promise<number> {
    const rows = await this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
      .returning({ id: sessions.id });
    return rows.length;
  }
}
