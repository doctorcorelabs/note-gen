// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Secret encryption seam (V3-10a). This file defines the INTERFACE the
// settings and secrets services use. It contains NO cryptography.
//
// The envelope implementation belongs to V3-10b
// (server/src/lib/crypto/*, branch web-settings-crypto): envelope
// AES-256-GCM over node:crypto, per desain-store-adapter.md section
// 4.3 and AD-16. That branch has landed (CryptoService, KeyRing,
// SealedParts, branch web-settings-crypto tip 623084fa); it is NOT
// imported here, because this branch must stay buildable on its own
// until the integrator merges the two branches. The adapter already
// exists on that branch: CryptoServiceSecretCipher (plus the
// createSecretCipherFromEnv factory) in
// server/src/lib/crypto/secret-cipher.ts, structurally assignable to
// SecretCipher below. Only that adapter may import
// server/src/lib/crypto/*. Adapter mapping, verified by reading the
// V3-10b branch as pushed:
// - seal(plaintext): CryptoService.encrypt(plaintext) returns
//   SealedParts { formatVersion, keyVersion, nonce, ciphertext };
//   the adapter keeps { ciphertext, nonce, keyVersion }. The format
//   version travels inside the ciphertext bytes (first byte, always
//   1); the adapter validates that byte on open. No SealOptions/AAD:
//   the settings service binds no caller AAD, and the adapter passes
//   none on seal or open, or sealed rows become unreadable.
// - open(sealed): rebuild SealedParts with formatVersion set to
//   ENVELOPE_FORMAT_VERSION, then CryptoService.decrypt(parts).
// - keyVersion: CryptoService.currentKeyVersion.
// - construction: createSecretCipherFromEnv(env), which reads
//   ENCRYPTION_KEY (canonical). The SECRETS_ENCRYPTION_KEY name is
//   accepted as a legacy fallback only when ENCRYPTION_KEY is
//   absent; when both names are set to different keys the factory
//   throws. When no key is present the factory throws; the
//   production wiring must then keep unavailableSecretCipher
//   (writes fail closed with 503, status reads still work) instead
//   of starting a server that pretends to seal secrets.
// TODO (integrator, tested at merge): no adapter code remains to be
// written. Supply the existing adapter instance in place of
// unavailableSecretCipher in createProductionSettingsDeps, and run
// the settings/secrets specs plus the Postgres spec against the
// real cipher with a test ENCRYPTION_KEY, asserting that a secret
// sealed by the adapter opens through a fresh service and that no
// response carries the test value. Until that wiring lands, this
// seam is written against the V3-10b interface as documented above,
// and services never import a crypto module directly.
//
// Contract of the seam, matching the secrets table columns
// (server/src/db/schema/m1-foundation.ts):
// - seal(plaintext) returns opaque ciphertext bytes, a fresh random
//   nonce per value, and the keyVersion of the wrapping key used.
// - open(sealed) recovers the plaintext for any keyVersion the
//   implementation still knows (old versions must stay readable
//   across rotation; writes always use the current version).
// - keyVersion is the current wrapping-key version. Rotation is
//   recorded per row (secrets.key_version) and in the audit trail
//   (action secret_rotated when a rewrite changes the version).
// - Plaintext secret values exist only in memory inside the service
//   call that seals or opens them. They are never logged, never put
//   in an error message or response, and never stored anywhere
//   except as sealed bytes in the secrets table (AD-16).
//
// Until a real cipher is wired, routes use unavailableSecretCipher:
// secret reads that need no decryption (status) still work, while
// secret writes fail closed with 503 service_unavailable instead of
// storing anything unsealed or pretending to succeed.

import { ApiError } from '../../plugins/envelope.js';

export const SECRET_KIND_AI_PROVIDER = 'ai_provider';

// One sealed secret value, shaped exactly like the secrets table row
// payload: ciphertext + nonce + key version. No plaintext column
// exists anywhere in this shape.
export interface SealedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

export interface SecretCipher {
  // Current wrapping-key version. Writes seal under this version.
  readonly keyVersion: number;
  seal(plaintext: Uint8Array): Promise<SealedSecret>;
  open(sealed: SealedSecret): Promise<Uint8Array>;
}

// Fail-closed placeholder used until V3-10b lands. Any attempt to
// seal or open answers 503; nothing is stored and nothing is faked.
export const unavailableSecretCipher: SecretCipher = {
  keyVersion: 0,
  async seal(): Promise<SealedSecret> {
    throw ApiError.serviceUnavailable('Secret encryption is not configured.');
  },
  async open(): Promise<Uint8Array> {
    throw ApiError.serviceUnavailable('Secret encryption is not configured.');
  },
};

