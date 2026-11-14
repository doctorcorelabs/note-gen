// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// In-memory SettingsStore test double. Never imported by production
// code. Transactions snapshot the whole per-user state and restore it
// on throw, mirroring the atomicity of the Drizzle implementation.
// Secret rows record the write time supplied by the service (the
// production store derives it from the audit trail instead; both
// report updatedAtMs through listSecrets). Values are deep-cloned on
// read and write so tests cannot alias stored state by accident.

import type {
  IdempotencyRecord,
  PutSecretInput,
  SecretRow,
  SettingsStore,
  SettingsTx,
} from '../../src/services/settings/store.js';

export interface MemoryAuditEvent {
  userId: string;
  action: string;
  targetType: string;
  targetId: string;
  ipHash: string;
  nowMs: number;
}

interface UserState {
  revision: number;
  settings: Map<string, unknown>;
  secrets: Map<string, SecretRow>;
  idempotency: Map<string, IdempotencyRecord>;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneRow(row: SecretRow): SecretRow {
  return {
    ...row,
    ciphertext: Buffer.from(row.ciphertext),
    nonce: Buffer.from(row.nonce),
  };
}

function cloneState(state: UserState): UserState {
  return {
    idempotency: new Map(
      [...state.idempotency.entries()].map(([key, record]) => [key, cloneJson(record)]),
    ),
    revision: state.revision,
    secrets: new Map([...state.secrets.entries()].map(([key, row]) => [key, cloneRow(row)])),
    settings: new Map([...state.settings.entries()].map(([key, value]) => [key, cloneJson(value)])),
  };
}

function secretKey(kind: string, ref: string): string {
  return `${kind}\n${ref}`;
}

class MemorySettingsTx implements SettingsTx {
  readonly #state: UserState;
  readonly #audit: MemoryAuditEvent[];
  readonly #userId: string;

  constructor(state: UserState, audit: MemoryAuditEvent[], userId: string) {
    this.#state = state;
    this.#audit = audit;
    this.#userId = userId;
  }

  async acquireUserLock(): Promise<void> {
    // Single-threaded test double: transactions never interleave.
  }

  async getRevision(): Promise<number> {
    return this.#state.revision;
  }

  async setRevision(revision: number): Promise<void> {
    this.#state.revision = revision;
  }

  async getSettings(keys?: readonly string[]): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    const wanted = keys === undefined ? null : new Set(keys);
    for (const [key, value] of this.#state.settings) {
      if (wanted !== null && !wanted.has(key)) {
        continue;
      }
      result[key] = cloneJson(value);
    }
    return result;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    this.#state.settings.set(key, cloneJson(value));
  }

  async deleteSetting(key: string): Promise<boolean> {
    return this.#state.settings.delete(key);
  }

  async listSecrets(kind: string): Promise<SecretRow[]> {
    const rows: SecretRow[] = [];
    for (const row of this.#state.secrets.values()) {
      if (row.kind === kind) {
        rows.push(cloneRow(row));
      }
    }
    return rows;
  }

  async getSecret(kind: string, ref: string): Promise<SecretRow | null> {
    const row = this.#state.secrets.get(secretKey(kind, ref));
    return row === undefined ? null : cloneRow(row);
  }

  async putSecret(input: PutSecretInput): Promise<void> {
    const previous = this.#state.secrets.get(secretKey(input.kind, input.ref));
    this.#state.secrets.set(secretKey(input.kind, input.ref), {
      ciphertext: Buffer.from(input.ciphertext),
      keyVersion: input.keyVersion,
      kind: input.kind,
      lastUsedAtMs: previous === undefined ? null : previous.lastUsedAtMs,
      nonce: Buffer.from(input.nonce),
      ref: input.ref,
      updatedAtMs: input.updatedAtMs,
    });
  }

  async deleteSecret(kind: string, ref: string): Promise<boolean> {
    return this.#state.secrets.delete(secretKey(kind, ref));
  }

  async getIdempotency(scope: string, key: string, nowMs: number): Promise<IdempotencyRecord | null> {
    const record = this.#state.idempotency.get(`${scope}\n${key}`);
    if (record === undefined) {
      return null;
    }
    if (record.expiresAtMs <= nowMs) {
      this.#state.idempotency.delete(`${scope}\n${key}`);
      return null;
    }
    return cloneJson(record);
  }

  async putIdempotency(scope: string, key: string, record: IdempotencyRecord): Promise<void> {
    this.#state.idempotency.set(`${scope}\n${key}`, cloneJson(record));
  }

  async recordAudit(
    action: string,
    targetType: string,
    targetId: string,
    ipHash: string,
    nowMs: number,
  ): Promise<void> {
    this.#audit.push({ action, ipHash, nowMs, targetId, targetType, userId: this.#userId });
  }
}

export class MemorySettingsStore implements SettingsStore {
  readonly #users = new Map<string, UserState>();
  readonly #audit: MemoryAuditEvent[] = [];

  get auditEvents(): MemoryAuditEvent[] {
    return [...this.#audit];
  }

  async transact<T>(userId: string, fn: (tx: SettingsTx) => Promise<T>): Promise<T> {
    const existing = this.#users.get(userId);
    const snapshot = existing === undefined ? null : cloneState(existing);
    const auditLength = this.#audit.length;
    const state: UserState =
      existing ?? { idempotency: new Map(), revision: 0, secrets: new Map(), settings: new Map() };
    if (existing === undefined) {
      this.#users.set(userId, state);
    }
    try {
      return await fn(new MemorySettingsTx(state, this.#audit, userId));
    } catch (error) {
      if (snapshot === null) {
        this.#users.delete(userId);
      } else {
        this.#users.set(userId, snapshot);
      }
      this.#audit.length = auditLength;
      throw error;
    }
  }
}
