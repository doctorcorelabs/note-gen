// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Settings and secrets service (V3-10a). Implements kontrak-api-kanonis.md
// sections 3.2 (settings) and 3.3 (secrets) over the SettingsStore
// interface, with classification from classification.ts and secret
// sealing through the SecretCipher seam (crypto-seam.ts, V3-10b).
//
// Rules implemented here, with their sources:
// - GET /api/settings returns { revision, settings }; keys that do not
//   exist are absent, never null; L/R/unknown keys requested by name
//   are silently omitted (tolerant read, desain-store-adapter.md
//   section 4.2 rule 1). Stored rows whose key no longer classifies
//   as S or SPLIT are also omitted, defense in depth.
// - PATCH /api/settings requires baseRevision; a stale guard answers
//   409 revision_conflict with details { revision, settings } holding
//   the current server state (kontrak K-03, retryable false). Keys
//   are classified one by one: S keys apply, L keys are rejected
//   local_only, R keys secret_only, unknown keys unknown_key, bad
//   values invalid_value. Rejected keys never fail the whole request
//   (kontrak 3.2); applied keys commit atomically with the revision
//   bump. A PATCH that applies nothing does not raise the revision.
//   A null value deletes a key; deleting an absent key still counts
//   as applied (idempotent).
// - aiModelList is split (desain-store-adapter.md section 2.7):
//   metadata stores in settings, credential fields never do. A PATCH
//   entry carrying a credential field is rejected secret_only, whole
//   key, so a client can never believe a secret was stored through
//   settings. Deleting aiModelList deletes every ai_provider secret
//   in the same transaction; replacing it sweeps secrets whose
//   provider key no longer has a metadata entry (orphan sweep).
//   Reads re-add hasApiKey (secret row existence) and updatedAt per
//   entry, computed from the secrets table, never stored in metadata.
// - GET /api/settings/revision returns { revision } only.
// - GET /api/settings/secrets/status returns metadata only: kind,
//   ref, label, updatedAt, lastUsedAt. No value, no fragment of a
//   value, ever (AD-16).
// - PUT /api/settings/secrets/ai-providers requires a metadata entry
//   for each providerKey (400 otherwise, kontrak P-03), merges the
//   patch into the sealed bundle (absent leaves, value replaces,
//   null deletes the field), seals through the cipher seam, and
//   answers { updated: [{ providerKey, hasApiKey, updatedAt }] }
//   with no echo of any value. An empty merged bundle deletes the
//   row instead of storing an empty ciphertext. A rewrite under a
//   different keyVersion is recorded as secret_rotated in the audit
//   trail; the row itself records key_version.
// - DELETE .../ai-providers/:providerKey answers 404 when the
//   providerKey has no metadata entry (kontrak K-16), and succeeds
//   without change when metadata exists but no secret row does.
// - Idempotency (kontrak 1.6 and 4): PATCH and PUT honor the
//   Idempotency-Key header. Same key + same canonical request replays
//   the stored response without re-executing; same key + different
//   request answers 409 idempotency_key_reused. Records live 24
//   hours. Only a SHA-256 hash of the request is stored, never the
//   body, so a record can never leak a secret value.
// - Audit: secret create/update/rotate/delete actions are recorded
//   with metadata only (action, target type, target id, IP hash).
//   Session-id rotation on secret writes is owned by the auth layer
//   (desain-store-adapter.md section 4.3 rule 6); this service does
//   not rotate sessions and the routes do not claim to.
//
// No function in this file logs. Values are never interpolated into
// an error message. The routes pass an IP hash, never a raw IP, into
// the audit calls.

import { ApiError } from '../../plugins/envelope.js';
import { classifyKey } from './classification.js';
import {
  bundleHasApiKey,
  decodeSecretBundle,
  encodeSecretBundle,
  isEmptySecretBundle,
  mergeSecretBundle,
  providerEntryHasSecretFields,
  SECRET_KIND_AI_PROVIDER,
  toProviderMetadata,
  type SecretCipher,
} from './crypto-seam.js';
import type { SecretRow, SettingsStore, SettingsTx } from './store.js';
import {
  idempotencyRequestHash,
  isJsonValue,
  isPlainObject,
  validationError,
  type FieldIssue,
  type PatchSettingsBody,
  type PutAiProviderEntry,
} from './validation.js';

export const SETTINGS_PATCH_IDEMPOTENCY_SCOPE = 'settings.patch';
export const SECRETS_PUT_IDEMPOTENCY_SCOPE = 'secrets.ai-providers.put';
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const SETTINGS_PATH = '/api/settings';
const SECRETS_PUT_PATH = '/api/settings/secrets/ai-providers';
const MAX_AI_MODEL_LIST_ENTRIES = 100;

