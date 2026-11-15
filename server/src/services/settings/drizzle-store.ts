// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Drizzle/Postgres implementation of SettingsStore (V3-10a), over the
// M1 tables from server/src/db/schema/m1-foundation.ts: settings,
// setting_revisions, secrets, idempotency_keys, audit_events. No
// migration is written or needed here; the tables landed with the
// frozen 0000 migration (AD-25).
//
// Notes for reviewers:
// - Every query filters user_id from the session principal. There is
//   no cross-user access path in this file.
// - The revision row is created lazily: a user with no row reads
//   revision 0, and the first mutating transaction inserts the row
//   and locks it (SELECT ... FOR UPDATE) so concurrent PATCH/PUT
//   requests for one user serialize and idempotent replays see the
//   stored response instead of racing.
// - The M1 secrets table has no updated_at column, so listSecrets
//   derives updatedAtMs from the latest matching audit_events row
//   (action secret_created/secret_updated/secret_rotated for that
//   ref), else null. Adding an updated_at column is a forward
//   migration owned by a later wave; this derivation keeps the
//   contract shape honest without one. last_used_at is read as
//   stored and stays null until the Fase 2 AI proxy records usage.
// - putSecret stores sealed bytes only. There is no plaintext column
//   and no code path in this file that could write one.
// - When no DATABASE_URL is configured, transact fails closed with
//   503 service_unavailable instead of throwing a driver error at
//   startup or import time. Importing this module never connects.

import { and, desc, eq, inArray } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import {
  auditEvents,
  getDb,
  idempotencyKeys,
  secrets,
  settingRevisions,
  settings,
  type Database,
} from '../../db/index.js';
import type {
  IdempotencyRecord,
  PutSecretInput,
  SecretRow,
  SettingsStore,
  SettingsTx,
} from './store.js';

// The transaction object type, derived from Database so a driver
// upgrade cannot silently desynchronize the annotation.
type DrizzleTx = Parameters<Parameters<Database['transaction']>[0]>[0];

class DrizzleSettingsTx implements SettingsTx {
  readonly #tx: DrizzleTx;
  readonly #userId: string;

  constructor(tx: DrizzleTx, userId: string) {
    this.#tx = tx;
    this.#userId = userId;
  }

