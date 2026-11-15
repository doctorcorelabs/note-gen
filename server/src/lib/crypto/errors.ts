// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Typed errors for the server-side envelope encryption module.
//
// Error messages name the failure only. They never carry key material,
// plaintext, ciphertext, or any other secret value, so they are safe to
// surface in logs and generic error envelopes.

export type CryptoErrorCode =
  | 'ENCRYPTION_KEY_MISSING'
  | 'ENCRYPTION_KEY_INVALID'
  | 'KEY_VERSION_UNKNOWN'
  | 'ENVELOPE_MALFORMED'
  | 'ENVELOPE_UNSUPPORTED_VERSION'
  | 'DECRYPTION_FAILED';

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
  }
}

export function missingKeyError(): CryptoError {
  return new CryptoError(
    'ENCRYPTION_KEY_MISSING',
    'ENCRYPTION_KEY is not set; sealed secrets cannot be handled until it is set.',
  );
}

export function invalidKeyError(detail: string): CryptoError {
  return new CryptoError(
    'ENCRYPTION_KEY_INVALID',
    `ENCRYPTION_KEY configuration is invalid: ${detail}.`,
  );
}

export function unknownKeyVersionError(): CryptoError {
  return new CryptoError(
    'KEY_VERSION_UNKNOWN',
    'No key is configured for the key version recorded on the sealed data.',
  );
}

export function malformedEnvelopeError(): CryptoError {
  return new CryptoError(
    'ENVELOPE_MALFORMED',
    'Sealed data is malformed and cannot be opened.',
  );
}

export function unsupportedVersionError(): CryptoError {
  return new CryptoError(
    'ENVELOPE_UNSUPPORTED_VERSION',
    'Sealed data uses an envelope format version this build cannot open.',
  );
}

export function decryptionFailedError(): CryptoError {
  // Deliberately generic: tampering and a wrong key are indistinguishable
  // by design, and the distinction must not leak through the message.
  return new CryptoError(
    'DECRYPTION_FAILED',
    'Sealed data failed authentication; it may be tampered with or sealed under a different key.',
  );
}