export interface SettingsServiceDeps {
  store: SettingsStore;
  cipher: SecretCipher;
  now?: () => number;
}

export type RejectionReason = 'unknown_key' | 'local_only' | 'secret_only' | 'invalid_value';

export interface RejectedKey {
  key: string;
  reason: RejectionReason;
}

export interface PatchSettingsData {
  revision: number;
  applied: string[];
  rejected: RejectedKey[];
}

export interface SecretsStatusEntry {
  kind: string;
  ref: string;
  label: string;
  updatedAt: number | null;
  lastUsedAt: number | null;
}

export interface PutAiProvidersData {
  updated: Array<{ providerKey: string; hasApiKey: boolean; updatedAt: number }>;
}

export interface DeleteAiProviderData {
  providerKey: string;
  deleted: boolean;
  hasApiKey: false;
}

function clock(deps: SettingsServiceDeps): number {
  return deps.now === undefined ? Date.now() : deps.now();
}

function idempotencyReusedError(): ApiError {
  return new ApiError(409, 'idempotency_key_reused', 'The idempotency key was already used with a different request.');
}

// Replay a stored idempotent response, or null when there is no
// usable record. Throws 409 when the key was used with a different
// request body.
async function replayIfPresent<T>(
  tx: SettingsTx,
  scope: string,
  key: string | null,
  requestHash: string,
  nowMs: number,
): Promise<T | null> {
  if (key === null) {
    return null;
  }
  const record = await tx.getIdempotency(scope, key, nowMs);
  if (record === null) {
    return null;
  }
  if (record.requestHash !== requestHash) {
    throw idempotencyReusedError();
  }
  return record.responseBody as T;
}

async function storeIdempotentResponse(
  tx: SettingsTx,
  scope: string,
  key: string | null,
  requestHash: string,
  data: unknown,
  nowMs: number,
): Promise<void> {
  if (key === null) {
    return;
  }
  await tx.putIdempotency(scope, key, {
    expiresAtMs: nowMs + IDEMPOTENCY_TTL_MS,
    requestHash,
    responseBody: data,
    responseStatus: 200,
  });
}

// Provider metadata entries read from the stored aiModelList value.
// Only entries that are plain objects with a non-empty string key
// count as metadata; anything else is ignored here (writes validate
// strictly, so a malformed stored value can only be legacy data).
export function metadataEntriesOf(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    if (isPlainObject(entry) && typeof entry.key === 'string' && entry.key !== '') {
      entries.push(entry);
    }
  }
  return entries;
}

function metadataKeysOf(settings: Record<string, unknown>): Set<string> {
  return new Set(metadataEntriesOf(settings.aiModelList).map((entry) => entry.key as string));
}

// Validate an aiModelList PATCH value. Returns normalized metadata
// entries (computed fields stripped) or a rejection reason. Secret
// fields are checked before shape, so a smuggled credential is always
// reported as secret_only, never masked by a shape error.
function validateAiModelListValue(
  value: unknown,
): { entries: Array<Record<string, unknown>> } | { reason: RejectionReason } {
  if (!Array.isArray(value)) {
    return { reason: 'invalid_value' };
  }
  if (value.length > MAX_AI_MODEL_LIST_ENTRIES) {
    return { reason: 'invalid_value' };
  }
  const seen = new Set<string>();
  const entries: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    if (providerEntryHasSecretFields(entry)) {
      return { reason: 'secret_only' };
    }
    if (!isPlainObject(entry)) {
      return { reason: 'invalid_value' };
    }
    if (typeof entry.key !== 'string' || entry.key === '') {
      return { reason: 'invalid_value' };
    }
    if (seen.has(entry.key)) {
      return { reason: 'invalid_value' };
    }
    if (!isJsonValue(entry)) {
      return { reason: 'invalid_value' };
    }
    seen.add(entry.key);
    entries.push(toProviderMetadata(entry));
  }
  return { entries };
}

// Add hasApiKey/updatedAt to stored provider metadata, computed from
// the secrets rows. Credential fields are stripped first, defense in
// depth, even though writes already reject them.
function enrichAiModelList(
  value: unknown,
  secretRows: readonly SecretRow[],
): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const byRef = new Map(secretRows.map((row) => [row.ref, row]));
  return value.map((entry) => {
    if (!isPlainObject(entry)) {
      return entry;
    }
    const metadata = toProviderMetadata(entry);
    if (typeof metadata.key === 'string') {
      const row = byRef.get(metadata.key);
      metadata.hasApiKey = row !== undefined;
      metadata.updatedAt = row === undefined ? null : row.updatedAtMs;
    }
    return metadata;
  });
}

