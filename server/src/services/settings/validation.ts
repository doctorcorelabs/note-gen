// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Request validation for the settings and secrets routes (V3-10a).
//
// Rules enforced here come from kontrak-api-kanonis.md:
// - Section 1.5: unknown fields in a JSON body are rejected with 400
//   validation_failed and details.fields naming the rejected fields.
// - Section 1.6: the canonical idempotency header is Idempotency-Key
//   (no X- prefix, no alias), opaque, max 128 characters.
// - Section 3.2: PATCH requires baseRevision in the body.
// - Section 3.3: PUT ai-providers requires provider metadata to exist
//   (checked by the service, not here); body shape is checked here.
//
// Validation failures carry field names and issue labels only, never
// field values: a rejected body may contain a secret value, and the
// error response and the log must never carry it (AD-16).
//
// The SHA-256 helpers in this file are for idempotency request hashes
// and IP hashes only. They are not secret encryption; secret
// encryption is the SecretCipher seam (crypto-seam.ts, V3-10b).

import { createHash } from 'node:crypto';
import { ApiError } from '../../plugins/envelope.js';
import { SECRET_BUNDLE_FIELDS, type SecretBundleField } from './crypto-seam.js';

export interface FieldIssue {
  field: string;
  issue: string;
}

export function validationError(fields: FieldIssue[]): ApiError {
  return ApiError.validation('Request validation failed.', { fields });
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Deterministic JSON serialization: object keys sorted, arrays in
// order. Used for idempotency request hashes so the same logical body
// hashes the same regardless of key order. Throws on values JSON
// cannot represent (undefined, functions, symbols, bigint, cycles),
// which can only arrive from direct service calls, never from a
// parsed JSON body.
export function stableStringify(value: unknown): string {
  const seen = new Set<object>();
  const render = (current: unknown): string => {
    if (current === null) {
      return 'null';
    }
    if (typeof current === 'string') {
      return JSON.stringify(current);
    }
    if (typeof current === 'boolean') {
      return current ? 'true' : 'false';
    }
    if (typeof current === 'number') {
      return Number.isFinite(current) ? JSON.stringify(current) : 'null';
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) {
        throw new Error('Value is not JSON-serializable: circular reference.');
      }
      seen.add(current);
      const rendered = `[${current.map((item) => render(item)).join(',')}]`;
      seen.delete(current);
      return rendered;
    }
    if (isPlainObject(current)) {
      if (seen.has(current)) {
        throw new Error('Value is not JSON-serializable: circular reference.');
      }
      seen.add(current);
      const parts: string[] = [];
      for (const key of Object.keys(current).sort()) {
        const item = current[key];
        if (item === undefined) {
          throw new Error('Value is not JSON-serializable: undefined value.');
        }
        parts.push(`${JSON.stringify(key)}:${render(item)}`);
      }
      seen.delete(current);
      return `{${parts.join(',')}}`;
    }
    throw new Error('Value is not JSON-serializable.');
  };
  return render(value);
}

// True when a value is a finite-depth JSON value (null, boolean,
// string, finite number, array, plain object), with no cycles. Used
// to reject invalid_value settings writes fail-closed.
export function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) {
    return false;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    return Object.values(value).every((item) => isJsonValue(item, depth + 1));
  }
  return false;
}

// SHA-256 hex digest of a UTF-8 string. Used for idempotency request
// hashes (of the canonical request) and for IP hashes in audit rows.
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Hash of the canonical request for idempotency comparison: method,
// path, and body. The body itself is never stored, only its hash, so
// a stored idempotency record can never leak a secret value.
export function idempotencyRequestHash(method: string, path: string, body: unknown): string {
  return sha256Hex(stableStringify({ body, method, path }));
}

// Parse the Idempotency-Key header. Returns null when absent or
// empty. Duplicated headers and over-long keys are validation
// failures; the canonical name only is read (the route passes this
// header and no alias).
export function parseIdempotencyKey(header: string | string[] | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  if (Array.isArray(header)) {
    throw validationError([{ field: 'Idempotency-Key', issue: 'must appear at most once' }]);
  }
  const key = header.trim();
  if (key === '') {
    return null;
  }
  if (key.length > 128) {
    throw validationError([{ field: 'Idempotency-Key', issue: 'must be at most 128 characters' }]);
  }
  return key;
}

export interface PatchSettingsBody {
  settings: Record<string, unknown>;
  baseRevision: number;
}

export function parsePatchSettingsBody(body: unknown): PatchSettingsBody {
  if (!isPlainObject(body)) {
    throw validationError([{ field: 'body', issue: 'must be a JSON object' }]);
  }
  const issues: FieldIssue[] = [];
  for (const key of Object.keys(body)) {
    if (key !== 'settings' && key !== 'baseRevision') {
      issues.push({ field: key, issue: 'unknown field' });
    }
  }
  if (issues.length > 0) {
    throw validationError(issues);
  }
  if (!isPlainObject(body.settings)) {
    throw validationError([{ field: 'settings', issue: 'must be a JSON object' }]);
  }
  const baseRevision = body.baseRevision;
  if (typeof baseRevision !== 'number' || !Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw validationError([{ field: 'baseRevision', issue: 'must be a non-negative integer' }]);
  }
  return { baseRevision, settings: body.settings };
}