// Credential-carrying fields of one AiConfig entry, per
// desain-store-adapter.md section 2.7. These fields live ONLY in the
// sealed bundle; they must never appear in the settings table, in a
// GET response, or in a log. Every other AiConfig field is metadata.
export const SECRET_BUNDLE_FIELDS: readonly string[] = [
  'apiKey',
  'webSearchApiKey',
  'webSearchApiKeys',
  'customHeaders',
];

export type SecretBundleField = (typeof SECRET_BUNDLE_FIELDS)[number];

export function isSecretBundleField(field: string): field is SecretBundleField {
  return (SECRET_BUNDLE_FIELDS as readonly string[]).includes(field);
}

// The sealed bundle for one provider: the credential fields of one
// AiConfig entry, stored as one secrets row (kind ai_provider,
// ref = provider key). Absent field means the provider has no value
// for it; an empty bundle means the row must not exist.
export interface AiProviderSecretBundle {
  apiKey?: string;
  webSearchApiKey?: string;
  webSearchApiKeys?: Record<string, string>;
  customHeaders?: Record<string, string>;
}

export function isEmptySecretBundle(bundle: AiProviderSecretBundle): boolean {
  return (
    bundle.apiKey === undefined &&
    bundle.webSearchApiKey === undefined &&
    bundle.webSearchApiKeys === undefined &&
    bundle.customHeaders === undefined
  );
}

// Field-presence helper: true only when the bundle holds a
// non-empty apiKey field. This is NOT the response semantics for
// hasApiKey: both PUT and GET answer hasApiKey from sealed-row
// existence (desain-store-adapter.md section 4.3 rule 5), so a
// bundle holding only a web-search key still answers true. Do not
// use this helper to build a response; it exists for bundle
// inspection by callers that need field presence, not existence.
export function bundleHasApiKey(bundle: AiProviderSecretBundle): boolean {
  return typeof bundle.apiKey === 'string' && bundle.apiKey !== '';
}

// Merge a validated PUT patch into an existing bundle. A field present
// in the patch replaces the stored value; a field present with null
// deletes it from the bundle; a field absent from the patch is left
// untouched (kontrak-api-kanonis.md section 3.3). The patch object
// must already be validated; this function only applies presence
// semantics and never inspects values beyond copying them.
export function mergeSecretBundle(
  existing: AiProviderSecretBundle,
  patch: Record<string, unknown>,
): AiProviderSecretBundle {
  const merged: AiProviderSecretBundle = { ...existing };
  for (const field of SECRET_BUNDLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) {
      continue;
    }
    const value = patch[field];
    if (value === null) {
      delete (merged as Record<string, unknown>)[field];
    } else {
      (merged as Record<string, unknown>)[field] = value;
    }
  }
  return merged;
}

// Serialize a bundle to bytes for sealing. JSON only; the result is
// handed straight to the cipher and never logged.
export function encodeSecretBundle(bundle: AiProviderSecretBundle): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(bundle));
}

// Parse sealed-then-opened bytes back into a bundle. Anything that is
// not a plain JSON object with only known bundle fields is a corrupt
// bundle and fails closed with a generic error (no content in the
// message, no partial bundle returned).
export function decodeSecretBundle(bytes: Uint8Array): AiProviderSecretBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw ApiError.internalError('A stored secret could not be read.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw ApiError.internalError('A stored secret could not be read.');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!isSecretBundleField(key)) {
      throw ApiError.internalError('A stored secret could not be read.');
    }
  }
  return record as AiProviderSecretBundle;
}

// True when a provider metadata entry carries any credential field.
// Used by the settings service to reject aiModelList writes that smuggle
// secret fields through PATCH /api/settings (reason secret_only).
export function providerEntryHasSecretFields(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return false;
  }
  const record = entry as Record<string, unknown>;
  if (SECRET_BUNDLE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(record, field))) {
    return true;
  }
  // Model entries inside a provider must not carry credential fields
  // either (desain-store-adapter.md assumption A-04 / CT-08).
  const models = record.models;
  if (Array.isArray(models)) {
    for (const model of models) {
      if (
        typeof model === 'object' &&
        model !== null &&
        !Array.isArray(model) &&
        SECRET_BUNDLE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(model, field))
      ) {
        return true;
      }
    }
  }
  return false;
}

// Defense in depth for reads: strip credential fields from a stored
// provider entry before it leaves the server. Stored metadata must
// already be clean (writes reject secret fields), so any field found
// here indicates a legacy or corrupt row; it is dropped, never
// returned. Computed fields (hasApiKey, updatedAt) are also dropped
// here and re-added from the secrets table by the caller.
export function toProviderMetadata(entry: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (isSecretBundleField(key) || key === 'hasApiKey' || key === 'updatedAt') {
      continue;
    }
    metadata[key] = value;
  }
  return metadata;
}
