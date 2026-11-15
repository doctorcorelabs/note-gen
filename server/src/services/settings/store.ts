// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Storage interface for the settings and secrets services (V3-10a).
//
// All operations run inside transact(), which gives the service one
// atomic unit per request: settings writes, the revision bump, the
// orphan-secret sweep, the idempotency record, and the audit rows
// commit together or not at all. A throw inside the callback rolls
// the unit back (Drizzle transaction rollback; snapshot restore in
// the in-memory test store). Every method is scoped to the userId
// passed to transact; no method can read or write another user's
// rows, and no method accepts a userId of its own.
//
// Implementations:
// - DrizzleSettingsStore (drizzle-store.ts): Postgres via Drizzle,
//   the production implementation over the M1 tables settings,
//   setting_revisions, secrets, idempotency_keys, audit_events.
// - In-memory store (server/test/support/memory-settings-store.ts):
//   test double only, never imported by production code.
//
// The interface never carries plaintext secrets: putSecret takes
// sealed bytes only, and listSecrets/getSecret return sealed rows.
// Decryption happens in the service, through the SecretCipher seam,
// and only to merge a bundle on PUT.

import type { SealedSecret } from './crypto-seam.js';

// One secrets row, as the service sees it. updatedAtMs is the last
// write time when it can be derived (audit trail; the M1 secrets
// table has no updated_at column, see drizzle-store.ts), else null.
// lastUsedAtMs comes from secrets.last_used_at and stays null until
// the Fase 2 AI proxy records usage; it is never set by this wave.
export interface SecretRow extends SealedSecret {
  kind: string;
  ref: string;
  updatedAtMs: number | null;
  lastUsedAtMs: number | null;
}

export interface PutSecretInput extends SealedSecret {
  kind: string;
  ref: string;
  // Write time supplied by the service clock. The Drizzle
  // implementation ignores it (no column); the in-memory test store
  // records it. Both report updatedAtMs through listSecrets.
  updatedAtMs: number;
}

export interface IdempotencyRecord {
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
  expiresAtMs: number;
}

export interface SettingsTx {
  // Serialize mutations for one user: inserts the revision row when
  // missing and locks it for the transaction. PATCH and PUT acquire
  // this before the idempotency lookup so a retried request replays
  // the stored response instead of racing the first attempt.
  acquireUserLock(): Promise<void>;

  getRevision(): Promise<number>;
  setRevision(revision: number): Promise<void>;

  // Settings rows. Keys absent from the store are absent from the
  // result (never null). Values are fresh objects the caller may
  // mutate without affecting stored state.
  getSettings(keys?: readonly string[]): Promise<Record<string, unknown>>;
  setSetting(key: string, value: unknown): Promise<void>;
  // True when a row existed and was removed.
  deleteSetting(key: string): Promise<boolean>;

  listSecrets(kind: string): Promise<SecretRow[]>;
  getSecret(kind: string, ref: string): Promise<SecretRow | null>;
  putSecret(input: PutSecretInput): Promise<void>;
  // True when a row existed and was removed.
  deleteSecret(kind: string, ref: string): Promise<boolean>;

  // Idempotency record for one scope + key, or null when absent or
  // expired. Expired records are treated as absent.
  getIdempotency(scope: string, key: string, nowMs: number): Promise<IdempotencyRecord | null>;
  putIdempotency(scope: string, key: string, record: IdempotencyRecord): Promise<void>;

  // Audit trail, metadata only: action, target type, target id, and
  // a hash of the request IP. Never a secret value, never a settings
  // value. nowMs is the service clock time of the action.
  recordAudit(
    action: string,
    targetType: string,
    targetId: string,
    ipHash: string,
    nowMs: number,
  ): Promise<void>;
}

export interface SettingsStore {
  transact<T>(userId: string, fn: (tx: SettingsTx) => Promise<T>): Promise<T>;
}