// Parse the ?keys= query parameter of GET /api/settings. Returns null
// for a full-document read (parameter absent or empty). Repeated
// parameters are flattened; empty entries are dropped; duplicates
// are removed keeping first-seen order.
export function parseSettingsKeysQuery(query: unknown): string[] | null {
  if (!isPlainObject(query)) {
    return null;
  }
  const raw = query.keys;
  if (raw === undefined || raw === null) {
    return null;
  }
  const values: string[] = [];
  if (typeof raw === 'string') {
    values.push(raw);
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') {
        throw validationError([{ field: 'keys', issue: 'must be a comma-separated string' }]);
      }
      values.push(item);
    }
  } else {
    throw validationError([{ field: 'keys', issue: 'must be a comma-separated string' }]);
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const part of value.split(',')) {
      const key = part.trim();
      if (key === '' || seen.has(key)) {
        continue;
      }
      seen.add(key);
      keys.push(key);
    }
  }
  return keys.length === 0 ? null : keys;
}

export interface PutAiProviderEntry {
  providerKey: string;
  // Present secret fields only, with null meaning delete-from-bundle.
  // Absent fields are absent from this record (leave untouched).
  patch: Partial<Record<SecretBundleField, unknown>>;
}

const PUT_PROVIDER_FIELDS: readonly string[] = ['providerKey', ...SECRET_BUNDLE_FIELDS];
const MAX_PROVIDERS_PER_REQUEST = 100;
const MAX_PROVIDER_KEY_LENGTH = 128;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function validateStringMap(
  value: unknown,
  field: string,
  issues: FieldIssue[],
  allowEmptyValues: boolean,
): Record<string, string> | null {
  if (!isPlainObject(value)) {
    issues.push({ field, issue: 'must be a JSON object' });
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === '' || /[\s:]/.test(key)) {
      issues.push({ field, issue: 'keys must be non-empty without whitespace or colon' });
      return null;
    }
    if (typeof entry !== 'string' || (!allowEmptyValues && entry === '')) {
      issues.push({ field, issue: 'values must be non-empty strings' });
      return null;
    }
  }
  return value as Record<string, string>;
}

export function parsePutAiProvidersBody(body: unknown): PutAiProviderEntry[] {
  if (!isPlainObject(body)) {
    throw validationError([{ field: 'body', issue: 'must be a JSON object' }]);
  }
  for (const key of Object.keys(body)) {
    if (key !== 'providers') {
      throw validationError([{ field: key, issue: 'unknown field' }]);
    }
  }
  const providers = body.providers;
  if (!Array.isArray(providers) || providers.length === 0) {
    throw validationError([{ field: 'providers', issue: 'must be a non-empty array' }]);
  }
  if (providers.length > MAX_PROVIDERS_PER_REQUEST) {
    throw validationError([{ field: 'providers', issue: 'must contain at most 100 entries' }]);
  }
  const seenKeys = new Set<string>();
  const entries: PutAiProviderEntry[] = [];
  for (let index = 0; index < providers.length; index += 1) {
    const prefix = `providers[${index}]`;
    const provider = providers[index];
    if (!isPlainObject(provider)) {
      throw validationError([{ field: prefix, issue: 'must be a JSON object' }]);
    }
    const issues: FieldIssue[] = [];
    for (const key of Object.keys(provider)) {
      if (!(PUT_PROVIDER_FIELDS as readonly string[]).includes(key)) {
        issues.push({ field: `${prefix}.${key}`, issue: 'unknown field' });
      }
    }
    const providerKey = provider.providerKey;
    if (
      !isNonEmptyString(providerKey) ||
      providerKey.length > MAX_PROVIDER_KEY_LENGTH ||
      providerKey.trim() !== providerKey
    ) {
      issues.push({ field: `${prefix}.providerKey`, issue: 'must be a non-empty string up to 128 characters' });
    } else if (seenKeys.has(providerKey)) {
      issues.push({ field: `${prefix}.providerKey`, issue: 'must be unique within the request' });
    } else {
      seenKeys.add(providerKey);
    }
    const patch: Partial<Record<SecretBundleField, unknown>> = {};
    let hasSecretField = false;
    for (const field of SECRET_BUNDLE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(provider, field)) {
        continue;
      }
      hasSecretField = true;
      const value = provider[field];
      if (value === null) {
        patch[field as SecretBundleField] = null;
        continue;
      }
      if (field === 'apiKey' || field === 'webSearchApiKey') {
        if (!isNonEmptyString(value)) {
          issues.push({ field: `${prefix}.${field}`, issue: 'must be a non-empty string or null' });
        } else {
          patch[field as SecretBundleField] = value;
        }
      } else if (field === 'webSearchApiKeys') {
        const map = validateStringMap(value, `${prefix}.${field}`, issues, false);
        if (map !== null) {
          patch[field as SecretBundleField] = map;
        }
      } else {
        const map = validateStringMap(value, `${prefix}.${field}`, issues, true);
        if (map !== null) {
          patch[field as SecretBundleField] = map;
        }
      }
    }
    if (!hasSecretField) {
      issues.push({ field: prefix, issue: 'must include at least one secret field' });
    }
    if (issues.length > 0) {
      throw validationError(issues);
    }
    entries.push({ patch, providerKey: providerKey as string });
  }
  return entries;
}
