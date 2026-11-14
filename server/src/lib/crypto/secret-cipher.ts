// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Adapter: CryptoService behind the SecretCipher seam shape used by
// the settings and secrets services (V3-10a).
//
// The seam interface itself is defined by V3-10a in
// server/src/services/settings/crypto-seam.ts (branch
// web-settings-backend): an async seal/open pair over the secrets
// table payload shape (ciphertext + nonce + keyVersion), plus a
// keyVersion getter. This adapter implements exactly that shape, so
// a CryptoServiceSecretCipher instance is assignable to V3-10a's
// SecretCipher without any change on either side; the structural
// match is pinned by a mirror-type test in
// server/test/secret-cipher.spec.ts. The services never import this
// module directly: the integrator (or V3-10aR) supplies an instance
// as the cipher dep when registering the routes, replacing
// unavailableSecretCipher. Wiring:
//
//   const service = createCryptoServiceFromEnv(process.env);
//   const cipher = new CryptoServiceSecretCipher(service);
//   const deps = { cipher, store: createProductionSettingsStore() };
//   await registerSettingsRoutes(app, deps);
//   await registerSecretsRoutes(app, deps);
//
// Keep the CryptoService reference when a rotation sweep is needed
// (needsRotation/rotateParts live there); the factory below is for
// wiring-only consumers. Behaviour notes for the consumer:
// - No caller AAD is used: the seam carries no AAD, so values sealed
//   through this adapter open without AAD. Do not mix them with
//   values sealed through CryptoService with a caller AAD.
// - seal() returns only the three table columns. The envelope
//   format version travels inside the ciphertext bytes (first byte)
//   and is validated on open; a tampered version byte fails with
//   ENVELOPE_UNSUPPORTED_VERSION, tampered ciphertext, tag, or
//   nonce fails with DECRYPTION_FAILED, and an unrecorded key
//   version fails with KEY_VERSION_UNKNOWN. All failures throw
//   CryptoError, whose messages never carry secret material; the
//   global error handler turns an unexpected CryptoError into a
//   generic 500 internal_error envelope.
// - keyVersion reports the current wrapping-key version. Writes
//   always seal under it; older rows stay readable while their key
//   remains in the ring (ENCRYPTION_PREVIOUS_KEYS).

import {
  CryptoService,
  ENVELOPE_FORMAT_VERSION,
  createCryptoServiceFromEnv,
} from './envelope.js';
import {
  malformedEnvelopeError,
  unsupportedVersionError,
} from './errors.js';
import type { KeyRingEnv } from './key-ring.js';

/**
 * One sealed value in the shape of the secrets table row payload.
 * The field names and types mirror V3-10a's SealedSecret exactly,
 * so an adapter result can be stored by the services unchanged and
 * a stored row can be opened by the adapter unchanged.
 */
export interface SealedSecretBytes {
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

export class CryptoServiceSecretCipher {
  private readonly cryptoService: CryptoService;

  constructor(cryptoService: CryptoService) {
    this.cryptoService = cryptoService;
  }

  /** Current wrapping-key version. Writes seal under this version. */
  get keyVersion(): number {
    return this.cryptoService.currentKeyVersion;
  }

  /** Seal bytes with the current key, in secrets-table payload shape. */
  async seal(plaintext: Uint8Array): Promise<SealedSecretBytes> {
    const parts = this.cryptoService.encrypt(Buffer.from(plaintext));
    return {
      ciphertext: parts.ciphertext,
      nonce: parts.nonce,
      keyVersion: parts.keyVersion,
    };
  }

  /** Open a secrets-table payload, selecting the key by its recorded version. */
  async open(sealed: SealedSecretBytes): Promise<Uint8Array> {
    if (sealed === null || typeof sealed !== 'object') {
      throw malformedEnvelopeError();
    }
    if (!Buffer.isBuffer(sealed.ciphertext) || sealed.ciphertext.length < 1 || !Buffer.isBuffer(sealed.nonce)) {
      throw malformedEnvelopeError();
    }
    if (sealed.ciphertext[0] !== ENVELOPE_FORMAT_VERSION) {
      throw unsupportedVersionError();
    }
    return this.cryptoService.decrypt({
      formatVersion: ENVELOPE_FORMAT_VERSION,
      keyVersion: sealed.keyVersion,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
    });
  }
}

/** Build an adapter directly from environment variables. */
export function createSecretCipherFromEnv(env: KeyRingEnv): CryptoServiceSecretCipher {
  return new CryptoServiceSecretCipher(createCryptoServiceFromEnv(env));
}