async function readEnrichedSettings(
  tx: SettingsTx,
  keys: readonly string[] | null,
): Promise<{ revision: number; settings: Record<string, unknown> }> {
  const revision = await tx.getRevision();
  const stored = await tx.getSettings(keys === null ? undefined : keys);
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    const keyClass = classifyKey(key);
    if (keyClass !== 'S' && keyClass !== 'SPLIT') {
      continue;
    }
    settings[key] = value;
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'aiModelList')) {
    const rows = await tx.listSecrets(SECRET_KIND_AI_PROVIDER);
    settings.aiModelList = enrichAiModelList(settings.aiModelList, rows);
  }
  return { revision, settings };
}

export async function getSettings(
  deps: SettingsServiceDeps,
  userId: string,
  keys: readonly string[] | null,
): Promise<{ revision: number; settings: Record<string, unknown> }> {
  return deps.store.transact(userId, async (tx) => readEnrichedSettings(tx, keys));
}

export async function getSettingsRevision(
  deps: SettingsServiceDeps,
  userId: string,
): Promise<{ revision: number }> {
  const revision = await deps.store.transact(userId, async (tx) => tx.getRevision());
  return { revision };
}

export async function patchSettings(
  deps: SettingsServiceDeps,
  userId: string,
  body: PatchSettingsBody,
  idempotencyKey: string | null,
  ipHash: string,
): Promise<PatchSettingsData> {
  const nowMs = clock(deps);
  const requestHash = idempotencyRequestHash('PATCH', SETTINGS_PATH, {
    baseRevision: body.baseRevision,
    settings: body.settings,
  });
  return deps.store.transact(userId, async (tx) => {
    await tx.acquireUserLock();
    const replayed = await replayIfPresent<PatchSettingsData>(
      tx,
      SETTINGS_PATCH_IDEMPOTENCY_SCOPE,
      idempotencyKey,
      requestHash,
      nowMs,
    );
    if (replayed !== null) {
      return replayed;
    }
    const currentRevision = await tx.getRevision();
    if (body.baseRevision !== currentRevision) {
      const current = await readEnrichedSettings(tx, null);
      throw ApiError.revisionConflict({ revision: current.revision, settings: current.settings });
    }
    const applied: string[] = [];
    const rejected: RejectedKey[] = [];
    const sets: Array<[string, unknown]> = [];
    const deletes: string[] = [];
    let aiModelListTouched = false;
    let aiModelListDeleted = false;
    let newProviderKeys: Set<string> | null = null;
    for (const [key, value] of Object.entries(body.settings)) {
      const keyClass = classifyKey(key);
      if (keyClass === 'L') {
        rejected.push({ key, reason: 'local_only' });
        continue;
      }
      if (keyClass === 'R_REJECT' || keyClass === 'REJECTED') {
        rejected.push({ key, reason: 'secret_only' });
        continue;
      }
      if (keyClass === 'UNCLASSIFIED' || keyClass === 'UNKNOWN') {
        rejected.push({ key, reason: 'unknown_key' });
        continue;
      }
      if (keyClass === 'SPLIT') {
        aiModelListTouched = true;
        if (value === null) {
          aiModelListDeleted = true;
          deletes.push(key);
          applied.push(key);
          continue;
        }
        const validated = validateAiModelListValue(value);
        if ('reason' in validated) {
          rejected.push({ key, reason: validated.reason });
          aiModelListTouched = false;
          continue;
        }
        newProviderKeys = new Set(validated.entries.map((entry) => entry.key as string));
        sets.push([key, validated.entries]);
        applied.push(key);
        continue;
      }
      // Class S.
      if (value === null) {
        deletes.push(key);
        applied.push(key);
        continue;
      }
      if (!isJsonValue(value)) {
        rejected.push({ key, reason: 'invalid_value' });
        continue;
      }
      sets.push([key, value]);
      applied.push(key);
    }
    for (const [key, value] of sets) {
      await tx.setSetting(key, value);
    }
    for (const key of deletes) {
      await tx.deleteSetting(key);
    }
    if (aiModelListTouched) {
      const rows = await tx.listSecrets(SECRET_KIND_AI_PROVIDER);
      for (const row of rows) {
        if (aiModelListDeleted || (newProviderKeys !== null && !newProviderKeys.has(row.ref))) {
          await tx.deleteSecret(SECRET_KIND_AI_PROVIDER, row.ref);
          await tx.recordAudit('secret_deleted', 'secret', row.ref, ipHash, nowMs);
        }
      }
    }
    const revision = applied.length > 0 ? currentRevision + 1 : currentRevision;
    if (applied.length > 0) {
      await tx.setRevision(revision);
    }
    const data: PatchSettingsData = { applied, rejected, revision };
    await storeIdempotentResponse(tx, SETTINGS_PATCH_IDEMPOTENCY_SCOPE, idempotencyKey, requestHash, data, nowMs);
    return data;
  });
}