  async acquireUserLock(): Promise<void> {
    await this.#tx
      .insert(settingRevisions)
      .values({ revision: 0, userId: this.#userId })
      .onConflictDoNothing();
    await this.#tx
      .select()
      .from(settingRevisions)
      .where(eq(settingRevisions.userId, this.#userId))
      .for('update');
  }

  async getRevision(): Promise<number> {
    const rows = await this.#tx
      .select()
      .from(settingRevisions)
      .where(eq(settingRevisions.userId, this.#userId))
      .limit(1);
    return rows.length === 0 ? 0 : rows[0].revision;
  }

  async setRevision(revision: number): Promise<void> {
    await this.#tx
      .insert(settingRevisions)
      .values({ revision, userId: this.#userId })
      .onConflictDoUpdate({ set: { revision }, target: [settingRevisions.userId] });
  }

  async getSettings(keys?: readonly string[]): Promise<Record<string, unknown>> {
    if (keys !== undefined && keys.length === 0) {
      return {};
    }
    const rows = await this.#tx
      .select()
      .from(settings)
      .where(
        keys === undefined
          ? eq(settings.userId, this.#userId)
          : and(eq(settings.userId, this.#userId), inArray(settings.key, [...keys])),
      );
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.#tx
      .insert(settings)
      .values({ key, updatedAt: new Date(), userId: this.#userId, value })
      .onConflictDoUpdate({
        set: { updatedAt: new Date(), value },
        target: [settings.userId, settings.key],
      });
  }

  async deleteSetting(key: string): Promise<boolean> {
    const removed = await this.#tx
      .delete(settings)
      .where(and(eq(settings.userId, this.#userId), eq(settings.key, key)))
      .returning({ key: settings.key });
    return removed.length > 0;
  }

  async listSecrets(kind: string): Promise<SecretRow[]> {
    const rows = await this.#tx
      .select()
      .from(secrets)
      .where(and(eq(secrets.userId, this.#userId), eq(secrets.kind, kind)));
    if (rows.length === 0) {
      return [];
    }
    const refs = rows.map((row) => row.ref);
    // Canonical audit_events has no target columns: the target lives
    // in metadata (see recordAudit below). Filter by actor, newest
    // first, and match the metadata target in JS.
    const audits = await this.#tx
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorUserId, this.#userId))
      .orderBy(desc(auditEvents.createdAt));
    const latestByRef = new Map<string, number>();
    for (const audit of audits) {
      const metadata = audit.metadata;
      const targetType =
        typeof metadata === 'object' && metadata !== null ? metadata['targetType'] : undefined;
      const targetId =
        typeof metadata === 'object' && metadata !== null ? metadata['targetId'] : undefined;
      if (
        targetType === 'secret' &&
        typeof targetId === 'string' &&
        refs.includes(targetId) &&
        !latestByRef.has(targetId)
      ) {
        latestByRef.set(targetId, audit.createdAt.getTime());
      }
    }
    return rows.map((row) => ({
      ciphertext: row.ciphertext,
      keyVersion: row.keyVersion,
      kind: row.kind,
      lastUsedAtMs: row.lastUsedAt === null ? null : row.lastUsedAt.getTime(),
      nonce: row.nonce,
      ref: row.ref,
      updatedAtMs: latestByRef.get(row.ref) ?? null,
    }));
  }

  async getSecret(kind: string, ref: string): Promise<SecretRow | null> {
    const rows = await this.#tx
      .select()
      .from(secrets)
      .where(and(eq(secrets.userId, this.#userId), eq(secrets.kind, kind), eq(secrets.ref, ref)))
      .limit(1);
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0];
    return {
      ciphertext: row.ciphertext,
      keyVersion: row.keyVersion,
      kind: row.kind,
      lastUsedAtMs: row.lastUsedAt === null ? null : row.lastUsedAt.getTime(),
      nonce: row.nonce,
      ref: row.ref,
      updatedAtMs: null,
    };
  }

  async putSecret(input: PutSecretInput): Promise<void> {
    await this.#tx
      .insert(secrets)
      .values({
        ciphertext: input.ciphertext,
        keyVersion: input.keyVersion,
        kind: input.kind,
        nonce: input.nonce,
        ref: input.ref,
        userId: this.#userId,
      })
      .onConflictDoUpdate({
        set: { ciphertext: input.ciphertext, keyVersion: input.keyVersion, nonce: input.nonce },
        target: [secrets.userId, secrets.kind, secrets.ref],
      });
  }

  async deleteSecret(kind: string, ref: string): Promise<boolean> {
    const removed = await this.#tx
      .delete(secrets)
      .where(and(eq(secrets.userId, this.#userId), eq(secrets.kind, kind), eq(secrets.ref, ref)))
      .returning({ id: secrets.id });
    return removed.length > 0;
  }

  async getIdempotency(scope: string, key: string, nowMs: number): Promise<IdempotencyRecord | null> {
    const rows = await this.#tx
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, this.#userId),
          eq(idempotencyKeys.scope, scope),
          eq(idempotencyKeys.key, key),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0];
    if (row.expiresAt.getTime() <= nowMs) {
      await this.#tx
        .delete(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.userId, this.#userId),
            eq(idempotencyKeys.scope, scope),
            eq(idempotencyKeys.key, key),
          ),
        );
      return null;
    }
    return {
      expiresAtMs: row.expiresAt.getTime(),
      requestHash: row.requestHash,
      responseBody: row.responseBody,
      responseStatus: row.responseStatus,
    };
  }

  async putIdempotency(scope: string, key: string, record: IdempotencyRecord): Promise<void> {
    await this.#tx
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, this.#userId),
          eq(idempotencyKeys.scope, scope),
          eq(idempotencyKeys.key, key),
        ),
      );
    await this.#tx.insert(idempotencyKeys).values({
      expiresAt: new Date(record.expiresAtMs),
      key,
      requestHash: record.requestHash,
      responseBody: record.responseBody,
      responseStatus: record.responseStatus,
      scope,
      userId: this.#userId,
    });
  }

  async recordAudit(
    action: string,
    targetType: string,
    targetId: string,
    ipHash: string,
    _nowMs: number,
  ): Promise<void> {
    // Canonical audit_events columns (M8): the action is eventType,
    // the actor is actorUserId, and the target + hashed IP live in
    // metadata (the ip column is inet and must never hold a hash).
    await this.#tx.insert(auditEvents).values({
      userId: this.#userId,
      actorUserId: this.#userId,
      eventType: action,
      ip: null,
      userAgent: null,
      metadata: { targetType, targetId, ipHash },
    });
  }
}

export type DatabaseResolver = () => Database | null;

export class DrizzleSettingsStore implements SettingsStore {
  readonly #resolveDb: DatabaseResolver;

  constructor(resolveDb: DatabaseResolver) {
    this.#resolveDb = resolveDb;
  }

  async transact<T>(userId: string, fn: (tx: SettingsTx) => Promise<T>): Promise<T> {
    const db = this.#resolveDb();
    if (db === null) {
      throw ApiError.serviceUnavailable('The database is not configured.');
    }
    return db.transaction(async (tx) => fn(new DrizzleSettingsTx(tx, userId)));
  }
}

export function createDrizzleSettingsStore(resolveDb: DatabaseResolver): DrizzleSettingsStore {
  return new DrizzleSettingsStore(resolveDb);
}

// Production store: resolves the process-wide Drizzle handle lazily,
// per transaction, so the server can boot (and answer health) without
// a database and fail closed with 503 on settings routes until one is
// configured. getDb() throws only when DATABASE_URL is missing; the
// throw is caught here and converted to "no database", never logged
// with a value (the accessor message names the variable only).
export function createProductionSettingsStore(): DrizzleSettingsStore {
  return new DrizzleSettingsStore(() => {
    try {
      return getDb();
    } catch {
      return null;
    }
  });
}