export async function getSecretsStatus(
  deps: SettingsServiceDeps,
  userId: string,
): Promise<SecretsStatusEntry[]> {
  return deps.store.transact(userId, async (tx) => {
    const stored = await tx.getSettings(['aiModelList']);
    const titles = new Map<string, string>();
    for (const entry of metadataEntriesOf(stored.aiModelList)) {
      if (typeof entry.title === 'string' && entry.title !== '') {
        titles.set(entry.key as string, entry.title);
      }
    }
    const rows = await tx.listSecrets(SECRET_KIND_AI_PROVIDER);
    rows.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    return rows.map((row) => ({
      kind: row.kind,
      label: titles.get(row.ref) ?? row.ref,
      lastUsedAt: row.lastUsedAtMs,
      ref: row.ref,
      updatedAt: row.updatedAtMs,
    }));
  });
}

export async function putAiProviders(
  deps: SettingsServiceDeps,
  userId: string,
  entries: readonly PutAiProviderEntry[],
  rawBody: unknown,
  idempotencyKey: string | null,
  ipHash: string,
): Promise<PutAiProvidersData> {
  const nowMs = clock(deps);
  const requestHash = idempotencyRequestHash('PUT', SECRETS_PUT_PATH, rawBody);
  return deps.store.transact(userId, async (tx) => {
    await tx.acquireUserLock();
    const replayed = await replayIfPresent<PutAiProvidersData>(
      tx,
      SECRETS_PUT_IDEMPOTENCY_SCOPE,
      idempotencyKey,
      requestHash,
      nowMs,
    );
    if (replayed !== null) {
      return replayed;
    }
    const stored = await tx.getSettings(['aiModelList']);
    const metadataKeys = metadataKeysOf(stored);
    const issues: FieldIssue[] = [];
    entries.forEach((entry, index) => {
      if (!metadataKeys.has(entry.providerKey)) {
        issues.push({ field: `providers[${index}].providerKey`, issue: 'provider has no metadata entry' });
      }
    });
    if (issues.length > 0) {
      throw validationError(issues);
    }
    const updated: PutAiProvidersData['updated'] = [];
    for (const entry of entries) {
      const existing = await tx.getSecret(SECRET_KIND_AI_PROVIDER, entry.providerKey);
      let existingBundle = {};
      if (existing !== null) {
        const opened = await deps.cipher.open({
          ciphertext: existing.ciphertext,
          keyVersion: existing.keyVersion,
          nonce: existing.nonce,
        });
        existingBundle = decodeSecretBundle(opened);
      }
      const merged = mergeSecretBundle(existingBundle, entry.patch as Record<string, unknown>);
      if (isEmptySecretBundle(merged)) {
        if (existing !== null) {
          await tx.deleteSecret(SECRET_KIND_AI_PROVIDER, entry.providerKey);
          await tx.recordAudit('secret_deleted', 'secret', entry.providerKey, ipHash, nowMs);
        }
        updated.push({ hasApiKey: false, providerKey: entry.providerKey, updatedAt: nowMs });
        continue;
      }
      const sealed = await deps.cipher.seal(encodeSecretBundle(merged));
      await tx.putSecret({
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        kind: SECRET_KIND_AI_PROVIDER,
        nonce: sealed.nonce,
        ref: entry.providerKey,
        updatedAtMs: nowMs,
      });
      const action =
        existing === null ? 'secret_created' : sealed.keyVersion !== existing.keyVersion ? 'secret_rotated' : 'secret_updated';
      await tx.recordAudit(action, 'secret', entry.providerKey, ipHash, nowMs);
      updated.push({ hasApiKey: bundleHasApiKey(merged), providerKey: entry.providerKey, updatedAt: nowMs });
    }
    const data: PutAiProvidersData = { updated };
    await storeIdempotentResponse(tx, SECRETS_PUT_IDEMPOTENCY_SCOPE, idempotencyKey, requestHash, data, nowMs);
    return data;
  });
}

export async function deleteAiProvider(
  deps: SettingsServiceDeps,
  userId: string,
  providerKey: string,
  ipHash: string,
): Promise<DeleteAiProviderData> {
  const nowMs = clock(deps);
  return deps.store.transact(userId, async (tx) => {
    const stored = await tx.getSettings(['aiModelList']);
    if (!metadataKeysOf(stored).has(providerKey)) {
      throw ApiError.notFound('Resource not found.');
    }
    const deleted = await tx.deleteSecret(SECRET_KIND_AI_PROVIDER, providerKey);
    if (deleted) {
      await tx.recordAudit('secret_deleted', 'secret', providerKey, ipHash, nowMs);
    }
    return { deleted, hasApiKey: false, providerKey };
  });
}
